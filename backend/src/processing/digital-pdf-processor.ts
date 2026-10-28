import {getDigitalPdfConfig,type DigitalPdfConfig} from "./config.js";
import {extractDigitalPdf,OcrRequired} from "./pdf-text.js";
import type {DocumentProcessor} from "./worker.js";

// Deliberately not imported by app/server: explicit opt-in only.
export function createDigitalPdfProcessor(config:DigitalPdfConfig=getDigitalPdfConfig()):DocumentProcessor {
  return async({withOriginal,persistExtraction,signal})=>{
    const output=await withOriginal(async input=>{
      await input.assertActive();
      const result=await extractDigitalPdf(input,signal,config);
      await input.assertActive();
      return result;
    });
    signal.throwIfAborted();
    if(output.kind==="ocr_required")throw new OcrRequired();
    // The temporary input scope has now closed; DB fencing remains authoritative.
    await persistExtraction(output.result);
  };
}
