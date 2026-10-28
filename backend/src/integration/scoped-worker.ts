import type {PatientDatabase} from '../patients/repository.js';
import type {ProcessingConfig} from '../processing/config.js';
import {createProcessingRepository} from '../processing/repository.js';
import {createProcessingService} from '../processing/service.js';
import {createProcessingWorker,type DocumentProcessor} from '../processing/worker.js';
import {createOriginalAccess} from '../processing/retrieval.js';
import type {OriginalStorage} from '../documents/original-reader.js';
import type {DocumentConfig} from '../config/documents.js';
import type {RetrievalConfig} from '../processing/config.js';
import {RunRegistry,insist,type ScenarioScope} from './guards.js';

// No path in this adapter constructs an unscoped repository. Scope comes from this run's registration/upload receipts.
export function createScenarioWorker(database:PatientDatabase,config:ProcessingConfig,scope:ScenarioScope,registry:RunRegistry,
  processor:DocumentProcessor,storage:OriginalStorage,documents:DocumentConfig,retrieval:RetrievalConfig){
  registry.assert(scope);
  const repository=createProcessingRepository(database,config,scope.patientId);
  const claim=repository.claim.bind(repository);
  repository.claim=async()=>{const job=await claim();if(job)insist(job.patient_id===scope.patientId&&job.document_id===scope.documentId,'CLAIM_SCOPE');return job;};
  const service=createProcessingService(repository);
  const originals=createOriginalAccess(service,storage,documents,retrieval);
  const worker=createProcessingWorker(service,config,async context=>{
    registry.assert(scope);insist(context.claim.patientId===scope.patientId&&context.claim.documentId===scope.documentId,'CLAIM_SCOPE');await processor(context);
  },originals);
  return {service,async runOnce(signal?:AbortSignal){registry.assert(scope);return worker.runOnce(signal);}};
}
