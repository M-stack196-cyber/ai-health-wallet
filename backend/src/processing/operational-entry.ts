import {pathToFileURL} from 'node:url';
// No dotenv, pool, AWS SDK, credential reader, process-manager or OCR imports.
interface Signals {once(event:string,listener:()=>void):unknown;removeListener(event:string,listener:()=>void):unknown;}
export async function launchOperational(env:NodeJS.ProcessEnv,compose?:(signal:AbortSignal)=>Promise<{stop(immediate?:boolean):Promise<unknown>}>,signals:Signals=process){
 const enabled=env.PROCESSING_OPERATIONAL_ENABLED??'false';
 if(enabled==='false')return {enabled:false as const};
 if(enabled!=='true'||env.PROCESSING_OPERATIONAL_MODE!=='system-files'||env.PROCESSING_SERVICE_ENABLED!=='true'||!compose)throw new Error('Operational composition unavailable.');
 for(const [key,value]of Object.entries(env))if(value&&((key.startsWith('AWS_')&&key!=='AWS_EC2_METADATA_DISABLED')||key.startsWith('PG')||key.startsWith('DB_')||['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy','NODE_OPTIONS','NODE_PATH'].includes(key)))throw new Error('Operational composition unavailable.');
 const cancel=new AbortController();let service:Awaited<ReturnType<typeof compose>>|undefined;
 const clear=()=>{signals.removeListener('SIGTERM',stop);signals.removeListener('SIGINT',stop);};
 const stop=()=>{cancel.abort();if(service)void service.stop().catch(()=>{}).finally(clear);};
 signals.once('SIGTERM',stop);signals.once('SIGINT',stop);
 try{service=await compose(cancel.signal);if(cancel.signal.aborted){await service.stop(true);throw new Error();}const running=service;return {enabled:true as const,service:{async stop(immediate?:boolean){try{return await running.stop(immediate);}finally{clear();}}}};}catch{cancel.abort();clear();throw new Error('Operational composition unavailable.');}
}
async function main(){try{const r=await launchOperational(process.env);console.log(JSON.stringify({service:'document-processing-operational',event:r.enabled?'started':'disabled'}));}catch{console.log(JSON.stringify({service:'document-processing-operational',event:'refused'}));process.exitCode=1;}}
// A trusted system-manager/file/network composition must be supplied explicitly.
// There is intentionally no ambient-credential or user-manager fallback.
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)void main();
