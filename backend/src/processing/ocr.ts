import {Worker} from 'node:worker_threads';
import {open,mkdtemp,chmod,stat,rm} from 'node:fs/promises';
import {constants} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {getOcrConfig,getDigitalPdfConfig,type OcrConfig,type DigitalPdfConfig} from './config.js';
import {validateExtraction,type ExtractionResult} from './extraction.js';
import {extractDigitalPdf} from './pdf-text.js';
import {OcrFailure,runOcrCommand} from './ocr-process.js';
import {ProcessorFailure} from './errors.js';
import type {OriginalInput} from './retrieval.js';
export {OcrFailure} from './ocr-process.js';

let active=0;
function checkConfig(c:OcrConfig){
  for(const [value,min,max] of [[c.maxPages,1,200],[c.maxFileBytes,1,20971520],[c.maxTextCharacters,1,1000000],
    [c.maxConcurrency,1,2],[c.dpi,72,300],[c.maxEdge,256,4000],[c.maxPixels,65536,16000000],
    [c.maxTempBytes,1024,33554432],[c.pageTimeoutMs,1,60000],[c.documentTimeoutMs,1,240000],
    [c.cpuSeconds,1,30],[c.memoryBytes,67108864,1073741824],[c.maxOutputBytes,1,8388608]])
    if(!Number.isSafeInteger(value)||value<min||value>max)throw new OcrFailure('limit');
}
/** TSV level-5 words only; confidence is the arithmetic mean of valid nonempty word scores. */
export function parseOcrTsv(tsv:string):{text:string;confidence?:number} {
  const lines=tsv.split(/\r?\n/);
  if(lines.shift()!=='level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext')throw new OcrFailure('invalid');
  const fragments:string[]=[];let lastLine='',sum=0,count=0;
  for(const line of lines){
    if(!line)continue;
    const cells=line.split('\t');if(cells.length!==12)throw new OcrFailure('invalid');
    if(cells[0]!=='5')continue;
    const text=cells[11];if(!text.trim())continue;
    const key=cells.slice(1,5).join(':');if(fragments.length)fragments.push(key===lastLine?' ':'\n');
    fragments.push(text);lastLine=key;
    const confidence=Number(cells[10]);
    if(cells[10].trim()&&Number.isFinite(confidence)&&confidence>=0&&confidence<=100){sum+=confidence;count++;}
  }
  const text=fragments.join('');
  if(!/[\p{L}\p{N}]/u.test(text))throw new OcrFailure('empty');
  return {text,...(count?{confidence:sum/count}:{})};
}
async function normalizeImage(input:Pick<OriginalInput,'path'|'type'|'bytes'>,destination:string,signal:AbortSignal,config:OcrConfig){
  signal.throwIfAborted();
  const worker=new Worker(new URL(import.meta.url.endsWith('.ts')?'./ocr-image-worker.ts':'./ocr-image-worker.js',import.meta.url),{
    execArgv:[],env:{},workerData:{path:input.path,type:input.type,expectedBytes:input.bytes,destination,config},
    resourceLimits:{maxOldGenerationSizeMb:128,maxYoungGenerationSizeMb:16},stdout:true,stderr:true});
  worker.stdout.resume();worker.stderr.resume();
  let timer:ReturnType<typeof setTimeout>|undefined,abort:(()=>void)|undefined;
  try{
    await new Promise<void>((resolve,reject)=>{
      abort=()=>reject(new OcrFailure('cancelled'));signal.addEventListener('abort',abort,{once:true});
      timer=setTimeout(()=>reject(new OcrFailure('timeout')),Math.min(5000,config.pageTimeoutMs));
      worker.once('message',valid=>valid===true?resolve():reject(new OcrFailure('invalid')));
      worker.once('error',()=>reject(new OcrFailure('invalid')));worker.once('exit',()=>reject(new OcrFailure('invalid')));
      if(signal.aborted)abort();
    });
  }finally{if(timer)clearTimeout(timer);if(abort)signal.removeEventListener('abort',abort);await worker.terminate();}
}
async function originalHash(input:Pick<OriginalInput,'path'|'bytes'>,config:OcrConfig){
  const file=await open(input.path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const info=await file.stat();if(!info.isFile()||info.size!==input.bytes||info.size<1||info.size>config.maxFileBytes)throw new OcrFailure('limit');
    const hash=createHash('sha256'),buffer=Buffer.alloc(65536);let total=0;
    for(;;){const read=await file.read(buffer,0,buffer.length,null);if(!read.bytesRead)break;
      total+=read.bytesRead;if(total>input.bytes)throw new OcrFailure('invalid');hash.update(buffer.subarray(0,read.bytesRead));}
    if(total!==input.bytes)throw new OcrFailure('invalid');return hash.digest('hex');
  }finally{await file.close();}
}
/** Internal API: call only with the validated, private original supplied by withOriginal(). */
export async function extractDocumentText(input:Pick<OriginalInput,'path'|'type'|'bytes'>,external:AbortSignal,
  config:OcrConfig=getOcrConfig(),pdfConfig:DigitalPdfConfig=getDigitalPdfConfig()):Promise<ExtractionResult>{
  checkConfig(config);
  if(external.aborted)throw new OcrFailure('cancelled');
  if(!['pdf','jpg','jpeg','png'].includes(input.type))throw new OcrFailure('invalid');
  if(!Number.isSafeInteger(input.bytes)||input.bytes<1||input.bytes>config.maxFileBytes)throw new OcrFailure('limit');
  if(active>=config.maxConcurrency)throw new OcrFailure('busy');active++;
  const deadline=new AbortController(),signal=AbortSignal.any([external,deadline.signal]);
  const timer=setTimeout(()=>deadline.abort(),config.documentTimeoutMs);
  let directory:string|undefined;
  try{
    const sha256=await originalHash(input,config);signal.throwIfAborted();
    let pageCount=1,pageTexts:string[]=[''],ocrPages=[1],dimensions:{width:number;height:number}[]=[],pdfVersion='';
    if(input.type==='pdf'){
      const output=await extractDigitalPdf(input,signal,{...pdfConfig,maxPages:Math.min(config.maxPages,pdfConfig.maxPages),
        maxTextCharacters:Math.min(config.maxTextCharacters,pdfConfig.maxTextCharacters)});
      if(output.kind==='extracted')return output.result;
      if(output.sourceSha256!==sha256)throw new OcrFailure('invalid');
      pageCount=output.pageCount;pageTexts=output.pageTexts;ocrPages=output.pages;dimensions=output.pageDimensions;pdfVersion=output.pdfVersion;
    }
    directory=await mkdtemp(join(tmpdir(),'health-wallet-ocr-'));await chmod(directory,0o700);
    const tessVersion=/^tesseract ([0-9][A-Za-z0-9.+_-]*)/m.exec(await runOcrCommand('tesseract',['--version'],directory,signal,config))?.[1];
    const popplerVersion=input.type==='pdf'?/pdftoppm version ([0-9][A-Za-z0-9.+_-]*)/.exec(await runOcrCommand('pdftoppm',['-v'],directory,signal,config))?.[1]:undefined;
    if(!tessVersion||(input.type==='pdf'&&!popplerVersion))throw new OcrFailure('unavailable');
    const pages:ExtractionResult['source']['pages']=Array.from({length:pageCount},(_,index)=>({page:index+1,method:'pdf_text'}));
    for(const pageNumber of ocrPages){
      signal.throwIfAborted();
      const pageDeadline=new AbortController(),pageSignal=AbortSignal.any([signal,pageDeadline.signal]);
      const pageTimer=setTimeout(()=>pageDeadline.abort(),config.pageTimeoutMs);
      const path=join(directory,input.type==='pdf'?'page.pgm':'page.png');
      try{
        if(input.type==='pdf'){
          const {width,height}=dimensions[pageNumber-1];
          if(!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0||width>14400||height>14400)throw new OcrFailure('limit');
          const scale=Math.min(config.dpi/72,config.maxEdge/Math.max(width,height),Math.sqrt(config.maxPixels/(width*height)));
          const w=Math.max(1,Math.floor(width*scale)),h=Math.max(1,Math.floor(height*scale));
          // One grayscale raster at a time; no document-derived paths or command strings.
          await runOcrCommand('pdftoppm',['-f',String(pageNumber),'-l',String(pageNumber),'-singlefile','-gray',
            '-r',String(config.dpi),'-scale-to-x',String(w),'-scale-to-y',String(h),input.path,join(directory,'page')],directory,pageSignal,config);
          await chmod(path,0o600);
        }else await normalizeImage(input,path,pageSignal,config);
        if((await stat(path)).size>config.maxTempBytes)throw new OcrFailure('limit');
        const recognized=parseOcrTsv(await runOcrCommand('tesseract',[path,'stdout','-l','eng','--oem','1','--psm','3','tsv'],directory,pageSignal,config));
        pageTexts[pageNumber-1]=recognized.text;
        pages[pageNumber-1]={page:pageNumber,method:'ocr',...(recognized.confidence!==undefined?{confidence:recognized.confidence}:{})};
        const text=pageTexts.join('\n\n');if([...text].length>config.maxTextCharacters||Buffer.byteLength(text)>4194304)throw new OcrFailure('limit');
      }catch(error){if(pageDeadline.signal.aborted&&!signal.aborted)throw new OcrFailure('timeout');throw error;}
      finally{clearTimeout(pageTimer);await rm(path,{force:true});}
    }
    const result:ExtractionResult={text:pageTexts.join('\n\n'),method:ocrPages.length===pageCount?'ocr':'mixed',
      extractor:{name:'Tesseract'+(input.type==='pdf'?' / Poppler / PDF.js':''),version:`${tessVersion}${popplerVersion?` / ${popplerVersion} / ${pdfVersion}`:''}`},
      source:{sha256,pageCount,pages}};
    validateExtraction(result);signal.throwIfAborted();return result;
  }catch(error){
    if(deadline.signal.aborted)throw new OcrFailure('timeout');if(external.aborted)throw new OcrFailure('cancelled');
    if(error instanceof ProcessorFailure)throw error;
    throw new OcrFailure('invalid');
  }finally{clearTimeout(timer);try{if(directory)await rm(directory,{recursive:true,force:true});}finally{active--;}}
}
