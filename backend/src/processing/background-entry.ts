import {pathToFileURL} from 'node:url';
import {backgroundConfig} from './background-config.js';
import {logEvent} from './background-service.js';

export async function launchBackground(env:NodeJS.ProcessEnv,start:()=>Promise<{stop(immediate?:boolean):Promise<void>}>) {
  const config=backgroundConfig(env);
  if(!config.enabled)return {enabled:false as const};
  return {enabled:true as const,service:await start()};
}
async function main(){
  const shutdown=new AbortController();
  const stop=()=>shutdown.abort();
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  // Match the project's dotenv convention without importing an API or DB pool.
  await import('../config/env.js');
  const result=await launchBackground(process.env,async()=>{
    const config=backgroundConfig(process.env);if(!config.enabled)throw new Error('Disabled.');
    return (await import('./background-runtime.js')).startRuntime(config,shutdown.signal);
  });
  if(!result.enabled){process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);console.log(JSON.stringify({service:'document-processing',event:'disabled'}));return;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){void main().catch(()=>{logEvent('safety-stop');process.exitCode=1;});}
