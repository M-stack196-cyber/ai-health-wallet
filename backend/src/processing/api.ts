import {Router} from 'express';
import {rateLimit} from 'express-rate-limit';
import type {PatientDatabase} from '../patients/repository.js';
import type {AuthenticationConfig} from '../config/auth.js';
import {createTokenService} from '../auth/tokens.js';
import {requirePatient,patientIdentity,rejectQueryParameters,rejectRequestBody,requireJson} from '../auth/middleware.js';
import {documentId} from '../documents/validation.js';
import {notFound} from '../documents/service.js';
import {ApiError} from '../http/errors.js';
import {assertCanary,verifyApproval,type BackgroundConfig} from './background-config.js';
import {createPatientProcessingRepository,type PatientProcessingState} from './api-repository.js';
export interface ProcessingApiOptions {
 retryApproval?:Pick<BackgroundConfig,'canary'|'approvalPath'|'approvalSha256'>;
 retryLimit?:number;readLimit?:number;
}
const unavailable=()=>new ApiError(503,'PROCESSING_RETRY_UNAVAILABLE','Extraction retry is temporarily unavailable.');
const retryable=(j:PatientProcessingState)=>j.state==='failed'&&j.eligible&&j.attempt_count>0&&j.attempt_count<j.max_attempts
 &&['PROCESSOR_FAILED','PROCESSOR_TIMEOUT','INTERRUPTED','LEASE_EXPIRED'].includes(j.last_error_code??'');
export function publicProcessing(j:PatientProcessingState,approved:boolean){
 const states:Record<string,string>={pending:'queued',running:'processing',retry_wait:'retrying',failed:'failed',completed:j.verified?'completed':'unavailable'};
 const failures:Record<string,string>={PROCESSOR_FAILED:'extraction_failed',PROCESSOR_TIMEOUT:'timeout',INTERRUPTED:'interrupted',INVALID_INPUT:'invalid_document',LEASE_EXPIRED:'interrupted'};
 return {document_id:j.document_id,stage:'extraction' as const,status:states[j.state]??'unavailable',
  failure_code:j.state==='failed'||j.state==='retry_wait'?failures[j.last_error_code??'']??'extraction_failed':null,
  retry_allowed:approved&&retryable(j)};
}
export function createProcessingRoutes(database:PatientDatabase,auth:AuthenticationConfig,options:ProcessingApiOptions={}){
 const approval=options.retryApproval?structuredClone(options.retryApproval):undefined;
 if(approval)assertCanary(approval.canary);
 const limit=options.retryLimit??5;if(!Number.isInteger(limit)||limit<1||limit>20)throw Error('Invalid processing API limits.');
 const readLimit=options.readLimit??120;if(!Number.isInteger(readLimit)||readLimit<1||readLimit>1000)throw Error('Invalid processing API limits.');
 const repository=createPatientProcessingRepository(database,approval?.canary),router=Router();
 const authenticate=requirePatient(createTokenService(auth));
 const noStore=(_req:unknown,res:{set(k:string,v:string):unknown},next:()=>void)=>{res.set('Cache-Control','no-store');next();};
 const limiter=rateLimit({windowMs:60000,limit,keyGenerator:req=>patientIdentity(req),standardHeaders:'draft-8',legacyHeaders:false,
  message:{success:false,error:{code:'PROCESSING_RETRY_RATE_LIMITED',message:'Too many extraction retry requests. Try again later.'}}});
 const reads=rateLimit({windowMs:60000,limit:readLimit,keyGenerator:req=>patientIdentity(req),standardHeaders:'draft-8',legacyHeaders:false,
  message:{success:false,error:{code:'PROCESSING_RATE_LIMITED',message:'Too many extraction status requests. Try again later.'}}});
 const own=async(id:string,patient:string)=>{const row=await repository.status(id,patient);if(!row)throw notFound();return row;};
 const approved=async()=>{if(!approval)return false;try{await verifyApproval(approval);return true;}catch{return false;}};
 router.get('/documents/:id/processing',noStore,authenticate,rejectQueryParameters,rejectRequestBody,reads,async(req,res)=>{
  const row=await own(documentId(req.params.id),patientIdentity(req));
  res.json({success:true,processing:publicProcessing(row,await approved())});
 });
 router.post('/documents/:id/processing-retries',noStore,authenticate,rejectQueryParameters,requireJson,limiter,async(req,res)=>{
  if(!req.body||typeof req.body!=='object'||Array.isArray(req.body)||Object.keys(req.body).length)throw new ApiError(400,'INVALID_INPUT','An empty JSON object is required.');
  const id=documentId(req.params.id),patient=patientIdentity(req);let row=await own(id,patient);
  if(!await approved())throw unavailable();
  if(!row.eligible)throw new ApiError(409,'PROCESSING_RETRY_NOT_AVAILABLE','This document is not eligible for extraction retry.');
  if(row.state==='failed'){
   if(!retryable(row))throw new ApiError(409,'PROCESSING_RETRY_NOT_AVAILABLE','This document is not eligible for extraction retry.');
   await repository.retry(id,patient);row=await own(id,patient);
  }
  if(!['pending','running','retry_wait','completed'].includes(row.state))throw new ApiError(409,'PROCESSING_RETRY_NOT_AVAILABLE','This document is not eligible for extraction retry.');
  if(row.state==='completed'&&!row.verified)throw new ApiError(409,'PROCESSING_RETRY_NOT_AVAILABLE','This document requires processing review.');
  res.status(row.state==='completed'?200:202).json({success:true,processing:publicProcessing(row,true)});
 });
 return router;
}
