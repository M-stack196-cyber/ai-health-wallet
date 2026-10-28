import {getOcrConfig,getDigitalPdfConfig,type OcrConfig,type DigitalPdfConfig} from './config.js';
import {extractDocumentText} from './ocr.js';
import type {DocumentProcessor} from './worker.js';
import {getOriginalScope} from './retrieval.js';

// Explicit opt-in; app/server do not import or schedule this processor.
export function createOcrProcessor(config:OcrConfig=getOcrConfig(),pdfConfig:DigitalPdfConfig=getDigitalPdfConfig()):DocumentProcessor {
  return async({withOriginal,persistExtraction,signal})=>{
    const result=await withOriginal(async input=>{
      await input.assertActive();
      const scope=getOriginalScope(input);
      const work=extractDocumentText(input,AbortSignal.any([signal,...(scope?[scope.signal]:[])]),config,pdfConfig);
      scope?.waitForCleanup(work);
      const output=await work;await input.assertActive();return output;
    });
    signal.throwIfAborted();await persistExtraction(result);
  };
}
