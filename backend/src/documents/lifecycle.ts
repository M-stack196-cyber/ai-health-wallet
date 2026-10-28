import type {PatientDatabase} from '../patients/repository.js';
import {createPatientProcessingRepository,type PatientProcessingState} from '../processing/api-repository.js';
import {publicProcessing} from '../processing/api.js';
import {createSecurityRepository,transaction,type SessionIdentity} from '../auth/security-repository.js';
import {getSecurityPolicy} from '../auth/security-policy.js';
import {ApiError} from '../http/errors.js';
import {createDocumentRepository,type DocumentReference} from './repository.js';
import {validStorageReference,type DocumentStorage} from './storage.js';
import {notFound} from './service.js';
const retryCodes=['PROCESSOR_FAILED','PROCESSOR_TIMEOUT','INTERRUPTED','LEASE_EXPIRED'];
function recordedOriginal(d:DocumentReference,storage:DocumentStorage|null){
 return !!storage&&validStorageReference(storage,d.s3_bucket,d.s3_object_key)
  &&d.s3_object_key.endsWith('.'+d.file_type)&&!!d.sha256&&/^[a-f0-9]{64}$/.test(d.sha256)&&Number(d.size_bytes)>0&&!!d.content_type;
}
function canRetry(d:DocumentReference,j:PatientProcessingState,storage:DocumentStorage|null){
 return recordedOriginal(d,storage)&&d.processing_status==='failed'&&j.state==='failed'&&j.eligible
  &&j.attempt_count>0&&j.attempt_count<j.max_attempts&&retryCodes.includes(j.last_error_code??'');
}
export function createDocumentLifecycle(db:PatientDatabase,storage:DocumentStorage|null){
 async function snapshot(c:PatientDatabase,id:string,patient:string){
  const d=await createDocumentRepository(c).reference(id,patient);
  const j=await createPatientProcessingRepository(c,{documentOwner:true}).status(id,patient);
  if(!d||!j)throw notFound();
  return {d,j};
 }
 function expose(d:DocumentReference,j:PatientProcessingState){
  const recorded=recordedOriginal(d,storage);
  const {retry_allowed:_canaryRetry,...extraction}=publicProcessing(j,false);
  return {document_id:d.id,processing_status:d.processing_status,
   original_integrity:recorded?'recorded_at_upload':'unverified',
   extraction,
   ready_for_extraction:recorded&&['pending','retry_wait'].includes(j.state),
   // Storage readiness and extraction completion never establish downstream AI completion.
   downstream_completion:'not_qualified',retry_allowed:canRetry(d,j,storage)};
 }
 return {
  async readiness(id:string,patient:string){return transaction(db,async c=>{
   await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY',[]);
   const {d,j}=await snapshot(c,id,patient);return expose(d,j);
  });},
  async retry(id:string,who:SessionIdentity){return transaction(db,async c=>{
   // Serialize admission with M01 account/session mutations. Never start a processor.
   await c.query('SELECT id FROM public.patients WHERE id=$1 FOR UPDATE',[who.patientId]);
   if(!await createSecurityRepository(c,getSecurityPolicy()).authorize(who))throw new ApiError(401,'UNAUTHORIZED','A valid access token is required.');
   const before=await snapshot(c,id,who.patientId);
   if(!canRetry(before.d,before.j,storage))throw new ApiError(409,'DOCUMENT_RETRY_NOT_AVAILABLE','This document is not eligible for retry.');
   if(!await createPatientProcessingRepository(c,{documentOwner:true}).retry(id,who.patientId))throw new ApiError(409,'DOCUMENT_RETRY_NOT_AVAILABLE','This document is not eligible for retry.');
   const after=await snapshot(c,id,who.patientId);return expose(after.d,after.j);
  });}
 };
}
