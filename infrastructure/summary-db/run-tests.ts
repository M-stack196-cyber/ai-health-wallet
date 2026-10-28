import {spawn} from 'node:child_process';
import {mkdir,writeFile,cp} from 'node:fs/promises';
import {assertIsolated} from '../stage-b/isolation.js';
await assertIsolated();
const base={...process.env,PROCESSING_SERVICE_ENABLED:'false',AWS_EC2_METADATA_DISABLED:'true'};
const commands:[string,string[]][]=[['bootstrap',['node','--import','tsx','../infrastructure/summary-db/bootstrap.ts']],['migrations',['npm','run','db:migrate']],
 ['database',['npm','run','db:test']],['security',['npm','run','db:security:test']],['authentication',['npm','run','auth:test']],['documents',['npm','run','documents:test']],
 ['b02-contracts',['npm','run','contracts:b02:test']],['b03-contracts',['npm','run','contracts:b03:test']],['processing',['npm','run','processing:test']],['runner',['npm','run','integration:s3-ocr:test']],['stage-a',['npm','run','processing:service:test']],
 ['stage-b',['npm','run','processing:service:db:test']],['b03-db',['npm','run','processing:b03:db:test']],['stage-c',['npm','run','integration:stage-c:test']],['stage-c-db',['npm','run','integration:stage-c:db:test']],['summary-jobs',['npm','run','summaries:jobs:db:test']],['typecheck',['npm','run','typecheck']],['build',['npm','run','build']],['disabled',['node','dist/processing/background-entry.js']],['summary-disabled',['node','dist/summaries/executor-entry.js']]];
await mkdir('/work/results',{mode:0o700});const receipts:unknown[]=[];
for(const [name,[command,...args]]of commands){
 if(!['bootstrap','migrations'].includes(name)){
   await import('../../backend/src/config/env.js');await assertIsolated(true);
 }
 const result=await new Promise<{code:number;output:string}>(resolve=>{
   const child=spawn(command,args,{cwd:'/work/backend',env:base,stdio:['ignore','pipe','pipe']});let output='';let overflow=false;
   const append=(b:Buffer)=>{if(output.length+b.length>4*1024*1024){overflow=true;child.kill('SIGKILL');}else output+=b.toString();};
   child.stdout.on('data',append);child.stderr.on('data',append);const timer=setTimeout(()=>child.kill('SIGKILL'),300000);
   child.on('error',()=>{clearTimeout(timer);resolve({code:1,output:'Test subprocess unavailable.'});});
   child.on('close',code=>{clearTimeout(timer);resolve({code:overflow?1:code??1,output});});
 });
 const secrets=[process.env.DB_PASSWORD,process.env.JWT_SECRET,process.env.MIGRATION_DB_PASSWORD].filter((v):v is string=>!!v);
 let output=result.output;for(const secret of secrets)output=output.replaceAll(secret,'[REDACTED]');
 // Reports contain only test names/counts and controlled errors; raw output is
 // retained privately, not streamed through the host CLI.
 await writeFile('/work/results/'+name+'.log',output,{mode:0o600});
 const number=(label:string)=>Number(new RegExp('(?:#|ℹ) '+label+' (\\d+)').exec(output)?.[1]??0);
 const receipt={suite:name,exitCode:result.code,tests:number('tests'),passed:number('pass'),failed:number('fail'),skipped:number('skipped'),cancelled:number('cancelled')};
 receipts.push(receipt);await writeFile('/work/results/report.json',JSON.stringify(receipts,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(receipt));
 if(result.code!==0){process.exitCode=1;break;}
}
