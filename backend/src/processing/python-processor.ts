import {readFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import type {DocumentProcessor} from './worker.js';
import {getOriginalScope} from './retrieval.js';
import {validateExtraction,type ExtractionResult} from './extraction.js';
import {ProcessorFailure} from './errors.js';
export interface PythonEvidence {requestId:string;attempt:number;structured:Record<string,unknown>;suggested:string|null;confidence:number|null;}
export interface PythonOcrConfig {endpoint:string;token:string;timeoutMs:number;}
export function pythonOcrConfig(env:NodeJS.ProcessEnv):PythonOcrConfig{
 const endpoint=env.OCR_SERVICE_URL??'',token=env.OCR_SERVICE_TOKEN??'',timeoutMs=Number(env.OCR_SERVICE_TIMEOUT_MS??'120000');
 let url:URL;try{url=new URL(endpoint);}catch{throw Error('Private OCR service configuration required.');}
 if(url.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(url.hostname)||url.username||url.password||url.search||url.hash||url.pathname!=='/v1/extractions'
  ||!/^[a-f0-9]{64}$/.test(token)||!Number.isInteger(timeoutMs)||timeoutMs<100||timeoutMs>300000)throw Error('Invalid private OCR service configuration.');
 return {endpoint:url.toString(),token,timeoutMs};
}
function object(value:unknown,keys:string[]):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).some(k=>!keys.includes(k)))throw new ProcessorFailure('INVALID_INPUT',false);
 return value as Record<string,unknown>;
}
export function validatePythonEvidence(value:unknown):PythonEvidence{
 const p=object(value,['requestId','attempt','structured','suggested','confidence']);
 if(typeof p.requestId!=='string'||!/^[a-f0-9-]{36}$/.test(p.requestId)||!Number.isInteger(p.attempt)||Number(p.attempt)<1||Number(p.attempt)>5)throw new ProcessorFailure('INVALID_INPUT',false);
 const structured=object(p.structured,['content_trust','tools','pages','date_suggestion','category_suggestion']);
 const tools=object(structured.tools,['pillow','pdfinfo','tesseract']);
 if(Object.keys(tools).length!==3||Object.values(tools).some(v=>typeof v!=='string'||v.length<1||v.length>120))throw new ProcessorFailure('INVALID_INPUT',false);
 if(structured.content_trust!=='untrusted_document_data'||!Array.isArray(structured.pages)||!structured.pages.length||structured.pages.length>200
  ||Buffer.byteLength(JSON.stringify(structured))>4194304)throw new ProcessorFailure('INVALID_INPUT',false);
 if(p.suggested!==null&&(typeof p.suggested!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(p.suggested)||!Number.isFinite(Date.parse(p.suggested+'T00:00:00Z'))
  ||new Date(p.suggested+'T00:00:00Z').toISOString().slice(0,10)!==p.suggested||p.suggested>new Date().toISOString().slice(0,10)))throw new ProcessorFailure('INVALID_INPUT',false);
 if(p.suggested===null?p.confidence!==null:typeof p.confidence!=='number'||!Number.isFinite(p.confidence)||p.confidence<0||p.confidence>100)throw new ProcessorFailure('INVALID_INPUT',false);
 const date=structured.date_suggestion===null?null:object(structured.date_suggestion,['value','confidence']);
 if(p.suggested!==(date?.value??null)||p.confidence!==(date?.confidence??null))throw new ProcessorFailure('INVALID_INPUT',false);
 if(structured.category_suggestion!==null){const category=object(structured.category_suggestion,['value','confidence']);
  if(!['lab_report','prescription','other_medical_document'].includes(String(category.value))||typeof category.confidence!=='number'||!Number.isFinite(category.confidence)||category.confidence<0||category.confidence>100)throw new ProcessorFailure('INVALID_INPUT',false);}
 return {requestId:p.requestId,attempt:Number(p.attempt),structured,suggested:p.suggested as string|null,confidence:p.confidence as number|null};
}
export function createPythonOcrProcessor(config:PythonOcrConfig=pythonOcrConfig(process.env)):DocumentProcessor{
 // Revalidate constructor inputs too; an injected config cannot select arbitrary URLs.
 config=pythonOcrConfig({OCR_SERVICE_URL:config.endpoint,OCR_SERVICE_TOKEN:config.token,OCR_SERVICE_TIMEOUT_MS:String(config.timeoutMs)});
 return async({claim,attempt,signal,withOriginal,persistExtraction})=>{
  const result=await withOriginal(async input=>{
   await input.assertActive();
   const bytes=await readFile(input.path);if(bytes.length!==input.bytes||bytes.length>20971520)throw new ProcessorFailure('INVALID_INPUT',false);
   const digest=createHash('sha256').update(bytes).digest('hex');if(input.sha256&&input.sha256!==digest)throw new ProcessorFailure('INVALID_INPUT',false);
   const requestId=randomUUID(),scope=getOriginalScope(input);
   const combined=AbortSignal.any([signal,AbortSignal.timeout(config.timeoutMs),...(scope?[scope.signal]:[])]);
   const work=(async()=>{
    let response:Response;try{response=await fetch(config.endpoint,{method:'POST',redirect:'error',signal:combined,headers:{Authorization:'Bearer '+config.token,'Content-Type':'application/json'},
     body:JSON.stringify({schema_version:1,request_id:requestId,document_id:claim.documentId,job_id:claim.documentId,attempt,fence_token:claim.token,
      media_type:input.type==='pdf'?'application/pdf':input.type==='png'?'image/png':'image/jpeg',source_sha256:digest,content_base64:bytes.toString('base64'),mode:'native_or_ocr'})});}
    catch{throw new ProcessorFailure(combined.aborted?'PROCESSOR_TIMEOUT':'PROCESSOR_FAILED',true);}
    const reader=response.body?.getReader();let size=0;const chunks:Uint8Array[]=[];
    try{if(reader)while(true){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.length;if(size>6291456)throw new ProcessorFailure('INVALID_INPUT',false);chunks.push(chunk.value);}}
    finally{await reader?.cancel().catch(()=>{});}
    let raw:Record<string,unknown>;try{raw=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new ProcessorFailure('INVALID_INPUT',false);}
    if(!response.ok||raw.ok!==true){if(response.status===401||response.status===403)throw new ProcessorFailure('PROCESSOR_FAILED',false);const error=raw.error as {code?:string;retryable?:boolean}|undefined;throw new ProcessorFailure(error?.code==='TIMEOUT'?'PROCESSOR_TIMEOUT':error?.retryable?'PROCESSOR_FAILED':'INVALID_INPUT',error?.retryable===true);}
    const value=object(raw,['schema_version','ok','request_id','document_id','job_id','attempt','fence_token','completed_at','extraction','structured']);
    if(value.schema_version!==1||value.request_id!==requestId||value.document_id!==claim.documentId||value.job_id!==claim.documentId||value.attempt!==attempt||value.fence_token!==claim.token
     ||typeof value.completed_at!=='string'||!Number.isFinite(Date.parse(value.completed_at)))throw new ProcessorFailure('INVALID_INPUT',false);
    const extraction=value.extraction as ExtractionResult;validateExtraction(extraction);
    if(extraction.source.sha256!==digest)throw new ProcessorFailure('INVALID_INPUT',false);
    const structured=object(value.structured,['content_trust','tools','pages','date_suggestion','category_suggestion']);
    if(!Array.isArray(structured.pages)||structured.pages.length!==extraction.source.pageCount)throw new ProcessorFailure('INVALID_INPUT',false);
    let text='';let fragments=0;
    for(const [i,rawPage]of structured.pages.entries()){
     const page=object(rawPage,['page','method','text','confidence','fragments']);
     if(page.page!==i+1||page.method!==extraction.source.pages[i]?.method||typeof page.text!=='string'||!Array.isArray(page.fragments)
      ||page.confidence!==extraction.source.pages[i]?.confidence)throw new ProcessorFailure('INVALID_INPUT',false);
     text+=(i?'\n\n':'')+page.text;
     for(const rawFragment of page.fragments){const f=object(rawFragment,['text','region']);if(typeof f.text!=='string'||!f.text.trim()||!page.text.includes(f.text)
      ||(f.region!==undefined&&(!Array.isArray(f.region)||f.region.length!==4||f.region.some(n=>typeof n!=='number'||!Number.isFinite(n)||n<0||n>1))))throw new ProcessorFailure('INVALID_INPUT',false);if(++fragments>30000)throw new ProcessorFailure('INVALID_INPUT',false);}
    }
    if(text!==extraction.text)throw new ProcessorFailure('INVALID_INPUT',false);
    const suggestion=structured.date_suggestion===null?null:object(structured.date_suggestion,['value','confidence']);
    const pipeline=validatePythonEvidence({requestId,attempt,structured,suggested:suggestion?.value??null,confidence:suggestion?.confidence??null});
    await input.assertActive();combined.throwIfAborted();return {...extraction,pipeline};
   })();scope?.waitForCleanup(work);return work;
  });signal.throwIfAborted();await persistExtraction(result);
 };
}
