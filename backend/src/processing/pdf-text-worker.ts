import {parentPort,workerData} from "node:worker_threads";
import {open} from "node:fs/promises";
import {constants} from "node:fs";
import {createHash} from "node:crypto";

// Standalone Node 24 worker: no runtime configuration, credentials, DB or S3.
const {path,expectedBytes,limits}=workerData as {path:string;expectedBytes:number;limits:{maxFileBytes:number;maxPages:number;maxTextCharacters:number;maxTextItems:number}};
class Rejected extends Error {
  readonly reason:"limit"|"unsupported"|"parse";
  constructor(reason:"limit"|"unsupported"|"parse"){super();this.reason=reason;}
}
const entries=(value:unknown)=>value instanceof Map?value.size>0:!!value&&typeof value==="object"&&Object.keys(value).length>0;
async function run(){
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  let bytes:Buffer;
  try{
    const info=await file.stat();
    if(!info.isFile()||!info.size||info.size!==expectedBytes)throw new Rejected("parse");
    if(info.size>limits.maxFileBytes)throw new Rejected("limit");
    const buffer=Buffer.alloc(info.size+1);let offset=0;
    while(offset<buffer.length){const read=await file.read(buffer,offset,buffer.length-offset,null);if(!read.bytesRead)break;offset+=read.bytesRead;}
    if(offset!==info.size)throw new Rejected("parse");
    bytes=buffer.subarray(0,offset);
  }finally{await file.close();}
  if(!/^%PDF-[12]\.\d/.test(bytes.subarray(0,8).toString("ascii"))||!/%%EOF\s*$/.test(bytes.subarray(-1024).toString("latin1")))throw new Rejected("parse");
  const start=/startxref\s+(\d+)\s+%%EOF\s*$/.exec(bytes.subarray(-1024).toString("latin1"));
  const offset=start?Number(start[1]):-1;
  if(!Number.isSafeInteger(offset)||offset<8||offset>=bytes.length)throw new Rejected("parse");
  const xref=bytes.subarray(offset,offset+1024).toString("latin1");
  if(!xref.startsWith("xref")&&!(/^\d+\s+\d+\s+obj\b/.test(xref)&&/\/Type\s*\/XRef\b/.test(xref.split("stream")[0])))throw new Rejected("parse");
  const sha256=createHash("sha256").update(bytes).digest("hex");
  const {getDocument,version}=await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task=getDocument({data:new Uint8Array(bytes),verbosity:0,stopAtErrors:true,
    useSystemFonts:false,disableFontFace:true,useWorkerFetch:false,enableXfa:false,
    isOffscreenCanvasSupported:false,isImageDecoderSupported:false,maxImageSize:0});
  try{
    const pdf=await task.promise;
    if(pdf.numPages<1||pdf.numPages>limits.maxPages)throw new Rejected("limit");
    if(pdf.isPureXfa||entries(await pdf.getJSActions())||entries(await pdf.getAttachments()))throw new Rejected("unsupported");
    const metadata=await pdf.getMetadata();
    const info=metadata.info as Record<string,unknown>;
    if(info.IsXFAPresent||info.IsAcroFormPresent)throw new Rejected("unsupported");
    const pageTexts:string[]=[],ocrPages:number[]=[],pageDimensions:{width:number;height:number}[]=[];
    let characters=0,textBytes=0,items=0;
    const count=(text:string)=>{
      if(text.length>limits.maxTextCharacters*2)throw new Rejected("limit");
      characters+=[...text].length;textBytes+=Buffer.byteLength(text,"utf8");
      if(characters>limits.maxTextCharacters||textBytes>4194304)throw new Rejected("limit");
    };
    for(let pageNumber=1;pageNumber<=pdf.numPages;pageNumber++){
      const page=await pdf.getPage(pageNumber);
      const viewport=page.getViewport({scale:1});pageDimensions.push({width:viewport.width,height:viewport.height});
      try{
        if(page.isPureXfa||entries(await page.getJSActions()))throw new Rejected("unsupported");
        const stream=page.streamTextContent({includeMarkedContent:false,disableNormalization:true});
        const reader=stream.getReader();const fragments:string[]=[];
        try{
          for(;;){const chunk=await reader.read();if(chunk.done)break;
            for(const item of chunk.value.items){
              if(++items>limits.maxTextItems)throw new Rejected("limit");
              if(typeof item.str!=="string")continue;
              if(item.str.includes("\ufffd"))throw new Rejected("unsupported");
              count(item.str);fragments.push(item.str);
              if(item.hasEOL){count("\n");fragments.push("\n");}
            }
          }
        }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
        const text=fragments.join("").replace(/\n+$/u,"");
        if(!/[\p{L}\p{N}]/u.test(text))ocrPages.push(pageNumber);
        if(pageNumber>1)count("\n\n");
        pageTexts.push(text);
      }finally{page.cleanup();}
    }
    if(ocrPages.length)return {kind:"ocr_required",pageCount:pdf.numPages,pages:ocrPages,sourceSha256:sha256,pageTexts,pageDimensions,pdfVersion:version};
    return {kind:"extracted",pageTexts,result:{text:pageTexts.join("\n\n"),method:"pdf_text",extractor:{name:"PDF.js",version},
      source:{sha256,pageCount:pdf.numPages,pages:pageTexts.map((_text,index)=>({page:index+1,method:"pdf_text"}))}}};
  }finally{await task.destroy();}
}
try{parentPort?.postMessage(await run());}
catch(error){parentPort?.postMessage({kind:"error",reason:error instanceof Rejected?error.reason:"parse"});}
