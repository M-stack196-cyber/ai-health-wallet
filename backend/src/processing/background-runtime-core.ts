import pg from 'pg';
import type {DocumentConfig} from '../config/documents.js';
import type {OriginalStorage} from '../documents/original-reader.js';
import type {ProcessingConfig,RetrievalConfig} from './config.js';
import type {DocumentProcessor} from './worker.js';
import {createProcessingWorker} from './worker.js';
import {createProcessingService} from './service.js';
import {createCanaryRepository} from './background-repository.js';
import {createOriginalAccess} from './retrieval.js';
import {acquireCoordinator} from './background-coordinator.js';
import {guard,verifyApproval,type BackgroundConfig} from './background-config.js';
import {startBackgroundHealth} from './background-health.js';
import {startBackground,type Event,type BackgroundPorts} from './background-service.js';

// Explicit composition port, never an environment-selected security bypass.
// The production caller performs all AWS/target gates before constructing it.
export async function composeBackground(config:BackgroundConfig,ports:{pool:pg.Pool;processing:ProcessingConfig;retrieval:RetrievalConfig;
  documents:DocumentConfig;storage:OriginalStorage;processor:DocumentProcessor;profileUnchanged():Promise<void>;
  closeStorage():void;log(event:Event):void;fault():void;shutdown?:AbortSignal;immediateShutdown?:boolean;closeResources?():Promise<void>;
  health?:BackgroundPorts['health'];
  systemAdmission?:{verify():Promise<void>;query<R extends pg.QueryResultRow>(sql:string,values:unknown[]):Promise<pg.QueryResult<R>>}}){
  const {pool}=ports;let coordinator:Awaited<ReturnType<typeof acquireCoordinator>>|undefined;
  let service:Awaited<ReturnType<typeof startBackground>>|undefined;let lost=false,closed=false;
  const cancel=()=>{lost=true;ports.fault();void service?.stop(true).catch(ports.fault);};
  const interrupt=()=>{void service?.stop(ports.immediateShutdown===true).catch(ports.fault);};
  ports.shutdown?.addEventListener('abort',interrupt,{once:true});pool.on('error',cancel);
  const close=async()=>{if(closed)return;closed=true;ports.shutdown?.removeEventListener('abort',interrupt);
    try{await coordinator?.close();}finally{if(ports.closeResources)await ports.closeResources();else{ports.closeStorage();await pool.end();}}};
  const approval=()=>ports.systemAdmission?ports.systemAdmission.verify():verifyApproval(config);
  try{
    ports.shutdown?.throwIfAborted();await approval();
    coordinator=await acquireCoordinator(await pool.connect(),cancel);
    const admission=async()=>{guard(!lost);coordinator!.assertOwned();await approval();await ports.profileUnchanged();await coordinator!.ping();guard(!lost);};
    const database={async query<R extends pg.QueryResultRow>(sql:string,values:unknown[]){
      try{await admission();return await (ports.systemAdmission?ports.systemAdmission.query<R>(sql,values):pool.query<R>(sql,values));}catch{cancel();throw new Error('Processing database unavailable.');}
    }};
    const {repository,queueCount}=createCanaryRepository(database,ports.processing,config.canary);
    const processingService=createProcessingService(repository);
    const originals=createOriginalAccess(processingService,ports.storage,ports.documents,ports.retrieval);
    ports.shutdown?.throwIfAborted();
    service=await startBackground(config,{admission,queueCount,
      worker:()=>createProcessingWorker(processingService,ports.processing,ports.processor,originals),
      health:ports.health??(snapshot=>startBackgroundHealth(config.healthPort,snapshot)),close,log:ports.log});
    if(lost)await service.stop(true);else if(ports.shutdown?.aborted)await service.stop();return service;
  }catch{await close();throw new Error('Processing service startup refused.');}
}
