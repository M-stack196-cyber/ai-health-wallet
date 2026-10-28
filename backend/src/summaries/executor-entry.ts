import {pathToFileURL} from 'node:url';
import {defaultSummaryExecutorConfig,SummaryExecutorError,type SummaryExecutorConfig,type createSummaryExecutor} from './executor.js';

export function summaryExecutorConfig(env:NodeJS.ProcessEnv):SummaryExecutorConfig{
 if(env.SUMMARY_EXECUTOR_ENABLED===undefined||env.SUMMARY_EXECUTOR_ENABLED==='false')return {...defaultSummaryExecutorConfig};
 if(env.SUMMARY_EXECUTOR_ENABLED!=='true'||env.SUMMARY_EXECUTOR_MODE!=='injected-fake'||!env.SUMMARY_EXECUTOR_PATIENT_ID||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(env.SUMMARY_EXECUTOR_PATIENT_ID))throw new SummaryExecutorError();
 return {...defaultSummaryExecutorConfig,enabled:true,patientId:env.SUMMARY_EXECUTOR_PATIENT_ID};
}
export async function launchSummaryExecutor(env:NodeJS.ProcessEnv,compose:(config:SummaryExecutorConfig,signal:AbortSignal)=>Promise<ReturnType<typeof createSummaryExecutor>>,signal=new AbortController().signal){
 const config=summaryExecutorConfig(env);if(!config.enabled)return {enabled:false as const};
 if(signal.aborted)throw new SummaryExecutorError();
 const service=await compose(config,signal);
 if(signal.aborted){await service.stop(true);throw new SummaryExecutorError();}
 const stop=()=>{void service.stop(true);};signal.addEventListener('abort',stop,{once:true});
 service.start();return {enabled:true as const,service,async stop(){signal.removeEventListener('abort',stop);return service.stop();}};
}
async function main(){
 // Deliberately no dotenv, pool, AWS, listener or credential composition. Enabled
 // execution requires an explicitly injected reviewed fake runtime in this stage.
 const result=await launchSummaryExecutor(process.env,async()=>{throw new SummaryExecutorError();});
 if(!result.enabled)console.log(JSON.stringify({service:'medical-summary-executor',event:'disabled'}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)void main().catch(()=>{console.error(JSON.stringify({service:'medical-summary-executor',event:'configuration-refused'}));process.exitCode=1;});
