import {pathToFileURL} from 'node:url';
import {parsePreparation,checkPreparation} from './safety.js';
import {parseLive,type LiveOptions} from './runtime-flags.js';
import {publicResult} from './evidence.js';
export async function main(args:string[],write:(line:string)=>void=console.log,execute?:(options:LiveOptions,signal:AbortSignal)=>Promise<void>):Promise<number>{
 const cancel=new AbortController();const stop=()=>cancel.abort();
 try{
 if(args[0]==='--check'){await checkPreparation(parsePreparation(args));write(JSON.stringify(publicResult('checked',true)));return 0;}
 const options=parseLive(args);
 process.once('SIGINT',stop);process.once('SIGTERM',stop);
 const signal=AbortSignal.any([cancel.signal,AbortSignal.timeout(900000)]);
 const run=execute??(await import('./live-runtime.js')).runLiveController;await run(options,signal);
 write(JSON.stringify(publicResult(options.phase==='seed'?'seeded':'completed',true)));return 0;}
 catch{write(JSON.stringify(publicResult('stopped',false)));return 1;}finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)process.exitCode=await main(process.argv.slice(2));
