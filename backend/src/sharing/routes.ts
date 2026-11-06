import {Router,type Request,type RequestHandler} from 'express';
import QRCode from 'qrcode';
import type {AuthenticationConfig} from '../config/auth.js';
import type {DocumentConfig} from '../config/documents.js';
import type {DocumentStorage} from '../documents/storage.js';
import type {SecurityMailer} from '../auth/routes.js';
import {requirePatient,assertCurrentPatient,patientIdentity,requireJson,rejectQueryParameters,rejectRequestBody} from '../auth/middleware.js';
import {createTokenService} from '../auth/tokens.js';
import {createSecurityRepository,rateHash} from '../auth/security-repository.js';
import {getSecurityPolicy} from '../auth/security-policy.js';
import {ApiError} from '../http/errors.js';
import {documentId,filters} from '../documents/validation.js';
import {createDocumentRepository,publicDocument} from '../documents/repository.js';
import {createPatientFileAccess} from '../documents/file-access.js';
import {notFound} from '../documents/service.js';
import {createTimelineService} from '../timeline/service.js';
import {createSummaryJobRepository} from '../summaries/jobs.js';
import {publicAcceptedSummary} from '../summaries/routes.js';
import {createRagService} from '../rag/service.js';
import type {RagDatabase} from '../rag/repository.js';
import type {createRagClient} from '../rag/client.js';
import {createSharingRepository,shareDenied,shareEvent,type DoctorScope} from './repository.js';
import type {SharingConfig} from './config.js';
export interface SharingOptions {config?:SharingConfig;mailer?:SecurityMailer;ragClient?:ReturnType<typeof createRagClient>;}
export function createSharingRoutes(db:RagDatabase,auth:AuthenticationConfig,documents:DocumentConfig,storage:DocumentStorage|null,options:SharingOptions={}){
 const r=Router(),security=createSecurityRepository(db,getSecurityPolicy()),repo=options.config?createSharingRepository(db,options.config):undefined;
 r.use((_req,res,next)=>{res.set('Cache-Control','no-store');next();});
 const unavailable=()=>new ApiError(503,'SHARING_UNAVAILABLE','Record sharing is temporarily unavailable.');
 const ready:RequestHandler=(_req,_res,next)=>{if(!repo)throw unavailable();next();};
 const patient=requirePatient(createTokenService(auth),db);
 const fields=(value:any,allowed:string[])=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!allowed.includes(k)))throw new ApiError(400,'INVALID_SHARE_INPUT','Invalid sharing request.');return value;};
 const email=(value:any)=>{if(typeof value!=='string'||value.length>254||!/^\S+@\S+\.\S+$/.test(value)||/[\r\n]/.test(value))throw new ApiError(400,'INVALID_SHARE_INPUT','A valid doctor email is required.');return value.trim().toLowerCase();};
 const name=(value:any,max=120)=>{if(typeof value!=='string'||!value.trim()||value.length>max||/[\u0000-\u001f\u007f]/.test(value))throw new ApiError(400,'INVALID_SHARE_INPUT','Doctor identity is invalid.');return value.trim();};
 const empty:RequestHandler=(req,_res,next)=>{if(Object.keys(fields(req.body,[])).length)throw shareDenied();next();};
 const token=(value:any)=>{if(typeof value!=='string'||value.length>160)throw shareDenied();return value;};
 async function rate(req:Request,kind:string,subject:string,max:number,windowSeconds=3600){for(const [i,key] of [rateHash(auth.jwtKey,kind+':ip',req.ip??'unknown'),rateHash(auth.jwtKey,kind+':subject',subject)].entries())if(!await security.rate(key,i===0?Math.max(max,100):max,windowSeconds))throw new ApiError(429,'SHARING_RATE_LIMITED','Too many sharing attempts. Try again later.');}
 r.post('/sharing/grants',patient,ready,rejectQueryParameters,requireJson,async(req,res)=>{
  const b=fields(req.body,['document_ids','share_type','doctor_email']);if(!Array.isArray(b.document_ids)||!b.document_ids.length||b.document_ids.length>20||new Set(b.document_ids).size!==b.document_ids.length||!['qr_code','unique_link'].includes(b.share_type))throw new ApiError(400,'INVALID_SHARE_SELECTION','Select exact records and a sharing type.');
  const ids=b.document_ids.map((id:any)=>documentId(id)),recipient=b.doctor_email===undefined?undefined:email(b.doctor_email);
  await rate(req,'grant_create',patientIdentity(req),60);const created=await repo!.create(patientIdentity(req),req.auth!.sessionId!,ids,b.share_type,recipient);await assertCurrentPatient(req,db);
  const url=options.config!.origin+'/#/share/'+created.token;
  res.status(201).json({success:true,grant:created.grant,selected_document_ids:ids,share_url:url,qr_svg:b.share_type==='qr_code'?await QRCode.toString(url,{type:'svg',errorCorrectionLevel:'M'}):undefined});
 });
 r.get('/sharing/grants',patient,ready,rejectQueryParameters,rejectRequestBody,async(req,res)=>{res.json({success:true,grants:await repo!.list(patientIdentity(req))});});
 r.post('/sharing/grants/:id/revoke',patient,ready,rejectQueryParameters,requireJson,empty,async(req,res)=>{await assertCurrentPatient(req,db);if(!await repo!.revoke(documentId(req.params.id),patientIdentity(req)))throw notFound();res.json({success:true,revoked:true});});
 r.post('/sharing/open',ready,rejectQueryParameters,requireJson,async(req,res)=>{const b=fields(req.body,['share_token']);await rate(req,'grant_open',token(b.share_token),120);res.json({success:true,...await repo!.open(b.share_token)});});
 r.post('/sharing/otp',ready,rejectQueryParameters,requireJson,async(req,res)=>{
  const b=fields(req.body,['share_token','email','name','organization']),to=email(b.email),who=name(b.name),org=b.organization===undefined?null:name(b.organization,160),ref=token(b.share_token);
  await rate(req,'doctor_otp_request',ref+':'+to,options.config!.requests);if(!options.mailer?.enqueue)throw unavailable();
  const result=await repo!.requestOtp(ref,to,who,org,options.mailer);if(!result)throw shareDenied();res.status(202).json({success:true,...result});
 });
 r.post('/sharing/otp/verify',ready,rejectQueryParameters,requireJson,async(req,res)=>{const b=fields(req.body,['share_token','email','challenge_id','otp']),to=email(b.email),ref=token(b.share_token);await rate(req,'doctor_otp_verify',ref+':'+to,30);const result=await repo!.verify(ref,to,documentId(b.challenge_id),token(b.otp));if(!result)throw shareDenied();res.json({success:true,...result});});
 const session=(req:Request)=>{const m=/^Bearer (ds1\.[a-f0-9-]{36}\.[a-f0-9]{64})$/.exec(req.get('Authorization')??'');if(!m)throw shareDenied();return m[1];};
 const doctor=Router();doctor.use(ready);
 doctor.use(async(req,res,next)=>{let raw:string;try{raw=session(req);}catch(e){await shareEvent(db,'denied');throw e;}const scope=await repo!.resolve(raw);await rate(req,'doctor_access',scope.sessionHash,300);res.locals.doctorScope=scope;
  res.locals.resolveDoctor=async()=>{const current=await repo!.resolve(raw);if(JSON.stringify(current)!==JSON.stringify(scope))throw shareDenied();return current;};await shareEvent(db,'authorized',scope.grantId);next();});
 const scope=(res:any)=>res.locals.doctorScope as DoctorScope;
 const resolve=(res:any)=>res.locals.resolveDoctor as ()=>Promise<DoctorScope>;
 const selected=async(res:any,id:string)=>{const s=await resolve(res)();if(!s.permittedDocumentIds.includes(id)){await shareEvent(db,'denied',s.grantId);throw shareDenied();}return s;};
 doctor.get('/records',rejectRequestBody,async(req,res)=>{const s=scope(res),result=await createDocumentRepository(db).list(s.patientId,filters(req.query),s.permittedDocumentIds);await resolve(res)();res.json({success:true,documents:result.documents.map(publicDocument),pagination:{has_more:result.hasMore}});});
 doctor.get('/records/:id',rejectQueryParameters,rejectRequestBody,async(req,res)=>{const id=documentId(req.params.id),s=await selected(res,id),row=await createDocumentRepository(db).reference(id,s.patientId);await selected(res,id);if(!row)throw notFound();res.json({success:true,document:publicDocument(row)});});
 for(const operation of ['view','download'] as const){
  const deliver=createPatientFileAccess(createDocumentRepository(db),storage,documents,db,{authorize:async(req,id)=>{await selected(req.res,id);},disposition:operation==='view'?'inline':'attachment'});
  doctor.get('/records/:id/'+operation,rejectQueryParameters,rejectRequestBody,async(req,res)=>{
   const id=documentId(req.params.id),s=await selected(res,id);await shareEvent(db,'download',s.grantId);await deliver(id,s.patientId,req,res);
  });
 }
 doctor.get('/timeline',rejectRequestBody,async(req,res)=>{const result=await createTimelineService(db,resolve(res)).list(filters(req.query));res.json({success:true,...result});});
 doctor.get('/records/:id/summary',rejectQueryParameters,rejectRequestBody,async(req,res)=>{const id=documentId(req.params.id),s=await selected(res,id),row=(await createSummaryJobRepository(db,s.patientId).summaries(id))[0];await selected(res,id);if(!row)throw notFound();res.json({success:true,summary:publicAcceptedSummary(row)});});
 doctor.get('/history-summary',rejectQueryParameters,rejectRequestBody,async(_req,res)=>{
  const s=await resolve(res)(),entries=[];
  for(const id of s.permittedDocumentIds){const document=await createDocumentRepository(db).reference(id,s.patientId),row=(await createSummaryJobRepository(db,s.patientId).summaries(id))[0];if(document)entries.push({source_document_id:id,date:document.sort_date,date_source:document.sort_date_source,summary:row?publicAcceptedSummary(row):null});}
  entries.sort((a,b)=>a.date.localeCompare(b.date));await resolve(res)();res.json({success:true,scope:'selected_records_only',entries,limitations:['Only existing summaries of selected accessible records are shown. Missing summaries remain unavailable.']});
 });
 doctor.post('/rag/queries',rejectQueryParameters,requireJson,async(req,res)=>{
  await rate(req,'doctor_rag',scope(res).sessionHash,30,60);
  const b=fields(req.body,['question','category']);if(typeof b.question!=='string'||!b.question.trim()||Buffer.byteLength(b.question)>1000||/[\u0000-\u001f\u007f\ud800-\udfff]/u.test(b.question)||b.category!==undefined&&!['lab_report','prescription','other_medical_document'].includes(b.category))throw new ApiError(400,'INVALID_RAG_INPUT','Invalid record question.');if(!options.ragClient)throw unavailable();const s=scope(res);
  const result=await createRagService(db,s.patientId,options.ragClient,async()=>{await resolve(res)();},{grantId:s.grantId,sessionHash:s.sessionHash,permittedDocumentIds:s.permittedDocumentIds}).query(b.question,b.category,AbortSignal.timeout(30000));await resolve(res)();res.json({success:true,result});
 });
 doctor.get('/rag/queries/:id',rejectQueryParameters,rejectRequestBody,async(req,res)=>{if(!options.ragClient)throw unavailable();const s=scope(res),result=await createRagService(db,s.patientId,options.ragClient,async()=>{await resolve(res)();},s).get(documentId(req.params.id));if(!result)throw notFound();await resolve(res)();res.json({success:true,result});});
 r.use('/doctor',doctor);return r;
}
