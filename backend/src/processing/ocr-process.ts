import {spawn} from 'node:child_process';
import type {OcrConfig} from './config.js';
import {ProcessorFailure} from './errors.js';

export class OcrFailure extends ProcessorFailure {
  readonly reason:'limit'|'invalid'|'empty'|'timeout'|'cancelled'|'busy'|'unavailable';
  constructor(reason:OcrFailure['reason']) {
    super(reason==='timeout'?'PROCESSOR_TIMEOUT':reason==='cancelled'?'INTERRUPTED':reason==='busy'||reason==='unavailable'?'PROCESSOR_FAILED':'INVALID_INPUT',
      ['timeout','cancelled','busy','unavailable'].includes(reason));
    this.reason=reason;this.message='Document OCR could not be completed.';
  }
}
// Fixed executable allowlist. No shell, inherited credentials, input-derived flags or diagnostics.
export async function runOcrCommand(tool:'tesseract'|'pdftoppm',args:readonly string[],cwd:string,signal:AbortSignal,config:OcrConfig):Promise<string> {
  if(signal.aborted)throw new OcrFailure('cancelled');
  const child=spawn('/usr/bin/prlimit',[
    `--as=${config.memoryBytes}`,`--cpu=${config.cpuSeconds}`,`--fsize=${config.maxTempBytes}`,
    '--nofile=64','--core=0','--',tool==='tesseract'?'/usr/bin/tesseract':'/usr/bin/pdftoppm',...args
  ],{shell:false,detached:true,cwd,env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8',OMP_THREAD_LIMIT:'1',OMP_NUM_THREADS:'1',HOME:cwd,TMPDIR:cwd},stdio:['ignore','pipe','pipe']});
  let failure:OcrFailure|undefined,bytes=0,stderrBytes=0;
  const chunks:Buffer[]=[],diagnostics:Buffer[]=[];
  const kill=()=>{try{if(child.pid)process.kill(-child.pid,'SIGKILL');}catch{ /* Already reaped. */ }};
  const stop=(reason:OcrFailure['reason'])=>{failure??=new OcrFailure(reason);kill();};
  const abort=()=>stop('cancelled');
  const timer=setTimeout(()=>stop('timeout'),config.pageTimeoutMs);
  signal.addEventListener('abort',abort,{once:true});
  child.stdout.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>config.maxOutputBytes)stop('limit');else chunks.push(chunk);});
  child.stderr.on('data',(chunk:Buffer)=>{stderrBytes+=chunk.length;if(stderrBytes>65536)stop('limit');else if(tool==='pdftoppm'&&args.length===1&&args[0]==='-v')diagnostics.push(chunk);});
  if(signal.aborted)abort();
  try{
    await new Promise<void>((resolve,reject)=>{
      child.once('error',()=>{failure??=new OcrFailure('unavailable');});
      child.once('close',(code,termination)=>{
        if(failure)reject(failure);else if(termination)reject(new OcrFailure('limit'));
        else if(code!==0)reject(new OcrFailure('invalid'));else resolve();
      });
    });
    return Buffer.concat([...chunks,...diagnostics]).toString('utf8');
  }finally{clearTimeout(timer);signal.removeEventListener('abort',abort);kill();}
}
