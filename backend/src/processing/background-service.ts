import {setTimeout as delay} from 'node:timers/promises';
import type {BackgroundConfig} from './background-config.js';
import type {Status} from './background-health.js';
import type {WorkerResult} from './worker.js';
import {guard,assertCanary} from './background-config.js';

export type Event='started'|'stopping'|'stopped'|'safety-stop'|'poll-unavailable'|'completed'|'failed'|'lost'|'idle'|'unavailable';
export function logEvent(event:Event,write:(line:string)=>void=console.log){
  // Reconstruct a fixed schema; never log Error, job, configuration or metadata.
  const allowed:Event[]=['started','stopping','stopped','safety-stop','poll-unavailable','completed','failed','lost','idle','unavailable'];
  write(JSON.stringify({service:'document-processing',event:allowed.includes(event)?event:'safety-stop'}));
}
export interface BackgroundPorts {
  admission():Promise<void>;queueCount():Promise<number>;
  worker():{runOnce(signal:AbortSignal):Promise<WorkerResult>};
  health(status:()=>Status):Promise<{close():Promise<void>}>;
  close():Promise<void>;log(event:Event):void;
  sleep?(ms:number,signal:AbortSignal):Promise<void>;
}
export async function startBackground(config:BackgroundConfig,ports:BackgroundPorts){
  guard(config.enabled===true);assertCanary(config.canary);
  guard(Number.isInteger(config.concurrency)&&config.concurrency>=1&&config.concurrency<=2);
  let stopping=false,finished=false,ready=false,stopPromise:Promise<void>|undefined;
  const wake=new AbortController(),work=new AbortController();
  const metrics={active:0,completed:0,failed:0,lost:0,unavailable:0,idle:0,queue:0};
  const tasks=new Set<Promise<void>>();
  const snapshot=():Status=>({live:!finished,ready:ready&&!stopping,metrics:{...metrics}});
  const health=await ports.health(snapshot);
  async function sleep(ms:number){await (ports.sleep?ports.sleep(ms,wake.signal):delay(ms,undefined,{signal:wake.signal})).catch(()=>undefined);}
  async function stop(immediate=false){
    stopping=true;ready=false;wake.abort();if(immediate)work.abort();
    if(stopPromise)return stopPromise;
    stopPromise=(async()=>{
      ports.log('stopping');
      const timer=setTimeout(()=>work.abort(),config.drainMs);
      try{await loop;await Promise.allSettled([...tasks]);}
      finally{clearTimeout(timer);work.abort();try{await health.close();}finally{await ports.close();finished=true;ports.log('stopped');}}
    })();return stopPromise;
  }
  // Initialization completes before this loop's first asynchronous continuation.
  const loop=(async()=>{
    let backoff=config.pollMs;
    while(!stopping){
      try{
        await ports.admission();if(stopping)break;
        metrics.queue=await ports.queueCount();if(stopping)break;
        ready=true;
        const slots=config.concurrency-tasks.size;
        for(let i=0;i<slots&&!stopping;i++){
          // No prefetch: one worker per free slot. Admission is repeated inside
          // each repository query immediately before SQL can mutate anything.
          const worker=ports.worker();metrics.active++;
          const task=worker.runOnce(work.signal).then(result=>{
            guard(['completed','failed','lost','idle','unavailable'].includes(result));
            metrics[result as keyof Pick<typeof metrics,'completed'|'failed'|'lost'|'idle'|'unavailable'>]++;
            ports.log(result as Event);
            if(result==='unavailable'){ready=false;backoff=Math.min(config.backoffMaxMs,Math.max(5000,backoff*2));}
            else backoff=config.pollMs;
          }).catch(()=>{ready=false;metrics.unavailable++;backoff=Math.min(config.backoffMaxMs,Math.max(5000,backoff*2));ports.log('unavailable');})
            .finally(()=>{metrics.active--;tasks.delete(task);});
          tasks.add(task);
        }
      }catch{
        // Admission failures (approval/ownership) are fatal. SQL queue failures
        // are also fail-closed rather than accidentally admitting new work.
        ports.log('safety-stop');stopping=true;ready=false;work.abort();wake.abort();
        queueMicrotask(()=>{void stop(true).catch(()=>undefined);});break;
      }
      await sleep(Math.min(config.backoffMaxMs,backoff+Math.floor(Math.random()*250)));
    }
  })();
  ports.log('started');
  return {snapshot,stop,done:loop};
}
