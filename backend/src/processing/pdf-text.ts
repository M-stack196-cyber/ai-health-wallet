import {Worker} from "node:worker_threads";
import {getDigitalPdfConfig,type DigitalPdfConfig} from "./config.js";
import {extractionLimits,validateExtraction,type ExtractionResult} from "./extraction.js";
import {ProcessorFailure} from "./errors.js";
import type {OriginalInput} from "./retrieval.js";

export type PdfTextOutcome={kind:"extracted";result:ExtractionResult;pageTexts:string[]}
  |{kind:"ocr_required";pageCount:number;pages:number[];sourceSha256:string;pageTexts:string[];pageDimensions:{width:number;height:number}[];pdfVersion:string};
export class PdfTextFailure extends ProcessorFailure {
  constructor(readonly reason:"limit"|"unsupported"|"parse"|"timeout"|"cancelled"|"busy"){
    super(reason==="timeout"?"PROCESSOR_TIMEOUT":reason==="cancelled"?"INTERRUPTED":reason==="busy"?"PROCESSOR_FAILED":"INVALID_INPUT",["timeout","cancelled","busy"].includes(reason));
    this.message="Digital PDF extraction could not be completed.";
  }
}
export class OcrRequired extends ProcessorFailure {
  readonly reason="ocr_required";
  constructor(){super("INVALID_INPUT",false);this.message="Document requires OCR before extraction can complete.";}
}
let active=0;
function checkLimits(config:DigitalPdfConfig){
  for(const[value,min,max]of [[config.maxFileBytes,1,20971520],[config.maxPages,1,extractionLimits.pages],
    [config.maxTextCharacters,1,extractionLimits.textCharacters],[config.maxTextItems,1,200000],
    [config.timeoutMs,1,30000],[config.maxConcurrentExtractions,1,4]]){
    if(!Number.isSafeInteger(value)||value<min||value>max)throw new PdfTextFailure("limit");
  }
}
export async function extractDigitalPdf(input:Pick<OriginalInput,"path"|"type"|"bytes">,signal:AbortSignal,config:DigitalPdfConfig=getDigitalPdfConfig()):Promise<PdfTextOutcome>{
  checkLimits(config);
  if(signal.aborted)throw new PdfTextFailure("cancelled");
  if(input.type!=="pdf")throw new PdfTextFailure("unsupported");
  if(!Number.isSafeInteger(input.bytes)||input.bytes<1||input.bytes>config.maxFileBytes)throw new PdfTextFailure("limit");
  if(active>=config.maxConcurrentExtractions)throw new PdfTextFailure("busy");
  active++;
  let worker:Worker|undefined,timer:ReturnType<typeof setTimeout>|undefined,abort:(()=>void)|undefined;
  try{
    const url=new URL(import.meta.url.endsWith(".ts")?"./pdf-text-worker.ts":"./pdf-text-worker.js",import.meta.url);
    worker=new Worker(url,{execArgv:[],env:{},workerData:{path:input.path,expectedBytes:input.bytes,limits:config},
      resourceLimits:{maxOldGenerationSizeMb:128,maxYoungGenerationSizeMb:16},stdout:true,stderr:true});
    worker.stdout.resume();worker.stderr.resume();
    const message=await new Promise<unknown>((resolve,reject)=>{
      timer=setTimeout(()=>reject(new PdfTextFailure("timeout")),config.timeoutMs);
      abort=()=>reject(new PdfTextFailure("cancelled"));signal.addEventListener("abort",abort,{once:true});
      worker!.once("message",resolve);worker!.once("error",()=>reject(new PdfTextFailure("parse")));
      worker!.once("exit",()=>reject(new PdfTextFailure("parse")));if(signal.aborted)abort();
    });
    if(signal.aborted)throw new PdfTextFailure("cancelled");
    const value=message as PdfTextOutcome|{kind:"error";reason:"limit"|"unsupported"|"parse"};
    if(value?.kind==="error")throw new PdfTextFailure(value.reason);
    if(value?.kind==="ocr_required")return value;
    if(value?.kind!=="extracted")throw new PdfTextFailure("parse");
    validateExtraction(value.result);
    return value;
  }catch(error){if(error instanceof ProcessorFailure)throw error;throw new PdfTextFailure("parse");}
  finally{
    if(timer)clearTimeout(timer);if(abort)signal.removeEventListener("abort",abort);
    try{if(worker)await worker.terminate();}finally{active--;}
  }
}
