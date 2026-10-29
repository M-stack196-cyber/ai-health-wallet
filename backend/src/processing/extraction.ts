import {InvalidExtractionResult} from "./errors.js";

export const extractionLimits=Object.freeze({textCharacters:1000000,textBytes:4194304,metadataBytes:8192,pages:200});
export type ExtractionMethod="pdf_text"|"ocr"|"mixed";
export interface ExtractionResult {
  pipeline?:import("./python-processor.js").PythonEvidence;
  text:string;
  method:ExtractionMethod;
  extractor:{name:string;version:string};
  source:{sha256:string;pageCount:number;pages:{page:number;method:"pdf_text"|"ocr";confidence?:number}[]};
}
export interface ValidatedExtraction {text:string;metadata:Record<string,unknown>;version:string;}
function invalid():never{throw new InvalidExtractionResult();}
function object(value:unknown,keys:string[]):Record<string,unknown>{
  if(!value||typeof value!=="object"||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype)invalid();
  const result=value as Record<string,unknown>;
  if(Object.keys(result).some(key=>!keys.includes(key)))invalid();return result;
}
export function validateExtraction(input:unknown):ValidatedExtraction {
  const value=object(input,["text","method","extractor","source"]);
  const text=value.text;
  if(typeof text!=="string"||text.length>extractionLimits.textCharacters*2||!text.trim()
    ||Buffer.byteLength(text,"utf8")>extractionLimits.textBytes||[...text].length>extractionLimits.textCharacters
    ||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)||/[\ud800-\udfff]/u.test(text))invalid();
  if(!["pdf_text","ocr","mixed"].includes(value.method as string))invalid();
  const extractor=object(value.extractor,["name","version"]);
  const name=extractor.name,version=extractor.version;
  if(typeof name!=="string"||!/^[A-Za-z0-9][A-Za-z0-9.+_:/ -]{0,63}$/.test(name)
    ||typeof version!=="string"||!/^[A-Za-z0-9][A-Za-z0-9.+_:/ -]{0,127}$/.test(version))invalid();
  const source=object(value.source,["sha256","pageCount","pages"]);
  if(typeof source.sha256!=="string"||!/^[0-9a-f]{64}$/.test(source.sha256)||!Number.isSafeInteger(source.pageCount)
    ||(source.pageCount as number)<1||(source.pageCount as number)>extractionLimits.pages||!Array.isArray(source.pages)||source.pages.length!==source.pageCount)invalid();
  const methods=new Set<string>();
  const pages=source.pages.map((raw,index)=>{
    const page=object(raw,["page","method","confidence"]);
    if(page.page!==index+1||!["pdf_text","ocr"].includes(page.method as string))invalid();
    methods.add(page.method as string);
    if(Object.hasOwn(page,"confidence")&&(page.method!=="ocr"||typeof page.confidence!=="number"||!Number.isFinite(page.confidence)||page.confidence<0||page.confidence>100))invalid();
    return {page:page.page,method:page.method,...(Object.hasOwn(page,"confidence")?{confidence:page.confidence}:{})};
  });
  if(value.method==="mixed"?methods.size!==2:methods.size!==1||!methods.has(value.method as string))invalid();
  const metadata={schemaVersion:1,method:value.method,extractor:{name,version},source:{sha256:source.sha256,pageCount:source.pageCount,pages}};
  if(Buffer.byteLength(JSON.stringify(metadata),"utf8")>extractionLimits.metadataBytes)invalid();
  return {text,metadata,version};
}
