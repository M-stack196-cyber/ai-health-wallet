import type {PatientDatabase} from '../patients/repository.js';
import type {ProcessingConfig} from './config.js';
import {createProcessingRepository} from './repository.js';
import {assertCanary,guard,type Canary} from './background-config.js';

export function createCanaryRepository(database:PatientDatabase,config:ProcessingConfig,canary:Canary){
  assertCanary(canary);
  const {patientId,uploadCutoff}=canary;
  const repository=createProcessingRepository(database,config,patientId,uploadCutoff);
  const claim=repository.claim.bind(repository);
  repository.claim=async()=>{
    const job=await claim();if(job)guard(job.patient_id===patientId);return job;
  };
  return {repository,async queueCount(){
    const result=await database.query<{count:string}>(`SELECT count(*)::text AS count FROM public.document_processing_jobs j
      JOIN public.medical_documents d ON d.id=j.document_id AND d.patient_id=j.patient_id
      WHERE j.patient_id=$1::uuid AND d.patient_id=$1::uuid AND d.uploaded_at >= $2::timestamptz
        AND j.state IN ('pending','retry_wait') AND j.attempt_count<j.max_attempts
        AND j.next_attempt_at<=clock_timestamp() AND d.processing_status IN ('processing','failed')`,[patientId,uploadCutoff]);
    const count=Number(result.rows[0]?.count);guard(Number.isSafeInteger(count)&&count>=0);return count;
  }};
}
