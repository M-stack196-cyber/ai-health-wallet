import {Router,type RequestHandler} from 'express';
import {rateLimit} from 'express-rate-limit';
import type {AuthenticationConfig} from '../config/auth.js';
import type {PatientDatabase} from '../patients/repository.js';
import {requirePatient,patientIdentity,requireJson,rejectQueryParameters} from '../auth/middleware.js';
import {createTokenService} from '../auth/tokens.js';
import {createDocumentRepository} from '../documents/repository.js';
import {documentId} from '../documents/validation.js';
import {notFound} from '../documents/service.js';
import {ApiError} from '../http/errors.js';
import {createSummaryJobRepository,SummaryJobError,type SummaryDatabase,type SummarySnapshot,type SummaryJob} from './jobs.js';
import {fakeSummaryRecipe} from './client.js';
import type {ReportedFactV1} from './contracts.js';

export interface SummaryApiOptions {
  enabled?:boolean;
  database?:SummaryDatabase;
  catalogue?:(snapshot:Readonly<SummarySnapshot>)=>ReportedFactV1[];
  requestLimit?:number;readLimit?:number;windowMs?:number;
}
const unavailable=()=>new ApiError(503,'SUMMARY_UNAVAILABLE','Medical summaries are temporarily unavailable.');
const noJob=()=>new ApiError(404,'SUMMARY_JOB_NOT_FOUND','Summary job not found.');
function summaryJobId(value:unknown){try{return documentId(value);}catch{throw noJob();}}
const noSummary=()=>new ApiError(404,'SUMMARY_NOT_FOUND','Summary not found.');
const statuses:Record<string,string>={pending:'queued',running:'processing',retry_wait:'retrying',completed:'completed',failed:'failed',cancelled:'cancelled',superseded:'superseded'};
export function publicSummaryJob(j:SummaryJob){return {id:j.id,document_id:j.document_id,status:statuses[j.state]??'failed'};}
export function publicAcceptedSummary(row:Record<string,any>){return {id:row.id,document_id:row.document_id,schema_version:1 as const,text:row.summary_text,generated_at:row.generated_at,is_current:row.is_current===true};}

export function createSummaryRoutes(documentsDatabase:PatientDatabase,auth:AuthenticationConfig,options:SummaryApiOptions={}){
  const enabled=options.enabled??false, requestLimit=options.requestLimit??5,readLimit=options.readLimit??120,windowMs=options.windowMs??60000;
  if(typeof enabled!=='boolean'||![requestLimit,readLimit,windowMs].every(Number.isSafeInteger)||requestLimit<1||requestLimit>100||readLimit<1||readLimit>1000||windowMs<100||windowMs>900000||(enabled&&(!options.database||typeof options.catalogue!=='function')))throw new Error('Invalid summary API configuration.');
  const database=options.database,catalogue=options.catalogue;
  const router=Router(),documents=createDocumentRepository(documentsDatabase);
  const authorize=requirePatient(createTokenService(auth));
  const noStore:RequestHandler=(_req,res,next)=>{res.set('Cache-Control','no-store');next();};
  const own:RequestHandler=async(req,_res,next)=>{const row=await documents.reference(documentId(req.params.id),patientIdentity(req));if(!row)throw notFound();next();};
  const noBody:RequestHandler=(req,_res,next)=>{if(req.body!==undefined||req.get('Transfer-Encoding')||Number(req.get('Content-Length')??0)>0)throw new ApiError(400,'INVALID_INPUT','A request body is not permitted.');next();};
  const empty:RequestHandler=(req,_res,next)=>{if(!req.body||typeof req.body!=='object'||Array.isArray(req.body)||Object.keys(req.body).length)throw new ApiError(400,'INVALID_INPUT','An empty JSON object is required.');next();};
  const makeLimit=(limit:number)=>rateLimit({windowMs,limit,keyGenerator:req=>patientIdentity(req),legacyHeaders:false,standardHeaders:'draft-8',validate:{xForwardedForHeader:false},
    message:{success:false,error:{code:'SUMMARY_RATE_LIMITED',message:'Too many summary requests. Try again later.'}}});
  const requestLimiter=makeLimit(requestLimit),readLimiter=makeLimit(readLimit);
  const scoped=(patient:string)=>{if(!enabled||!database)throw unavailable();return createSummaryJobRepository(database,patient);};
  const {input_sha256:_,...pipeline}=fakeSummaryRecipe('0'.repeat(64));
  async function safe<T>(fn:()=>Promise<T>){try{return await fn();}catch(e){if(e instanceof ApiError)throw e;if(e instanceof SummaryJobError&&e.code==='SOURCE_INELIGIBLE')throw new ApiError(409,'SUMMARY_SOURCE_NOT_READY','A completed, verified extraction is required.');throw unavailable();}}

  router.post('/documents/:id/summary-jobs',noStore,authorize,rejectQueryParameters,requireJson,empty,own,requestLimiter,async(req,res)=>{
    const result=await safe(async()=>{const r=scoped(patientIdentity(req));const snapshot=await r.captureSnapshot(documentId(req.params.id));
      // Catalogue authority is server-injected; no model or client builds it here.
      const facts=catalogue!(Object.freeze(structuredClone(snapshot)));
      return r.enqueueWithOutcome(snapshot.id,facts,pipeline);
    });
    res.status(result.created?202:200).json({success:true,job:publicSummaryJob(result.job),existing:!result.created});
  });
  router.get('/summary-jobs/:jobId',noStore,authorize,rejectQueryParameters,noBody,async(req,res,next)=>{
    const row=await safe(()=>scoped(patientIdentity(req)).getJob(summaryJobId(req.params.jobId)));if(!row)throw noJob();res.locals.summaryJob=row;next();
  },readLimiter,(_req,res)=>{res.status(200).json({success:true,job:publicSummaryJob(res.locals.summaryJob)});});
  router.get('/documents/:id/summary',noStore,authorize,rejectQueryParameters,noBody,own,readLimiter,async(req,res)=>{
    const rows=await safe(()=>scoped(patientIdentity(req)).summaries(documentId(req.params.id)));
    const accepted=rows.filter(r=>r.summary_contract_version===1);const row=accepted.find(r=>r.is_current===true)??accepted[0];if(!row)throw noSummary();
    res.status(200).json({success:true,summary:publicAcceptedSummary(row)});
  });
  return router;
}
