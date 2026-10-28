import type {ValidatedExtraction} from "./extraction.js";
import type {FileType} from "../documents/validation.js";
import { randomUUID } from "node:crypto";
import type { QueryResultRow } from "pg";
import type { PatientDatabase } from "../patients/repository.js";
import type { ProcessingConfig } from "./config.js";
import type { FailureCode } from "./errors.js";

export interface ProcessingJob extends QueryResultRow {
  document_id:string; patient_id:string; state:"pending"|"running"|"retry_wait"|"completed"|"failed";
  attempt_count:number; max_attempts:number; next_attempt_at:Date; created_at:Date; updated_at:Date;
  started_at:Date|null; finished_at:Date|null; lease_token:string|null;
  lease_expires_at:Date|null; attempt_deadline_at:Date|null; last_error_code:FailureCode|null;
}
export interface OriginalReference extends QueryResultRow { s3_bucket:string; s3_object_key:string; file_type:FileType; }
export interface Claim { documentId:string; patientId:string; token:string; }
const synchronize = (status:string) => `, synced AS (
  UPDATE public.medical_documents d SET processing_status=${status} FROM changed j
  WHERE d.id=j.document_id AND d.patient_id=j.patient_id RETURNING d.id
) SELECT j.* FROM changed j JOIN synced d ON d.id=j.document_id`;
const liveClaim = `document_id=$1 AND patient_id=$2 AND lease_token=$3 AND state='running'
  AND lease_expires_at>clock_timestamp() AND attempt_deadline_at>clock_timestamp()`;

