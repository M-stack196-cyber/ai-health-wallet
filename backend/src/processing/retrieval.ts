import {chmod,mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import type {DocumentConfig} from "../config/documents.js";
import {verifyIntegrity} from "../documents/integrity.js";
import {InvalidStoredOriginal,type OriginalStorage} from "../documents/original-reader.js";
import {validStorageReference} from "../documents/storage-safety.js";
import type {FileType} from "../documents/validation.js";
import type {RetrievalConfig} from "./config.js";
import {InvalidProcessingClaim,OriginalUnavailable,ProcessorFailure} from "./errors.js";
import type {Claim} from "./repository.js";
import type {createProcessingService} from "./service.js";

export interface OriginalInput {
  readonly path:string; readonly type:FileType; readonly bytes:number;
  assertActive():Promise<void>;
}
// Keep the original four-field input contract; cancellation capabilities are internal.
const scopes=new WeakMap<OriginalInput,{signal:AbortSignal;waitForCleanup(work:Promise<unknown>):void}>();
export function getOriginalScope(input:OriginalInput){return scopes.get(input);}
export interface OriginalAccess {
  withOriginal<T>(claim:Claim,signal:AbortSignal,use:(input:OriginalInput)=>Promise<T>):Promise<T>;
}
function cancelled<T>(work:Promise<T>,signal:AbortSignal):Promise<T>{
  return new Promise((resolve,reject)=>{
    const abort=()=>{signal.removeEventListener("abort",abort);reject(signal.reason);};
    signal.addEventListener("abort",abort,{once:true});
    work.then(value=>{signal.removeEventListener("abort",abort);if(signal.aborted)reject(signal.reason);else resolve(value);},error=>{signal.removeEventListener("abort",abort);reject(error);});
    if(signal.aborted)abort();
  });
}

export function createOriginalAccess(service:ReturnType<typeof createProcessingService>,storage:OriginalStorage|null,documents:DocumentConfig,config:RetrievalConfig):OriginalAccess{
  let active=0;
  return {
    async withOriginal(claim,externalSignal,use){
      if(!storage||active>=config.maxConcurrentRetrievals)throw new OriginalUnavailable();
      if(externalSignal.aborted)throw new ProcessorFailure("INTERRUPTED");
      active++;
      const controller=new AbortController();
      const signal=AbortSignal.any([externalSignal,controller.signal]);
      const deadline=setTimeout(()=>controller.abort(new ProcessorFailure("PROCESSOR_TIMEOUT")),config.downloadTimeoutMs);
      let directory:string|undefined;
      let timer:ReturnType<typeof setTimeout>|undefined;
      let monitor:Promise<void>|undefined;
      let stopped=false;
      const cleanups:Promise<unknown>[]=[];
      try{
        const reference=await service.resolveOriginal(claim);
        if(!validStorageReference(storage,reference.s3_bucket,reference.s3_object_key)
          ||!["pdf","jpg","jpeg","png"].includes(reference.file_type)
          ||!reference.s3_object_key.endsWith("."+reference.file_type))throw new ProcessorFailure("INVALID_INPUT",false);
        const assertActive=async()=>{
          signal.throwIfAborted();
          const current=await service.resolveOriginal(claim);
          if(current.s3_bucket!==reference.s3_bucket||current.s3_object_key!==reference.s3_object_key||current.file_type!==reference.file_type)throw new InvalidProcessingClaim();
          signal.throwIfAborted();
        };
        const check=async()=>{
          try{await assertActive();}
          catch(error){controller.abort(error);return;}
          if(!stopped&&!signal.aborted)timer=setTimeout(()=>{monitor=check();},config.leaseCheckIntervalMs);
        };
        timer=setTimeout(()=>{monitor=check();},config.leaseCheckIntervalMs);
        directory=await mkdtemp(join(tmpdir(),"health-wallet-processing-"));
        await chmod(directory,0o700);
        signal.throwIfAborted();
        const path=join(directory,"original.bin");
        const receipt=await storage.readOriginal({key:reference.s3_object_key,type:reference.file_type,
          destination:path,maxBytes:config.maxDownloadBytes,timeoutMs:config.downloadTimeoutMs,signal});
        // Reuse existing bounded content validation. No OCR or text extraction.
        try{await verifyIntegrity({path,type:reference.file_type},documents,signal);}
        catch{signal.throwIfAborted();throw new ProcessorFailure("INVALID_INPUT",false);}
        await assertActive();
        clearTimeout(deadline); // Input acquisition is bounded; the existing worker bounds consumer execution.
        return await cancelled(Promise.resolve().then(()=>{
          signal.throwIfAborted();
          const input=Object.freeze({path,type:reference.file_type,bytes:receipt.bytes,assertActive});
          scopes.set(input,{signal,waitForCleanup:(work:Promise<unknown>)=>{cleanups.push(work);}});
          return use(input);
        }),signal);
      }catch(error){
        if(signal.aborted){
          if(signal.reason instanceof InvalidProcessingClaim||signal.reason instanceof ProcessorFailure)throw signal.reason;
          throw new ProcessorFailure("INTERRUPTED");
        }
        if(error instanceof InvalidProcessingClaim||error instanceof ProcessorFailure)throw error;
        if(error instanceof InvalidStoredOriginal)throw new ProcessorFailure("INVALID_INPUT",false);
        throw new OriginalUnavailable();
      }finally{
        stopped=true;clearTimeout(deadline);if(timer)clearTimeout(timer);
        controller.abort();
        try{await Promise.allSettled(cleanups);if(monitor)await monitor;if(directory)await rm(directory,{recursive:true,force:true});}
        catch{throw new OriginalUnavailable();}
        finally{active--;}
      }
    },
  };
}
