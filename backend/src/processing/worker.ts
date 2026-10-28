import type {ExtractionResult} from "./extraction.js";
import {InvalidProcessingClaim,InvalidProcessingInput} from "./errors.js";
import type { ProcessingConfig } from "./config.js";
import type { createProcessingService } from "./service.js";
import type { Claim, ProcessingJob } from "./repository.js";
import type {OriginalAccess,OriginalInput} from "./retrieval.js";
import { OriginalUnavailable, ProcessorFailure } from "./errors.js";

// Future processors must persist a genuine completed extraction for this owner
// and attempt before returning. No default processor, OCR, S3 read or AI call.
export type DocumentProcessor=(context: { claim:Readonly<Claim>; attempt:number; signal:AbortSignal; persistExtraction(result:ExtractionResult):Promise<void>; withOriginal<T>(use:(input:OriginalInput)=>Promise<T>):Promise<T> })=>Promise<void>;
export type WorkerResult="disabled"|"idle"|"busy"|"completed"|"failed"|"lost"|"unavailable";
export function createProcessingWorker(service:ReturnType<typeof createProcessingService>,config:ProcessingConfig,processor?:DocumentProcessor,originals?:OriginalAccess) {
  let active=false;
  return {
    async runOnce(signal?:AbortSignal):Promise<WorkerResult>{
      if(!processor)return "disabled";
      if(active)return "busy";
      if(signal?.aborted)return "idle";
      active=true;
      let job:ProcessingJob|undefined;
      try {await service.recover();if(signal?.aborted){active=false;return "idle";}job=await service.claim();}
      catch{active=false;return "unavailable";}
      if(!job){active=false;return "idle";}
      const claim:Claim={documentId:job.document_id,patientId:job.patient_id,token:job.lease_token!};
      const controller=new AbortController();
      let heartbeat:ReturnType<typeof setTimeout>|undefined;
      let lost=false;
      let persisted=false;
      let persistenceStarted=false;
      let pendingPersistence:Promise<boolean>|undefined;
      let finishing=false;
      const persistExtraction=async(result:ExtractionResult):Promise<void>=>{
        if(persistenceStarted||retrievals.size||!acceptingOriginals)throw new InvalidProcessingInput();
        controller.signal.throwIfAborted();persistenceStarted=true;finishing=true;
        if(heartbeat)clearTimeout(heartbeat);if(heartbeatWork)await heartbeatWork;if(heartbeat)clearTimeout(heartbeat);
        controller.signal.throwIfAborted();
        pendingPersistence=service.persistExtraction(claim,result);
        if(!await pendingPersistence)throw new InvalidProcessingClaim();
        persisted=true;
      };
      let acceptingOriginals=true;
      const retrievals=new Set<Promise<unknown>>();
      const withOriginal=<T>(use:(input:OriginalInput)=>Promise<T>):Promise<T>=>{
        if(!originals||!acceptingOriginals||controller.signal.aborted)return Promise.reject(new OriginalUnavailable());
        const work=originals.withOriginal(claim,controller.signal,use);
        retrievals.add(work);
        void work.then(()=>retrievals.delete(work),()=>retrievals.delete(work));
        return work;
      };
      let heartbeatWork:Promise<void>|undefined;
      const abort=()=>controller.abort(new ProcessorFailure("INTERRUPTED"));
      signal?.addEventListener("abort",abort,{once:true});
      if(signal?.aborted)abort();
      // Stop execution before the DB deadline, leaving time to persist failure
      // while the lease is still valid. If that also fails, recovery owns it.
      const finalizeReserve=Math.min(1000,Math.floor(config.leaseMs/2),Math.floor(config.attemptTimeoutMs/4));
      const remaining=Math.max(1,Math.min(config.attemptTimeoutMs,job.attempt_deadline_at!.getTime()-Date.now())-finalizeReserve);
      const deadline=setTimeout(()=>controller.abort(new ProcessorFailure("PROCESSOR_TIMEOUT")),remaining);
      const beat=async()=>{
        if(controller.signal.aborted||finishing)return;
        try{if(!await service.heartbeat(claim)){lost=true;controller.abort();return;}}
        catch{lost=true;controller.abort();return;}
        if(!controller.signal.aborted&&!finishing)heartbeat=setTimeout(()=>{heartbeatWork=beat();},config.heartbeatMs);
      };
      heartbeat=setTimeout(()=>{heartbeatWork=beat();},config.heartbeatMs);
      let onAbort:(()=>void)|undefined;
      try {
        const cancelled=new Promise<never>((_resolve,reject)=>{
          onAbort=()=>reject(controller.signal.reason??new ProcessorFailure("INTERRUPTED"));
          controller.signal.addEventListener("abort",onAbort,{once:true});
          if(controller.signal.aborted)onAbort();
        });
        // Promise.race handles late processor rejection; handlers must cooperate
        // with cancellation and fence all future artifact writes using the lease.
        await Promise.race([Promise.resolve().then(()=>processor({claim:Object.freeze(claim),attempt:job!.attempt_count,signal:controller.signal,withOriginal,persistExtraction})),cancelled]);
        if(persisted)return "completed";
        if(lost)return "lost";
        controller.signal.throwIfAborted();
        if(await service.complete(claim))return "completed";
        return await service.fail(claim,"PROCESSOR_FAILED",false)?"failed":"lost";
      }catch(error){
        if(persisted)return "completed";
        if(persistenceStarted){
          if(pendingPersistence)await pendingPersistence.catch(()=>false);
          try{if(await service.completedForClaim(claim))return "completed";}catch{return "unavailable";}
        }
        if(lost)return "lost";
        const failure=error instanceof ProcessorFailure?error:new ProcessorFailure();
        try{return await service.fail(claim,failure.code,failure.retryable)?"failed":"lost";}
        catch{return "unavailable";}
      }finally{
        acceptingOriginals=false;
        clearTimeout(deadline);if(heartbeat)clearTimeout(heartbeat);
        controller.abort();signal?.removeEventListener("abort",abort);
        if(onAbort)controller.signal.removeEventListener("abort",onAbort);
        if(heartbeatWork)await heartbeatWork;
        if(pendingPersistence)await pendingPersistence.catch(()=>false);
        await Promise.allSettled([...retrievals]);
        active=false;
      }
    },
  };
}
