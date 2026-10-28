import {guard} from '../processing/background-config.js';
import {type Preparation,type UploadReceipt,uuid,hash,target} from './safety.js';
import type {ReadDatabase} from './database.js';
export interface ObjectReceipt {key:string;sha256:string;bytes:number;versionId?:string;unchanged:boolean;private:boolean;observedAt:string;}
// The object reader must use the existing bounded original reader, expected
// bucket owner, version/ETag fences, and fixture SHA; never a bucket listing.
export async function observeReceipt(db:ReadDatabase,p:{run:string;config:{canary:{patientId:string}}},role:'sentinel'|'mixed',document:string,fixtureSha:string,
 original:()=>Promise<ObjectReceipt>,now?:number):Promise<UploadReceipt>{
 guard(uuid(document)&&hash(fixtureSha));
 const result=await db.query(`SELECT d.id,d.patient_id,d.s3_bucket,d.s3_object_key,d.processing_status,
 j.state,j.attempt_count,j.lease_token,j.lease_expires_at,j.finished_at,
 e.processing_status AS extraction_status,e.processing_attempt,e.processing_claim_token,e.source_metadata,
 (SELECT count(*)::int FROM public.document_processing_jobs WHERE document_id=d.id) AS job_count,
 (SELECT count(*)::int FROM public.extracted_medical_text WHERE document_id=d.id) AS extraction_count
 FROM public.medical_documents d JOIN public.document_processing_jobs j ON j.document_id=d.id AND j.patient_id=d.patient_id
 LEFT JOIN public.extracted_medical_text e ON e.document_id=d.id AND e.patient_id=d.patient_id
 WHERE d.id=$1::uuid AND d.patient_id=$2::uuid`,[document,p.config.canary.patientId]);
 guard(result.rows.length===1);const r=result.rows[0];guard(r.s3_bucket===target.bucket&&r.id===document&&r.patient_id===p.config.canary.patientId);
 const object=await original(),observed=now??Date.now(),time=Date.parse(object.observedAt);guard(Number.isFinite(time)&&time<=observed&&observed-time<=30000&&object.key===r.s3_object_key&&object.sha256===fixtureSha);
 const meta=r.source_metadata,source=meta?.source;
 if(role==='mixed'&&r.state==='completed')guard(source?.sha256===fixtureSha&&source?.pageCount===2&&meta.method==='mixed');
 const pages=source?.pages??[];
 return {run:p.run,role,patientId:r.patient_id,documentId:document,key:object.key,fixtureSha256:fixtureSha,originalSha256:object.sha256,
 bytes:object.bytes,versionId:object.versionId,confirmed:true,observedAt:new Date(observed).toISOString(),jobCount:r.job_count,state:r.state,attempt:r.attempt_count,extractions:r.extraction_count,
 methods:pages.map((v:{method:string})=>v.method),pages:pages.map((v:{page:number})=>v.page),evidenceAttempt:r.processing_attempt,
 currentAttempt:!!r.processing_claim_token&&r.processing_attempt===r.attempt_count,
 atomicCompletion:r.state==='completed'&&r.processing_status==='completed'&&r.extraction_status==='completed'&&r.finished_at!==null&&r.lease_token===null&&r.lease_expires_at===null,
 originalUnchanged:object.unchanged,privateObject:object.private};
}
