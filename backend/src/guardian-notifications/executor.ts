import {setTimeout as pause} from 'node:timers/promises';
import type {createGuardianNotificationService} from './service.js';
// Explicit construction/start only. Normal API startup never sends medical email.
export function createGuardianNotificationExecutor(service:ReturnType<typeof createGuardianNotificationService>,patients:readonly string[],pollMs=1000){
 if(!patients.length||patients.length>20||new Set(patients).size!==patients.length||patients.some(id=>!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id))||!Number.isSafeInteger(pollMs)||pollMs<100||pollMs>60000)throw Error('Invalid synthetic notification worker scope.');
 const scope=[...patients],controller=new AbortController();let pending:Promise<unknown>|undefined,loop:Promise<void>|undefined,stopping=false;
 const executor={
  async runOnce(){if(stopping)return {state:'stopped' as const};if(pending)return {state:'busy' as const};
   const work=(async()=>{const results=[];for(const patient of scope){if(stopping)break;const discovered=await service.scan(patient);if(stopping)break;results.push({patient,...discovered,delivery:await service.drain(patient,1)});}return {state:'completed' as const,results};})();pending=work;try{return await work;}finally{if(pending===work)pending=undefined;}
  },
  start(){if(stopping)throw Error('Notification worker stopped.');if(loop)return loop;loop=(async()=>{while(!stopping){await executor.runOnce();if(!stopping)await pause(pollMs,undefined,{signal:controller.signal}).catch(()=>{});}})();return loop;},
  async stop(){stopping=true;controller.abort();await pending;await loop;}
 };return executor;
}
