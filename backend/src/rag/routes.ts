import {Router} from 'express';
import {rateLimit} from 'express-rate-limit';
import type {AuthenticationConfig} from '../config/auth.js';
import {requirePatient,assertCurrentPatient,patientIdentity,requireJson,rejectQueryParameters,rejectRequestBody} from '../auth/middleware.js';
import {createTokenService} from '../auth/tokens.js';
import {ApiError} from '../http/errors.js';
import {documentId} from '../documents/validation.js';
import {createDocumentRepository} from '../documents/repository.js';
import {notFound} from '../documents/service.js';
import {SummaryJobError} from '../summaries/jobs.js';
import type {RagDatabase} from './repository.js';
import {createRagClient,ragUnavailable} from './client.js';
import {createRagService} from './service.js';
export interface RagOptions {client?:ReturnType<typeof createRagClient>;}
export function createRagRoutes(db:RagDatabase,auth:AuthenticationConfig,options:RagOptions={}){
 const r=Router();r.use((_req,res,next)=>{res.set('Cache-Control','no-store');next();});
 const patient=requirePatient(createTokenService(auth),db),limit=rateLimit({windowMs:60000,limit:30,keyGenerator:req=>patientIdentity(req),standardHeaders:'draft-8',legacyHeaders:false});
 const input=()=>new ApiError(400,'INVALID_RAG_INPUT','Invalid record question request.');
 const wrap=(fn:(req:any,signal:AbortSignal)=>Promise<unknown>)=>async(req:any,res:any)=>{
  if(!options.client)throw ragUnavailable();const controller=new AbortController(),end=setTimeout(()=>controller.abort(),30000),closed=()=>{if(!res.writableFinished)controller.abort();};res.once('close',closed);
  try{res.json({success:true,result:await fn(req,controller.signal)});}catch(e){if(e instanceof ApiError)throw e;if(e instanceof SummaryJobError&&e.code==='SOURCE_INELIGIBLE')throw new ApiError(409,'RAG_SOURCE_NOT_READY','A current completed extraction is required.');throw ragUnavailable();}finally{clearTimeout(end);res.off('close',closed);}
 };
 const service=(req:any)=>createRagService(db,patientIdentity(req),options.client!,()=>assertCurrentPatient(req,db));
 r.post('/documents/:id/rag-index',patient,rejectQueryParameters,requireJson,limit,wrap(async(req,signal)=>{
  if(!req.body||Array.isArray(req.body)||typeof req.body!=='object'||Object.keys(req.body).length)throw input();const id=documentId(req.params.id);
  if(!await createDocumentRepository(db).reference(id,patientIdentity(req)))throw notFound();return service(req).index(id,signal);
 }));
 r.post('/rag/queries',patient,rejectQueryParameters,requireJson,limit,wrap(async(req,signal)=>{
  const b=req.body;if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).some(k=>!['question','category'].includes(k))||typeof b.question!=='string'||!b.question.trim()||Buffer.byteLength(b.question)>1000||/[\u0000-\u001f\u007f\ud800-\udfff]/u.test(b.question)||b.category!==undefined&&!['lab_report','prescription','other_medical_document'].includes(b.category))throw input();
  return service(req).query(b.question,b.category,signal);
 }));
 r.get('/rag/queries/:id',patient,rejectQueryParameters,rejectRequestBody,limit,wrap(async req=>{const row=await service(req).get(documentId(req.params.id));if(!row)throw notFound();return row;}));
 return r;
}
