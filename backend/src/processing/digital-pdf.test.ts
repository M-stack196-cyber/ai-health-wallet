import assert from "node:assert/strict";
import {createHash,randomUUID} from "node:crypto";
import {createRequire} from "node:module";
import {mkdtemp,writeFile,readFile,rm,readdir,access} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {test} from "node:test";
import {Readable} from "node:stream";
import {S3Client} from "@aws-sdk/client-s3";
import {syntheticDigitalPdf} from "./fixtures/pdf-fixtures.js";
import {extractDigitalPdf,PdfTextFailure,OcrRequired,type PdfTextOutcome} from "./pdf-text.js";
import {createDigitalPdfProcessor} from "./digital-pdf-processor.js";
import {getDigitalPdfConfig,ProcessingConfigurationError,type DigitalPdfConfig,type ProcessingConfig} from "./config.js";
import {validateExtraction} from "./extraction.js";
import {createProcessingRepository,type Claim} from "./repository.js";
import {createProcessingService} from "./service.js";
import {createProcessingWorker} from "./worker.js";
import {createOriginalAccess} from "./retrieval.js";
import {createS3Storage} from "../documents/storage.js";
import {getDocumentConfig,type S3StorageConfig} from "../config/documents.js";
import {pool,closeDatabasePool} from "../database/pool.js";
import {InvalidProcessingClaim} from "./errors.js";

const config:DigitalPdfConfig={maxFileBytes:5242880,maxPages:100,maxTextCharacters:1000000,maxTextItems:100000,timeoutMs:10000,maxConcurrentExtractions:2};
const lifecycle:ProcessingConfig={maxAttempts:3,leaseMs:60000,attemptTimeoutMs:300000,heartbeatMs:15000,retryBaseMs:1000,retryMaxMs:10000,recoveryBatchSize:10};
const require=createRequire(import.meta.url),pdfVersion=(require('pdfjs-dist/package.json') as {version:string}).version;
const signal=()=>new AbortController().signal;
function extracted(outcome:PdfTextOutcome){assert.equal(outcome.kind,'extracted');if(outcome.kind!=='extracted')throw new Error('Synthetic PDF should have embedded text');return outcome;}

