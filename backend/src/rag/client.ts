import {randomUUID} from 'node:crypto';
import {ApiError} from '../http/errors.js';
export const embeddingModel='synthetic-hash-32-v1',chunkerVersion='lc-recursive-600-80-v1';
export const insufficient='The available health records do not contain enough information to answer this question.';
export const ragUnavailable=()=>new ApiError(503,'RAG_UNAVAILABLE','Record questions are temporarily unavailable.');
export function validateVector(v:unknown):number[]{
 if(!Array.isArray(v)||v.length!==32||v.some(x=>typeof x!=='number'||!Number.isFinite(x)||Math.abs(x)>1)||!v.some(x=>x!==0))throw ragUnavailable();return v;
}
export function createRagClient(config:{provider:string;url:string;token:string}){
 const url=new URL(config.url);
 if(config.provider!=='synthetic-offline'||url.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(url.hostname)||url.pathname!=='/internal/v1/rag/'||url.search||url.hash||url.username||url.password||!/^[a-f0-9]{64}$/.test(config.token))throw Error('Invalid private RAG configuration.');
 return {async call(operation:'chunks'|'embedding'|'answers',body:Record<string,unknown>,signal?:AbortSignal){
  const requestId=randomUUID();
  try{
   const response=await fetch(new URL(operation,url),{method:'POST',redirect:'error',headers:{Authorization:'Bearer '+config.token,'Content-Type':'application/json'},body:JSON.stringify({schema_version:1,request_id:requestId,...body}),signal:AbortSignal.any([AbortSignal.timeout(10000),...(signal?[signal]:[])])});
   const reader=response.body?.getReader();let size=0;const parts:Uint8Array[]=[];
   try{if(reader)while(true){const p=await reader.read();if(p.done)break;size+=p.value.length;if(size>524288)throw Error();parts.push(p.value);}}finally{await reader?.cancel().catch(()=>{});}
   const value=JSON.parse(Buffer.concat(parts).toString());
   if(!response.ok||value.schema_version!==1||value.request_id!==requestId)throw Error();
   if(operation!=='answers'&&(value.model?.key!==embeddingModel||value.model?.provider!=='local-synthetic'||value.model?.model!=='hash-token'||value.model?.revision!=='1'||value.model?.dimensions!==32))throw Error();
   return value;
  }catch{throw ragUnavailable();}
 }};
}