// Internal trusted-worker repository. Optional patient scope isolates synthetic
// tests or tenant-specific orchestration; it is never a public request parameter.
export function createProcessingRepository(database:PatientDatabase,config:ProcessingConfig,patientScope?:string,uploadCutoff?:string) {
  if(uploadCutoff!==undefined&&(!patientScope||!Number.isFinite(Date.parse(uploadCutoff))||new Date(uploadCutoff).toISOString()!==uploadCutoff))throw new Error('Invalid processing eligibility.');
  // Optional canary filter: existing manual/API callers retain their exact SQL.
  const cutoff=(parameter:number,document='document_id',patient='patient_id')=>uploadCutoff===undefined?'':
    ` AND EXISTS (SELECT 1 FROM public.medical_documents eligible WHERE eligible.id=${document}
      AND eligible.patient_id=${patient} AND eligible.patient_id=$${parameter}::uuid
      AND eligible.uploaded_at >= $${parameter+1}::timestamptz)`;
  const eligibility=()=>uploadCutoff===undefined?[]:[patientScope,uploadCutoff];
  const identity=(claim:Claim)=>[claim.documentId,claim.patientId,claim.token];
  return {
    async resolveOriginal(claim:Claim):Promise<OriginalReference|undefined> {
      return (await database.query<OriginalReference>(`SELECT d.s3_bucket,d.s3_object_key,d.file_type
        FROM public.document_processing_jobs j JOIN public.medical_documents d
          ON d.id=j.document_id AND d.patient_id=j.patient_id
        WHERE j.document_id=$1 AND j.patient_id=$2 AND j.lease_token=$3
          AND j.state='running' AND j.lease_expires_at>clock_timestamp()
          AND j.attempt_deadline_at>clock_timestamp() AND d.processing_status='processing'
          AND ($4::uuid IS NULL OR j.patient_id=$4)${cutoff(5,'j.document_id','j.patient_id')}`,
        [...identity(claim),patientScope??null,...eligibility()])).rows[0];
    },
    async persistExtraction(claim:Claim,result:ValidatedExtraction):Promise<boolean> {
      return (await database.query<{saved:boolean}>(`SELECT public.persist_document_extraction($1,$2,$3,$4,$5::jsonb,$6) AS saved
        WHERE ($7::uuid IS NULL OR $2::uuid=$7)${cutoff(8,'$1::uuid','$2::uuid')}`,[...identity(claim),result.text,JSON.stringify(result.metadata),result.version,patientScope??null,...eligibility()])).rows[0]?.saved===true;
    },
    async completedForClaim(claim:Claim):Promise<boolean> {
      return (await database.query(`SELECT 1 FROM public.document_processing_jobs j JOIN public.extracted_medical_text e
        ON e.document_id=j.document_id AND e.patient_id=j.patient_id
        WHERE j.document_id=$1 AND j.patient_id=$2 AND j.state='completed' AND e.processing_status='completed'
          AND e.processing_claim_token=$3 AND e.processing_attempt=j.attempt_count
          AND ($4::uuid IS NULL OR j.patient_id=$4)${cutoff(5,'j.document_id','j.patient_id')}`,[...identity(claim),patientScope??null,...eligibility()])).rows.length===1;
    },
    async discover(limit:number):Promise<ProcessingJob[]> {
      return (await database.query<ProcessingJob>(`SELECT j.* FROM public.document_processing_jobs j
        JOIN public.medical_documents d ON d.id=j.document_id AND d.patient_id=j.patient_id
        WHERE ($1::uuid IS NULL OR j.patient_id=$1) AND j.state IN ('pending','retry_wait')
        AND j.next_attempt_at<=clock_timestamp() AND j.attempt_count<j.max_attempts
        AND d.processing_status IN ('processing','failed')
        ${cutoff(3,'j.document_id','j.patient_id')}
        ORDER BY j.next_attempt_at,j.created_at,j.document_id LIMIT $2`,[patientScope??null,limit,...eligibility()])).rows;
    },
    async claim():Promise<ProcessingJob|undefined> {
      const token=randomUUID();
      return (await database.query<ProcessingJob>(`WITH candidate AS (
        SELECT j.document_id FROM public.document_processing_jobs j
        JOIN public.medical_documents d ON d.id=j.document_id AND d.patient_id=j.patient_id
        WHERE ($1::uuid IS NULL OR j.patient_id=$1) AND j.state IN ('pending','retry_wait')
          AND j.next_attempt_at<=clock_timestamp() AND j.attempt_count<j.max_attempts
          AND d.processing_status IN ('processing','failed')
        ${cutoff(6,'j.document_id','j.patient_id')}
        ORDER BY j.next_attempt_at,j.created_at,j.document_id LIMIT 1 FOR UPDATE OF j SKIP LOCKED
      ), changed AS (
        UPDATE public.document_processing_jobs j SET state='running',attempt_count=j.attempt_count+1,
          max_attempts=CASE WHEN j.attempt_count=0 THEN $3 ELSE j.max_attempts END,
          started_at=clock_timestamp(),finished_at=NULL,lease_token=$2,
          lease_expires_at=clock_timestamp()+$4*interval '1 millisecond',
          attempt_deadline_at=clock_timestamp()+$5*interval '1 millisecond'
        FROM candidate c WHERE j.document_id=c.document_id RETURNING j.*
      )${synchronize("'processing'")}`,[patientScope??null,token,config.maxAttempts,config.leaseMs,config.attemptTimeoutMs,...eligibility()])).rows[0];
    },
    async heartbeat(claim:Claim):Promise<boolean> {
      return (await database.query(`UPDATE public.document_processing_jobs SET
        lease_expires_at=LEAST(attempt_deadline_at,clock_timestamp()+$4*interval '1 millisecond')
        WHERE ${liveClaim} AND ($5::uuid IS NULL OR patient_id=$5)${cutoff(6,'document_processing_jobs.document_id','document_processing_jobs.patient_id')} RETURNING document_id`,
        [...identity(claim),config.leaseMs,patientScope??null,...eligibility()])).rows.length===1;
    },
    async complete(claim:Claim):Promise<boolean> {
      return (await database.query(`WITH changed AS (
        UPDATE public.document_processing_jobs j SET state='completed',finished_at=clock_timestamp(),
          lease_token=NULL,lease_expires_at=NULL,attempt_deadline_at=NULL,last_error_code=NULL
        WHERE ${liveClaim} AND ($4::uuid IS NULL OR j.patient_id=$4)${cutoff(5,'j.document_id','j.patient_id')}
          AND EXISTS (SELECT 1 FROM public.extracted_medical_text e
            WHERE e.document_id=j.document_id AND e.patient_id=j.patient_id
              AND e.processing_status='completed' AND length(btrim(e.extracted_text))>0
              AND e.updated_at>=j.started_at AND e.processing_attempt=j.attempt_count AND e.processing_claim_token=j.lease_token
              AND public.valid_extraction_payload(e.extracted_text,e.source_metadata,e.extractor_version) IS TRUE)
        RETURNING j.*
      )${synchronize("'completed'")}`,[...identity(claim),patientScope??null,...eligibility()])).rows.length===1;
    },
    async fail(claim:Claim,code:FailureCode,retryable:boolean):Promise<boolean> {
      return (await database.query(`WITH changed AS (
        UPDATE public.document_processing_jobs SET
          state=CASE WHEN $5 AND attempt_count<max_attempts THEN 'retry_wait' ELSE 'failed' END,
          finished_at=clock_timestamp(),lease_token=NULL,lease_expires_at=NULL,attempt_deadline_at=NULL,
          last_error_code=$4,
          next_attempt_at=clock_timestamp()+LEAST($7::double precision,$6*power(2,attempt_count-1))*interval '1 millisecond'
        WHERE ${liveClaim} AND ($8::uuid IS NULL OR patient_id=$8)${cutoff(9,'document_processing_jobs.document_id','document_processing_jobs.patient_id')} RETURNING *
      )${synchronize("'failed'")}`,[...identity(claim),code,retryable,config.retryBaseMs,config.retryMaxMs,patientScope??null,...eligibility()])).rows.length===1;
    },
    async recover():Promise<number> {
      return (await database.query(`WITH expired AS (
        SELECT document_id FROM public.document_processing_jobs
        WHERE state='running' AND lease_expires_at<=clock_timestamp()
          AND ($1::uuid IS NULL OR patient_id=$1)${cutoff(5,'document_processing_jobs.document_id','document_processing_jobs.patient_id')}
        ORDER BY lease_expires_at,document_id LIMIT $2 FOR UPDATE SKIP LOCKED
      ), changed AS (
        UPDATE public.document_processing_jobs j SET
          state=CASE WHEN attempt_count<max_attempts THEN 'retry_wait' ELSE 'failed' END,
          finished_at=clock_timestamp(),lease_token=NULL,lease_expires_at=NULL,attempt_deadline_at=NULL,
          last_error_code='LEASE_EXPIRED',
          next_attempt_at=clock_timestamp()+LEAST($4::double precision,$3*power(2,attempt_count-1))*interval '1 millisecond'
        FROM expired x WHERE j.document_id=x.document_id RETURNING j.*
      )${synchronize("'failed'")}`,[patientScope??null,config.recoveryBatchSize,config.retryBaseMs,config.retryMaxMs,...eligibility()])).rows.length;
    },
  };
}