test('Phase 2.2C-B digital PDF text extraction',{timeout:180000},async t=>{
 const directory=await mkdtemp(join(tmpdir(),'health-wallet-pdf-text-test-'));
 const patients:string[]=[],documents:string[]=[];
 const temps=new Set((await readdir(tmpdir())).filter(n=>n.startsWith('health-wallet-processing-')));
 async function input(bytes:Buffer,type:'pdf'|'png'='pdf'){
   const path=join(directory,randomUUID()+'.bin');await writeFile(path,bytes,{mode:0o600});return {path,type,bytes:bytes.length};
 }
 async function parse(bytes:Buffer,options:Partial<DigitalPdfConfig>={}){return extractDigitalPdf(await input(bytes),signal(),{...config,...options});}
 async function fixture(bytes=syntheticDigitalPdf([['Synthetic Digital Report','Glucose 90 mg/dL'],['Synthetic Followup','No clinical interpretation']])){
   const patientId=randomUUID(),documentId=randomUUID();patients.push(patientId);
   await pool.query(`INSERT INTO public.patients(id,email,password_hash,full_name) VALUES($1,$2,$3,'Synthetic Digital PDF Patient')`,[patientId,patientId+'@example.invalid','$argon2id$v=19$m=65536,t=3,p=1$syntheticSalt$syntheticHashNotAnActualPassword']);
   const aws:S3StorageConfig={bucket:'synthetic-digital-pdf-originals',prefix:'medical-documents/',region:'us-east-1',ownerAccountId:'000000000000',encryption:'AES256'};
   const key=aws.prefix+randomUUID()+'.pdf';
   await pool.query(`INSERT INTO public.medical_documents(id,patient_id,s3_bucket,s3_object_key,original_filename,file_type,category)
     VALUES($1,$2,$3,$4,'synthetic.pdf','pdf','lab_report')`,[documentId,patientId,aws.bucket,key]);documents.push(documentId);
   const service=createProcessingService(createProcessingRepository(pool,lifecycle,patientId));
   let gets=0,observedPath='',corrupt=false;
   const metadata={ContentLength:bytes.length,ContentType:'application/pdf',ServerSideEncryption:'AES256',VersionId:'synthetic-version',ETag:'"synthetic-etag"'};
   const client={async send(command:{constructor:{name:string};input:Record<string,unknown>}){
     assert.equal(command.input.Bucket,aws.bucket);assert.equal(command.input.ExpectedBucketOwner,aws.ownerAccountId);
     switch(command.constructor.name){
       case 'GetPublicAccessBlockCommand':return {PublicAccessBlockConfiguration:{BlockPublicAcls:true,IgnorePublicAcls:true,BlockPublicPolicy:true,RestrictPublicBuckets:true}};
       case 'GetBucketPolicyStatusCommand':return {PolicyStatus:{IsPublic:false}};
       case 'GetBucketOwnershipControlsCommand':return {OwnershipControls:{Rules:[{ObjectOwnership:'BucketOwnerEnforced'}]}};
       case 'GetBucketEncryptionCommand':return {ServerSideEncryptionConfiguration:{Rules:[{ApplyServerSideEncryptionByDefault:{SSEAlgorithm:'AES256'}}]}};
       case 'HeadObjectCommand':assert.equal(command.input.Key,key);return metadata;
       case 'GetObjectCommand':gets++;return {...metadata,Body:Readable.from([corrupt?Buffer.alloc(bytes.length):bytes])};
       default:throw new Error('Unexpected mocked AWS operation');
     }
   }} as unknown as S3Client;
   const storage=createS3Storage(aws,{client,presign:async()=>{throw new Error('Digital processing must not presign');}});
   const original=createOriginalAccess(service,storage,getDocumentConfig(),{maxDownloadBytes:5242880,downloadTimeoutMs:15000,leaseCheckIntervalMs:100,maxConcurrentRetrievals:2});
   const originals={async withOriginal<T>(claim:Claim,abortSignal:AbortSignal,use:Parameters<typeof original.withOriginal<T>>[2]):Promise<T>{return original.withOriginal(claim,abortSignal,async value=>{observedPath=value.path;return use(value);});}};
   const row=async()=>(await pool.query('SELECT * FROM public.extracted_medical_text WHERE document_id=$1 AND patient_id=$2',[documentId,patientId])).rows[0];
   const state=async()=>(await pool.query('SELECT state FROM public.document_processing_jobs WHERE document_id=$1 AND patient_id=$2',[documentId,patientId])).rows[0].state;
   return {patientId,documentId,service,storage,originals,row,state,gets:()=>gets,path:()=>observedPath,corrupt:()=>{corrupt=true;}};
 }
 try{
   await t.test('single-page embedded text is genuinely extracted with exact source provenance',async()=>{
     const bytes=syntheticDigitalPdf([['Synthetic Medical Report','Hemoglobin 13 g/dL']]);const output=extracted(await parse(bytes));
     assert.equal(output.result.text,'Synthetic Medical Report\nHemoglobin 13 g/dL');assert.equal(output.result.method,'pdf_text');
     assert.deepEqual(output.result.extractor,{name:'PDF.js',version:pdfVersion});assert.equal(output.result.source.sha256,createHash('sha256').update(bytes).digest('hex'));
     assert.equal(output.result.source.pageCount,1);assert.deepEqual(output.result.source.pages,[{page:1,method:'pdf_text'}]);validateExtraction(output.result);
   });
   await t.test('multipage order, line breaks and page boundaries are preserved without labels',async()=>{
     const output=extracted(await parse(syntheticDigitalPdf([['Synthetic First Page','First second line'],['Synthetic Second Page'],['Synthetic Third Page']])));
     assert.deepEqual(output.pageTexts,['Synthetic First Page\nFirst second line','Synthetic Second Page','Synthetic Third Page']);
     assert.equal(output.result.text,output.pageTexts.join('\n\n'));assert.deepEqual(output.result.source.pages,[1,2,3].map(page=>({page,method:'pdf_text'})));
   });
   await t.test('ToUnicode maps preserve Unicode characters rather than placeholder text',async()=>{
     const text='Synthetic café Ω 漢字 🧪';const output=extracted(await parse(syntheticDigitalPdf([[text]],{unicode:true})));assert.equal(output.result.text,text);
   });
   await t.test('source SHA-256 comes from the actual unmodified PDF bytes',async()=>{
     const bytes=syntheticDigitalPdf([['Synthetic stable original']]);const value=await input(bytes);const output=extracted(await extractDigitalPdf(value,signal(),config));
     assert.equal(output.result.source.sha256,createHash('sha256').update(await readFile(value.path)).digest('hex'));assert.deepEqual(await readFile(value.path),bytes);
   });
   await t.test('blank and image-only PDFs explicitly require OCR with no result text',async()=>{
     for(const bytes of [syntheticDigitalPdf([[]]),syntheticDigitalPdf([[]],{imageOnly:true})]){
       const output=await parse(bytes);assert.equal(output.kind,'ocr_required');if(output.kind==='ocr_required'){assert.equal(output.pageCount,1);assert.deepEqual(output.pages,[1]);assert.equal(output.sourceSha256,createHash('sha256').update(bytes).digest('hex'));assert.ok(!('result'in output));}
     }
   });
   await t.test('mixed text and textless pages require OCR rather than partial successful evidence',async()=>{
     const output=await parse(syntheticDigitalPdf([['Synthetic digital text'],[]]));assert.equal(output.kind,'ocr_required');if(output.kind==='ocr_required')assert.deepEqual(output.pages,[2]);
   });
   await t.test('malformed, truncated and repaired-xref candidates are safely rejected',async()=>{
     const good=syntheticDigitalPdf([['Synthetic']]);for(const bytes of [Buffer.from('not a PDF'),good.subarray(0,good.length-10),Buffer.from(good.toString().replace(/startxref\s+\d+/,'startxref\n9'))])await assert.rejects(parse(bytes),e=>e instanceof PdfTextFailure&&e.reason==='parse');
   });
   await t.test('PDF.js page parsing failures produce safe errors with no raw PDF text',async()=>{
     await assert.rejects(parse(syntheticDigitalPdf([['Synthetic secret fixture']],{brokenPage:true})),e=>e instanceof PdfTextFailure&&!e.message.includes('secret')&&!e.message.includes('Catalog'));
   });
   await t.test('active JavaScript, embedded attachments and form documents are unsupported',async()=>{
     for(const options of [{javascript:true},{attachment:true},{form:true}])await assert.rejects(parse(syntheticDigitalPdf([['Synthetic protected feature']],options)),e=>e instanceof PdfTextFailure&&e.reason==='unsupported');
   });
   await t.test('non-PDF originals are rejected without OCR or image rendering',async()=>{
     await assert.rejects(extractDigitalPdf(await input(Buffer.from('synthetic image'),'png'),signal(),config),e=>e instanceof PdfTextFailure&&e.reason==='unsupported');
   });
   await t.test('file byte limit and changed file size are enforced',async()=>{
     const bytes=syntheticDigitalPdf([['Synthetic']]);await assert.rejects(parse(bytes,{maxFileBytes:bytes.length-1}),e=>e instanceof PdfTextFailure&&e.reason==='limit');
     const value=await input(bytes);await writeFile(value.path,Buffer.concat([bytes,Buffer.from('extra')]));await assert.rejects(extractDigitalPdf(value,signal(),config),PdfTextFailure);
   });
   await t.test('actual PDF page counts enforce configured limits',async()=>{
     await assert.rejects(parse(syntheticDigitalPdf([['One'],['Two'],['Three']]),{maxPages:2}),e=>e instanceof PdfTextFailure&&e.reason==='limit');
   });
   await t.test('extracted characters and text item counts are bounded before persistence',async()=>{
     await assert.rejects(parse(syntheticDigitalPdf([['Synthetic '.repeat(30)]]),{maxTextCharacters:20}),e=>e instanceof PdfTextFailure&&e.reason==='limit');
     await assert.rejects(parse(syntheticDigitalPdf([['First line','Second line','Third line']]),{maxTextItems:1}),e=>e instanceof PdfTextFailure&&e.reason==='limit');
   });
   await t.test('pre-aborted calls never spawn a successful parser',async()=>{
     const controller=new AbortController();controller.abort();await assert.rejects(extractDigitalPdf(await input(syntheticDigitalPdf([['Synthetic']])),controller.signal,config),e=>e instanceof PdfTextFailure&&e.reason==='cancelled');
   });
   await t.test('timeout terminates the parsing worker and releases its admission slot',async()=>{
     const value=await input(syntheticDigitalPdf([['Synthetic']]));await assert.rejects(extractDigitalPdf(value,signal(),{...config,timeoutMs:1}),e=>e instanceof PdfTextFailure&&e.reason==='timeout');assert.equal((await extractDigitalPdf(value,signal(),config)).kind,'extracted');
   });
   await t.test('mid-request cancellation terminates parsing and permits later work',async()=>{
     const value=await input(syntheticDigitalPdf([['Synthetic']]));const controller=new AbortController();const operation=extractDigitalPdf(value,controller.signal,config);const timer=setTimeout(()=>controller.abort(),10);
     try{await assert.rejects(operation,e=>e instanceof PdfTextFailure&&e.reason==='cancelled');}finally{clearTimeout(timer);}assert.equal((await extractDigitalPdf(value,signal(),config)).kind,'extracted');
   });
   await t.test('concurrent extraction admission is bounded',async()=>{
     const value=await input(syntheticDigitalPdf([['Synthetic']]));const options={...config,maxConcurrentExtractions:1};const first=extractDigitalPdf(value,signal(),options);
     await assert.rejects(extractDigitalPdf(value,signal(),options),e=>e instanceof PdfTextFailure&&e.reason==='busy');assert.equal((await first).kind,'extracted');
   });
   await t.test('worker performs secure retrieval, closes temporary input, then persists actual PDF text',async()=>{
     const f=await fixture();let persistedAfterCleanup=false;
     const service={...f.service,persistExtraction:async(claim:Claim,result:unknown)=>{await assert.rejects(access(f.path()));persistedAfterCleanup=true;return f.service.persistExtraction(claim,result);}};
     assert.equal(await createProcessingWorker(service,lifecycle,createDigitalPdfProcessor(config),f.originals).runOnce(),'completed');
     const row=await f.row();assert.equal(row.extracted_text,'Synthetic Digital Report\nGlucose 90 mg/dL\n\nSynthetic Followup\nNo clinical interpretation');assert.equal(row.source_metadata.method,'pdf_text');assert.equal(row.source_metadata.source.pageCount,2);assert.equal(row.extractor_version,pdfVersion);assert.equal(persistedAfterCleanup,true);assert.equal(await f.state(),'completed');assert.equal(f.gets(),1);
   });
   await t.test('processor is explicitly opt-in and no duplicate work runs after completion',async()=>{
     const f=await fixture();const inactive=createProcessingWorker(f.service,lifecycle,undefined,f.originals);assert.equal(await inactive.runOnce(),'disabled');assert.equal(f.gets(),0);
     const processor=createDigitalPdfProcessor(config);const workers=[createProcessingWorker(f.service,lifecycle,processor,f.originals),createProcessingWorker(f.service,lifecycle,processor,f.originals)];
     const outcomes=await Promise.all(workers.map(w=>w.runOnce()));assert.deepEqual(outcomes.sort(),['completed','idle']);assert.equal(f.gets(),1);assert.equal(await workers[0].runOnce(),'idle');
   });
   await t.test('OCR-required documents do not persist placeholders or complete a job',async()=>{
     const f=await fixture(syntheticDigitalPdf([[]],{imageOnly:true}));assert.equal(await createProcessingWorker(f.service,lifecycle,createDigitalPdfProcessor(config),f.originals).runOnce(),'failed');assert.equal(await f.row(),undefined);assert.equal(await f.state(),'failed');await assert.rejects(access(f.path()));
     let persisted=false;const value=await input(syntheticDigitalPdf([[]]));await assert.rejects(createDigitalPdfProcessor(config)({claim:{documentId:randomUUID(),patientId:randomUUID(),token:randomUUID()},attempt:1,signal:signal(),withOriginal:async use=>use({...value,assertActive:async()=>{}}),persistExtraction:async()=>{persisted=true;}}),OcrRequired);assert.equal(persisted,false);
   });
   await t.test('lease loss detected inside the input scope prevents persistence',async()=>{
     const value=await input(syntheticDigitalPdf([['Synthetic']]));let checks=0,persisted=false;
     await assert.rejects(createDigitalPdfProcessor(config)({claim:{documentId:randomUUID(),patientId:randomUUID(),token:randomUUID()},attempt:1,signal:signal(),
       withOriginal:async use=>use({...value,assertActive:async()=>{if(++checks>1)throw new InvalidProcessingClaim();}}),persistExtraction:async()=>{persisted=true;}}),InvalidProcessingClaim);assert.equal(persisted,false);
   });
   await t.test('lease replacement after scope exit is rejected by atomic persistence',async()=>{
     const f=await fixture();const originals={async withOriginal<T>(claim:Claim,abortSignal:AbortSignal,use:Parameters<typeof f.originals.withOriginal<T>>[2]){
       const value=await f.originals.withOriginal(claim,abortSignal,use);await pool.query('UPDATE public.document_processing_jobs SET lease_token=$1 WHERE document_id=$2',[randomUUID(),f.documentId]);return value;
     }};
     assert.equal(await createProcessingWorker(f.service,lifecycle,createDigitalPdfProcessor(config),originals).runOnce(),'lost');assert.equal(await f.row(),undefined);await assert.rejects(access(f.path()));
   });
   await t.test('corrupt retrieval still fails existing validation and preserves original metadata',async()=>{
     const f=await fixture();f.corrupt();assert.equal(await createProcessingWorker(f.service,lifecycle,createDigitalPdfProcessor(config),f.originals).runOnce(),'failed');assert.equal(await f.row(),undefined);assert.equal(f.gets(),1);await assert.rejects(access(f.path()));
     assert.equal((await pool.query('SELECT s3_bucket FROM public.medical_documents WHERE id=$1',[f.documentId])).rows[0].s3_bucket,'synthetic-digital-pdf-originals');
   });
   await t.test('extraction timeout in the worker creates no successful evidence and cleans input',async()=>{
     const f=await fixture();assert.equal(await createProcessingWorker(f.service,lifecycle,createDigitalPdfProcessor({...config,timeoutMs:1}),f.originals).runOnce(),'failed');assert.equal(await f.row(),undefined);await assert.rejects(access(f.path()));
   });
   await t.test('configuration rejects unbounded environment values',()=>{
     const keys=['PDF_TEXT_MAX_FILE_BYTES','PDF_TEXT_MAX_PAGES','PDF_TEXT_MAX_CHARACTERS','PDF_TEXT_MAX_ITEMS','PDF_TEXT_TIMEOUT_MS','PDF_TEXT_MAX_CONCURRENCY'];const saved=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
     try{for(const key of keys){process.env[key]='0';assert.throws(getDigitalPdfConfig,ProcessingConfigurationError);if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];}}
     finally{for(const key of keys){if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];}}
   });
   await t.test('all secure temporary retrieval directories created by this suite are removed',async()=>{
     assert.deepEqual((await readdir(tmpdir())).filter(n=>n.startsWith('health-wallet-processing-')&&!temps.has(n)),[]);
   });
 }finally{
   try{await pool.query('DELETE FROM public.extracted_medical_text WHERE document_id=ANY($1::uuid[])',[documents]);await pool.query('DELETE FROM public.document_processing_jobs WHERE document_id=ANY($1::uuid[])',[documents]);await pool.query('DELETE FROM public.medical_documents WHERE id=ANY($1::uuid[])',[documents]);await pool.query('DELETE FROM public.patients WHERE id=ANY($1::uuid[])',[patients]);}
   finally{await rm(directory,{recursive:true,force:true});await closeDatabasePool();}
 }
});
