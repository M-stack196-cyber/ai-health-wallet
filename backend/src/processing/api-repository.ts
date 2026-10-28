import type {PatientDatabase} from '../patients/repository.js';
import type {Canary} from './background-config.js';

export interface PatientProcessingState {
 document_id:string;state:string;attempt_count:number;max_attempts:number;last_error_code:string|null;
 verified:boolean;eligible:boolean;
}
export function createPatientProcessingRepository(database:PatientDatabase,scope?:Canary){
 const args=(id:string,patient:string)=>[id,patient,scope?.patientId??null,scope?.uploadCutoff??null];
 return {
  async status(id:string,patient:string):Promise<PatientProcessingState|undefined>{
   return (await database.query<PatientProcessingState>(`SELECT j.document_id,j.state,j.attempt_count,j.max_attempts,j.last_error_code,
    EXISTS(SELECT 1 FROM public.extracted_medical_text e WHERE e.document_id=j.document_id AND e.patient_id=j.patient_id
      AND e.processing_status='completed' AND e.processing_attempt=j.attempt_count AND e.processing_claim_token IS NOT NULL
      AND e.updated_at>=j.started_at AND public.valid_extraction_payload(e.extracted_text,e.source_metadata,e.extractor_version) IS TRUE) AS verified,
    (j.patient_id=$3::uuid AND d.patient_id=$3::uuid AND d.uploaded_at >= $4::timestamptz) IS TRUE AS eligible
    FROM public.document_processing_jobs j JOIN public.medical_documents d ON d.id=j.document_id AND d.patient_id=j.patient_id
    WHERE j.document_id=$1 AND j.patient_id=$2`,args(id,patient))).rows[0];
  },
  async retry(id:string,patient:string):Promise<boolean>{
   // Exact owner and fixed cutoff are enforced in SQL, not just HTTP. No attempt reset,
   // new job, extraction deletion, original replacement or expired-running recovery.
   return (await database.query(`WITH candidate AS (
    SELECT j.document_id FROM public.document_processing_jobs j JOIN public.medical_documents d
      ON d.id=j.document_id AND d.patient_id=j.patient_id
    WHERE j.document_id=$1 AND j.patient_id=$2 AND j.patient_id=$3::uuid AND d.patient_id=$3::uuid
      AND d.uploaded_at >= $4::timestamptz AND d.processing_status='failed' AND j.state='failed'
      AND j.attempt_count>0 AND j.attempt_count<j.max_attempts
      AND j.last_error_code IN ('PROCESSOR_FAILED','PROCESSOR_TIMEOUT','INTERRUPTED','LEASE_EXPIRED')
    FOR UPDATE OF j,d
   ), changed AS (
    UPDATE public.document_processing_jobs j SET state='retry_wait',next_attempt_at=clock_timestamp(),
      lease_token=NULL,lease_expires_at=NULL,attempt_deadline_at=NULL
    FROM candidate c WHERE j.document_id=c.document_id RETURNING j.document_id,j.patient_id
   ), synced AS (
    UPDATE public.medical_documents d SET processing_status='processing' FROM changed j
    WHERE d.id=j.document_id AND d.patient_id=j.patient_id RETURNING d.id
   ) SELECT id FROM synced`,args(id,patient))).rows.length===1;
  }
 };
}
