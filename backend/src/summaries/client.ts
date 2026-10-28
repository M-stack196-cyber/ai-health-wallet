import {createHash} from 'node:crypto';
import {canonicalSummaryJson, parseSummaryJson, validateSummaryInput, validateSummaryOutput, renderSummary, summaryLimits} from './validation.js';
import type {SummaryValidationContext, SummaryProvenanceV1, SummaryOutputV1} from './contracts.js';

export const summaryServicePath = '/internal/v1/report-summaries:generate';
export function fakeSummaryRecipe(inputSha256: string): SummaryProvenanceV1 {
  return {schema_version:1, input_sha256:inputSha256, pipeline_version:'summary-contract-v1',
    prompt_sha256:createHash('sha256').update('health-wallet-summary-fake-extractive-v1').digest('hex'),
    provider:'synthetic-fake', model_id:'extractive-fixture', model_revision:'1'};
}
export interface SummaryTransportRequest {
  method:'POST'; path:typeof summaryServicePath; headers:Readonly<Record<string,string>>;
  body:Uint8Array; signal:AbortSignal; maxResponseBytes:number;
}
// No fetch, base URL, DNS, retry or default HTTP implementation exists in this stage.
export type SummaryTransport = (request:SummaryTransportRequest)=>Promise<{
  status:number; body:AsyncIterable<Uint8Array>;
}>;
export interface SummaryClientConfig {enabled?:boolean; token?:string; timeoutMs?:number; concurrency?:number;}
export type SummaryClientFailure = 'CLIENT_DISABLED'|'INVALID_CLIENT_CONFIG'|'INVALID_REQUEST'|'BUSY'|'CANCELLED'|'DEADLINE_EXCEEDED'|'REMOTE_FAILURE'|'INVALID_RESPONSE';
export class SummaryClientError extends Error {
  constructor(readonly code:SummaryClientFailure,readonly retryable:boolean=code==='BUSY'||code==='DEADLINE_EXCEEDED'){super('Summary client refused: '+code);this.name='SummaryClientError';}
}
export function createSummaryClient(config:SummaryClientConfig={}, transport?:SummaryTransport) {
  const {enabled=false,token,timeoutMs=2000,concurrency=1}=config;
  if(Object.keys(config).some(k=>!['enabled','token','timeoutMs','concurrency'].includes(k))||typeof enabled!=='boolean'||!Number.isSafeInteger(timeoutMs)||timeoutMs<10||timeoutMs>10000||!Number.isSafeInteger(concurrency)||concurrency<1||concurrency>4||(enabled&&(!token||!/^[0-9a-f]{64}$/.test(token)||typeof transport!=='function')))
    throw new SummaryClientError('INVALID_CLIENT_CONFIG');
  let active=0;
  return Object.freeze({get activeRequests(){return active;},async generate(source:unknown, context:SummaryValidationContext, signal?:AbortSignal):Promise<SummaryOutputV1>{
    if(!enabled)throw new SummaryClientError('CLIENT_DISABLED');
    if(signal?.aborted)throw new SummaryClientError('CANCELLED');
    if(active>=concurrency)throw new SummaryClientError('BUSY');
    let snapshot, authority:SummaryValidationContext;
    try {
      authority=JSON.parse(canonicalSummaryJson(context));
      if(Object.keys(authority).sort().join(',')!=='input_sha256,request_id,scope_token,source_ref')throw new Error();
      snapshot=validateSummaryInput(source,authority);
    }catch{throw new SummaryClientError('INVALID_REQUEST');}
    const recipe=fakeSummaryRecipe(authority.input_sha256), expected=JSON.parse(canonicalSummaryJson(snapshot));
    const body=Buffer.from(canonicalSummaryJson(snapshot));
    const headers=Object.freeze({'authorization':'Bearer '+token,'content-type':'application/json',
      'x-summary-request-id':authority.request_id,'x-summary-source-ref':authority.source_ref,
      'x-summary-scope-token':authority.scope_token,'x-summary-input-sha256':authority.input_sha256});
    const controller=new AbortController();
    const end=performance.now()+timeoutMs;
    let timer:ReturnType<typeof setTimeout>|undefined;
    let abort:()=>void=()=>{};
    const stopped=new Promise<never>((_resolve,reject)=>{
      abort=()=>{controller.abort();reject(new SummaryClientError('CANCELLED'));};
      signal?.addEventListener('abort',abort,{once:true});
      timer=setTimeout(()=>{controller.abort();reject(new SummaryClientError('DEADLINE_EXCEEDED'));},timeoutMs);
    });
    active++;
    // Capacity stays occupied until injected I/O exits, even after caller timeout.
    // The injected transport must honor abort and release its own buffers/resources.
    const operation=(async()=>{
      const response=await transport!({method:'POST',path:summaryServicePath,headers,body,signal:controller.signal,maxResponseBytes:summaryLimits.outputBytes});
      if(controller.signal.aborted)throw new SummaryClientError('CANCELLED');
      if(response.status!==200)throw new SummaryClientError('REMOTE_FAILURE',response.status===408||response.status===429||(response.status>=500&&response.status<=599));
      const chunks:Uint8Array[]=[];let bytes=0,parts=0;
      for await(const chunk of response.body){
        if(controller.signal.aborted)throw new SummaryClientError('CANCELLED');
        if(performance.now()>=end)throw new SummaryClientError('DEADLINE_EXCEEDED');
        if(++parts>10000)throw new SummaryClientError('INVALID_RESPONSE');
        if(!(chunk instanceof Uint8Array)||(bytes+=chunk.byteLength)>summaryLimits.outputBytes)throw new SummaryClientError('INVALID_RESPONSE');
        chunks.push(Uint8Array.from(chunk));
      }
      try{
        const value=parseSummaryJson(Buffer.concat(chunks),'output');
        const accepted=validateSummaryOutput(value,expected,authority,recipe);
        renderSummary(accepted,expected,authority,recipe);
        if(performance.now()>=end)throw new SummaryClientError('DEADLINE_EXCEEDED');
        return accepted;
      }catch(e){throw new SummaryClientError(e instanceof SummaryClientError?e.code:'INVALID_RESPONSE');}
    })();
    operation.finally(()=>{active--;}).catch(()=>{});
    try{return await Promise.race([operation,stopped]);}
    catch(error){throw new SummaryClientError(error instanceof SummaryClientError?error.code:'REMOTE_FAILURE',error instanceof SummaryClientError?error.retryable:true);}
    finally{if(timer)clearTimeout(timer);signal?.removeEventListener('abort',abort);}
  }});
}
