import "../config/env.js";
export class ProcessingConfigurationError extends Error {}
export interface ProcessingConfig {
  maxAttempts: number; leaseMs: number; attemptTimeoutMs: number; heartbeatMs: number;
  retryBaseMs: number; retryMaxMs: number; recoveryBatchSize: number;
}
export function getProcessingConfig(): ProcessingConfig {
  const number = (key: string, fallback: number, min: number, max: number) => {
    const raw=process.env[key]??String(fallback);const value=Number(raw);
    if(!/^\d+$/.test(raw)||!Number.isSafeInteger(value)||value<min||value>max) throw new ProcessingConfigurationError(key+" is outside its permitted range.");
    return value;
  };
  const config={maxAttempts:number("PROCESSING_MAX_ATTEMPTS",3,1,5),
    leaseMs:number("PROCESSING_LEASE_MS",60000,1000,300000),
    attemptTimeoutMs:number("PROCESSING_ATTEMPT_TIMEOUT_MS",300000,1000,900000),
    heartbeatMs:number("PROCESSING_HEARTBEAT_MS",15000,100,60000),
    retryBaseMs:number("PROCESSING_RETRY_BASE_MS",30000,1000,300000),
    retryMaxMs:number("PROCESSING_RETRY_MAX_MS",300000,1000,3600000),
    recoveryBatchSize:number("PROCESSING_RECOVERY_BATCH_SIZE",50,1,100)};
  if(config.heartbeatMs*2>=config.leaseMs||config.attemptTimeoutMs<config.leaseMs||config.retryMaxMs<config.retryBaseMs) {
    throw new ProcessingConfigurationError("Processing heartbeat, lease, attempt or retry intervals are inconsistent.");
  }
  return config;
}

export interface RetrievalConfig {
  maxDownloadBytes:number; downloadTimeoutMs:number; leaseCheckIntervalMs:number; maxConcurrentRetrievals:number;
}
export function getRetrievalConfig():RetrievalConfig {
  const integer=(key:string,fallback:number,min:number,max:number)=>{
    const raw=process.env[key]??String(fallback);const value=Number(raw);
    if(!/^\d+$/.test(raw)||!Number.isSafeInteger(value)||value<min||value>max)throw new ProcessingConfigurationError(key+" is outside its permitted range.");
    return value;
  };
  return {maxDownloadBytes:integer("PROCESSING_MAX_DOWNLOAD_BYTES",5242880,1024,20971520),
    downloadTimeoutMs:integer("PROCESSING_DOWNLOAD_TIMEOUT_MS",15000,1000,30000),
    leaseCheckIntervalMs:integer("PROCESSING_LEASE_CHECK_INTERVAL_MS",1000,100,5000),
    maxConcurrentRetrievals:integer("PROCESSING_MAX_CONCURRENT_RETRIEVALS",2,1,4)};
}

export interface DigitalPdfConfig {
  maxFileBytes:number;maxPages:number;maxTextCharacters:number;maxTextItems:number;timeoutMs:number;maxConcurrentExtractions:number;
}
export function getDigitalPdfConfig():DigitalPdfConfig {
  const integer=(key:string,fallback:number,min:number,max:number)=>{
    const raw=process.env[key]??String(fallback),value=Number(raw);
    if(!/^\d+$/.test(raw)||!Number.isSafeInteger(value)||value<min||value>max)throw new ProcessingConfigurationError(key+" is outside its permitted range.");
    return value;
  };
  return {maxFileBytes:integer("PDF_TEXT_MAX_FILE_BYTES",5242880,1024,20971520),
    maxPages:integer("PDF_TEXT_MAX_PAGES",100,1,200),maxTextCharacters:integer("PDF_TEXT_MAX_CHARACTERS",1000000,1,1000000),
    maxTextItems:integer("PDF_TEXT_MAX_ITEMS",100000,1,200000),timeoutMs:integer("PDF_TEXT_TIMEOUT_MS",10000,1000,30000),
    maxConcurrentExtractions:integer("PDF_TEXT_MAX_CONCURRENCY",2,1,4)};
}

export interface OcrConfig {
  maxPages:number;maxFileBytes:number;maxTextCharacters:number;maxConcurrency:number;
  dpi:number;maxEdge:number;maxPixels:number;maxTempBytes:number;
  pageTimeoutMs:number;documentTimeoutMs:number;cpuSeconds:number;memoryBytes:number;maxOutputBytes:number;
}
export function getOcrConfig():OcrConfig {
  const integer=(key:string,fallback:number,min:number,max:number)=>{
    const raw=process.env[key]??String(fallback),value=Number(raw);
    if(!/^\d+$/.test(raw)||!Number.isSafeInteger(value)||value<min||value>max)throw new ProcessingConfigurationError(key+" is outside its permitted range.");
    return value;
  };
  return {maxPages:integer('OCR_MAX_PAGES',50,1,200),maxFileBytes:integer('OCR_MAX_FILE_BYTES',5242880,1024,20971520),
    maxTextCharacters:integer('OCR_MAX_CHARACTERS',1000000,1,1000000),maxConcurrency:integer('OCR_MAX_CONCURRENCY',1,1,2),
    dpi:integer('OCR_DPI',200,72,300),maxEdge:integer('OCR_MAX_EDGE',3000,256,4000),maxPixels:integer('OCR_MAX_PIXELS',9000000,65536,16000000),
    maxTempBytes:integer('OCR_MAX_TEMP_BYTES',16777216,1024,33554432),pageTimeoutMs:integer('OCR_PAGE_TIMEOUT_MS',20000,100,60000),
    documentTimeoutMs:integer('OCR_DOCUMENT_TIMEOUT_MS',120000,1000,240000),cpuSeconds:integer('OCR_CPU_SECONDS',15,1,30),
    memoryBytes:integer('OCR_MEMORY_BYTES',536870912,67108864,1073741824),maxOutputBytes:integer('OCR_MAX_OUTPUT_BYTES',4194304,1024,8388608)};
}
