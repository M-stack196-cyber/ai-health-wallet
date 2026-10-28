import {createWriteStream} from "node:fs";
import {createHash} from "node:crypto";
import {Readable,Transform} from "node:stream";
import {pipeline} from "node:stream/promises";
import {GetObjectCommand,HeadObjectCommand,type S3Client} from "@aws-sdk/client-s3";
import type {S3StorageConfig} from "../config/documents.js";
import type {FileType} from "./validation.js";
import {StorageFailure,validStorageReference} from "./storage-safety.js";

export class InvalidStoredOriginal extends StorageFailure {}
export interface ReadOriginalInput {
  key:string; type:FileType; destination:string; maxBytes:number; timeoutMs:number; signal:AbortSignal;
}
export interface OriginalStorage {
  readonly bucket:string;
  readonly prefix:string;
  readOriginal(input:ReadOriginalInput):Promise<{bytes:number}>;
}

// Bound command waiting as well as the HTTP request. If a transport returns a
// GET body after cancellation, close it instead of leaving a live socket/body.
async function abortable<T>(work:Promise<T>,signal:AbortSignal,late?:(value:T)=>void):Promise<T>{
  return new Promise<T>((resolve,reject)=>{
    const abort=()=>{signal.removeEventListener("abort",abort);reject(new StorageFailure());};
    signal.addEventListener("abort",abort,{once:true});
    work.then(value=>{
      signal.removeEventListener("abort",abort);
      if(signal.aborted){late?.(value);reject(new StorageFailure());}else resolve(value);
    },()=>{signal.removeEventListener("abort",abort);reject(new StorageFailure());});
    if(signal.aborted)abort();
  });
}

// Constructed only by the existing S3 adapter, sharing its privacy verifier,
// fixed approved configuration, SDK client and credential/profile chain.
export function createOriginalReader(config:S3StorageConfig,client:S3Client,verifyPrivate:(signal:AbortSignal)=>Promise<void>):Pick<OriginalStorage,"readOriginal">{
  return {
    async readOriginal(input){
      if(!validStorageReference(config,config.bucket,input.key)||!input.key.endsWith("."+input.type)
        ||!["pdf","jpg","jpeg","png"].includes(input.type)
        ||!Number.isSafeInteger(input.maxBytes)||input.maxBytes<1||input.maxBytes>20971520
        ||!Number.isSafeInteger(input.timeoutMs)||input.timeoutMs<1||input.timeoutMs>30000)throw new InvalidStoredOriginal();
      const controller=new AbortController();
      const deadline=setTimeout(()=>controller.abort(),input.timeoutMs);
      const signal=AbortSignal.any([input.signal,controller.signal]);
      const scope={Bucket:config.bucket,ExpectedBucketOwner:config.ownerAccountId,Key:input.key};
      let body:Readable|undefined;
      try{
        signal.throwIfAborted();
        await abortable(verifyPrivate(signal),signal);
        const head=await abortable(client.send(new HeadObjectCommand(scope),{abortSignal:signal}),signal);
        const mime=input.type==="pdf"?"application/pdf":input.type==="png"?"image/png":"image/jpeg";
        const metadataValid=(value:{ContentLength?:number;ContentType?:string;ServerSideEncryption?:string;SSEKMSKeyId?:string})=>
          Number.isSafeInteger(value.ContentLength)&&value.ContentLength!>0&&value.ContentLength!<=input.maxBytes
          &&value.ContentType===mime&&value.ServerSideEncryption===config.encryption
          &&(config.encryption!=="aws:kms"||value.SSEKMSKeyId===config.kmsKeyId);
        if(!metadataValid(head)||(!head.VersionId&&!head.ETag))throw new InvalidStoredOriginal();
        const result=await abortable(client.send(new GetObjectCommand({...scope,VersionId:head.VersionId,
          IfMatch:head.ETag}),{abortSignal:signal}),signal,value=>{
            if(value.Body instanceof Readable)value.Body.destroy();
          });
        if(result.Body instanceof Readable)body=result.Body;
        if(!body||!metadataValid(result)||result.ContentLength!==head.ContentLength
          ||(head.VersionId&&result.VersionId!==head.VersionId)
          ||(head.ETag&&result.ETag!==head.ETag))throw new InvalidStoredOriginal();
        let bytes=0;
        const hash=createHash("sha256");
        const limiter=new Transform({transform(chunk:Buffer,_encoding,callback){
          bytes+=chunk.length;
          if(bytes>input.maxBytes||bytes>head.ContentLength!){callback(new InvalidStoredOriginal());return;}
          hash.update(chunk);callback(null,chunk);
        }});
        await pipeline(body,limiter,createWriteStream(input.destination,{flags:"wx",mode:0o600}),{signal});
        if(bytes!==head.ContentLength)throw new InvalidStoredOriginal();
        if(result.ChecksumSHA256&&result.ChecksumType!=="COMPOSITE"&&hash.digest("base64")!==result.ChecksumSHA256)throw new InvalidStoredOriginal();
        signal.throwIfAborted();
        return {bytes};
      }catch(error){
        if(error instanceof InvalidStoredOriginal)throw error;
        throw new StorageFailure();
      }finally{clearTimeout(deadline);body?.destroy();}
    },
  };
}
