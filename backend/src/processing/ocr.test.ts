import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,writeFile,readFile,rm,readdir,access,symlink} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {syntheticScan,syntheticScannedPdf} from './fixtures/ocr-fixtures.js';
import {syntheticDigitalPdf} from './fixtures/pdf-fixtures.js';
import {getOcrConfig,getDigitalPdfConfig,ProcessingConfigurationError,type OcrConfig,type ProcessingConfig} from './config.js';
import {extractDocumentText,parseOcrTsv,OcrFailure} from './ocr.js';
import {runOcrCommand} from './ocr-process.js';
import {createOcrProcessor} from './ocr-processor.js';
import {validateExtraction} from './extraction.js';
import {createProcessingWorker} from './worker.js';
import {createProcessingRepository,type Claim} from './repository.js';
import {createProcessingService} from './service.js';
import {createOriginalAccess,getOriginalScope,type OriginalInput} from './retrieval.js';
import {getDocumentConfig} from '../config/documents.js';
import {pool,closeDatabasePool} from '../database/pool.js';

const signal=()=>new AbortController().signal;
const config=getOcrConfig(),pdfConfig=getDigitalPdfConfig();
const lifecycle:ProcessingConfig={maxAttempts:3,leaseMs:60000,attemptTimeoutMs:300000,heartbeatMs:15000,retryBaseMs:1000,retryMaxMs:10000,recoveryBatchSize:10};
const children=()=>readFileSync(`/proc/${process.pid}/task/${process.pid}/children`,'utf8').trim().split(/\s+/).filter(Boolean).map(Number);
const gone=(pid:number)=>assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
test('Phase 2.2C-C genuine scanned PDF and image OCR',{timeout:240000},async t=>{
 const directory=await mkdtemp(join(tmpdir(),'health-wallet-ocr-test-')),patients:string[]=[],documents:string[]=[];
 const tempBaseline=(await readdir(tmpdir())).filter(n=>n.startsWith('health-wallet-ocr-')||n.startsWith('health-wallet-processing-')).sort();
 const input=async(bytes:Buffer,type:'pdf'|'png'|'jpg'|'jpeg'='png')=>{
   const path=join(directory,randomUUID()+'.bin');await writeFile(path,bytes,{mode:0o600});return {path,type,bytes:bytes.length};
 };
 const extract=async(bytes:Buffer,type:'pdf'|'png'|'jpg'|'jpeg'='png',options:Partial<OcrConfig>={})=>extractDocumentText(await input(bytes,type),signal(),{...config,...options},pdfConfig);
 async function fixture(bytes:Buffer,type:'pdf'|'png'='png'){
   const patientId=randomUUID(),documentId=randomUUID();patients.push(patientId);documents.push(documentId);
   await pool.query(`INSERT INTO public.patients(id,email,password_hash,full_name) VALUES($1,$2,$3,'Synthetic OCR Patient')`,[patientId,patientId+'@example.invalid','$argon2id$v=19$m=65536,t=3,p=1$syntheticSalt$syntheticHashNotAnActualPassword']);
   const key='medical-documents/'+randomUUID()+'.'+type,bucket='synthetic-ocr-originals';
   await pool.query(`INSERT INTO public.medical_documents(id,patient_id,s3_bucket,s3_object_key,original_filename,file_type,category) VALUES($1,$2,$3,$4,'synthetic.bin',$5,'lab_report')`,[documentId,patientId,bucket,key,type]);
   const service=createProcessingService(createProcessingRepository(pool,lifecycle,patientId));let observedPath='';
   const storage={bucket,prefix:'medical-documents/',async readOriginal(request:{destination:string;key:string}){
     assert.equal(request.key,key);observedPath=request.destination;await writeFile(request.destination,bytes,{flag:'wx',mode:0o600});return {bytes:bytes.length};
   }};
   const originals=createOriginalAccess(service,storage,getDocumentConfig(),{maxDownloadBytes:5242880,downloadTimeoutMs:15000,leaseCheckIntervalMs:100,maxConcurrentRetrievals:2});
   const row=async()=>(await pool.query('SELECT * FROM public.extracted_medical_text WHERE document_id=$1',[documentId])).rows[0];
   return {service,originals,patientId,documentId,row,path:()=>observedPath};
 }
 try{
  await t.test('real single-page scanned PDF text, source hash, tool versions and confidence',async()=>{
    const bytes=await syntheticScannedPdf([{scan:'SYNTHETIC REPORT FIRST'}]),out=await extract(bytes,'pdf');
    assert.match(out.text,/SYNTHETIC REPORT FIRST/);assert.match(out.text,/GLUCOSE 90/);assert.equal(out.method,'ocr');
    assert.equal(out.source.sha256,createHash('sha256').update(bytes).digest('hex'));assert.equal(out.source.pageCount,1);
    assert.equal(out.source.pages[0].method,'ocr');assert.ok(out.source.pages[0].confidence!>0&&out.source.pages[0].confidence!<=100);
    assert.match(out.extractor.name,/Tesseract.*Poppler.*PDF.js/);assert.match(out.extractor.version,/5\.3\.4.*24\.02\.0/);validateExtraction(out);
  });
  await t.test('multipage scanned PDFs retain numeric order, boundaries and OCR provenance',async()=>{
    const out=await extract(await syntheticScannedPdf([{scan:'SYNTHETIC PAGE FIRST'},{scan:'SYNTHETIC PAGE SECOND'},{scan:'SYNTHETIC PAGE THIRD'}]),'pdf');
    const pages=out.text.split('\n\n');assert.equal(pages.length,3);
    ['FIRST','SECOND','THIRD'].forEach((word,index)=>assert.match(pages[index],new RegExp(word)));
    assert.deepEqual(out.source.pages.map(p=>[p.page,p.method]),[[1,'ocr'],[2,'ocr'],[3,'ocr']]);
  });
  await t.test('mixed PDFs preserve exact embedded text and OCR only textless pages',async()=>{
    const out=await extract(await syntheticScannedPdf([{text:'Synthetic embedded FIRST 001'},{scan:'SYNTHETIC SCANNED SECOND'},{text:'Synthetic embedded THIRD 003'}]),'pdf');
    assert.equal(out.method,'mixed');assert.equal(out.text.split('\n\n')[0],'Synthetic embedded FIRST 001');
    assert.match(out.text.split('\n\n')[1],/SCANNED SECOND/);assert.equal(out.text.split('\n\n')[2],'Synthetic embedded THIRD 003');
    assert.equal(out.text.match(/embedded FIRST/g)?.length,1);
    assert.deepEqual(out.source.pages.map(p=>[p.page,p.method,Object.hasOwn(p,'confidence')]),[[1,'pdf_text',false],[2,'ocr',true],[3,'pdf_text',false]]);
  });
  for(const type of ['png','jpg','jpeg'] as const)await t.test(`genuine ${type.toUpperCase()} OCR and unchanged original bytes`,async()=>{
    const bytes=await syntheticScan('SYNTHETIC IMAGE REPORT',type==='png'?'png':'jpeg'),value=await input(bytes,type);
    const out=await extractDocumentText(value,signal(),config,pdfConfig);assert.match(out.text,/SYNTHETIC IMAGE REPORT/);assert.equal(out.method,'ocr');
    assert.deepEqual(await readFile(value.path),bytes);assert.equal(out.source.sha256,createHash('sha256').update(bytes).digest('hex'));validateExtraction(out);
  });
  await t.test('EXIF-oriented JPEG is rotated from source metadata before recognition',async()=>{
    const out=await extract(await syntheticScan('SYNTHETIC ROTATED REPORT','jpeg',true),'jpeg');assert.match(out.text,/SYNTHETIC ROTATED REPORT/);
  });
  await t.test('pure digital PDF remains pdf_text without OCR confidence',async()=>{
    const out=await extract(syntheticDigitalPdf([['Synthetic digital only']]),'pdf');assert.equal(out.text,'Synthetic digital only');assert.equal(out.method,'pdf_text');assert.equal(out.extractor.name,'PDF.js');
  });
  await t.test('word confidence arithmetic excludes structural, empty and invalid scores',()=>{
    const header='level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n';
    const row=(level:number,conf:string,text:string,line=1)=>`${level}\t1\t1\t1\t${line}\t1\t0\t0\t20\t20\t${conf}\t${text}\n`;
    const out=parseOcrTsv(header+row(1,'-1','')+row(5,'80','Alpha')+row(5,'100','Beta')+row(5,'-1','Gamma',2)+row(5,'NaN','Delta',2)+row(5,'120','Epsilon',2));
    assert.equal(out.text,'Alpha Beta\nGamma Delta Epsilon');assert.equal(out.confidence,90);
    assert.equal(parseOcrTsv(header+row(5,'-1','Alpha')).confidence,undefined);assert.throws(()=>parseOcrTsv('bad'),OcrFailure);
  });
  await t.test('blank images, unreadable rasters and blank PDF pages fail without invented evidence',async()=>{
    const blank=await sharp({create:{width:1000,height:500,channels:3,background:'white'}}).png().toBuffer();
    await assert.rejects(extract(blank),e=>e instanceof OcrFailure&&e.reason==='empty');
    await assert.rejects(extract(syntheticDigitalPdf([[]]),'pdf'),e=>e instanceof OcrFailure&&e.reason==='empty');
    await assert.rejects(extract(syntheticDigitalPdf([[]],{imageOnly:true}),'pdf'),OcrFailure);
  });
  await t.test('a mixed document with an unreadable page fails instead of persisting partial text',async()=>{
    await assert.rejects(extract(syntheticDigitalPdf([['Synthetic readable first'],[]]),'pdf'),OcrFailure);
  });
  await t.test('malformed images, mismatched formats and PDFs are safely rejected',async()=>{
    for(const type of ['png','jpeg','pdf'] as const)await assert.rejects(extract(Buffer.from('synthetic malformed content'),type));
    await assert.rejects(extract(await syntheticScan(),'jpeg'),OcrFailure);
  });
  await t.test('PDF active features and attachments are rejected before native rendering',async()=>{
    for(const options of [{javascript:true},{attachment:true},{form:true}])await assert.rejects(extract(syntheticDigitalPdf([[]],options),'pdf'));
  });
  await t.test('page, image pixel, text, file and temporary-disk budgets fail safely',async()=>{
    const image=await syntheticScan();await assert.rejects(extract(image,'png',{maxPixels:65536}),OcrFailure);
    await assert.rejects(extract(image,'png',{maxTextCharacters:4}),OcrFailure);
    await assert.rejects(extract(image,'png',{maxFileBytes:100}),OcrFailure);
    const pdf=await syntheticScannedPdf([{scan:'SYNTHETIC FIRST'},{scan:'SYNTHETIC SECOND'}]);
    await assert.rejects(extract(pdf,'pdf',{maxPages:1}));await assert.rejects(extract(pdf,'pdf',{maxTempBytes:1024}),OcrFailure);
  });
  await t.test('symlinks and receipt size changes are rejected',async()=>{
    const value=await input(await syntheticScan()),link=join(directory,'symlink');await symlink(value.path,link);
    await assert.rejects(extractDocumentText({...value,path:link},signal(),config,pdfConfig),OcrFailure);
    await assert.rejects(extractDocumentText({...value,bytes:value.bytes+1},signal(),config,pdfConfig),OcrFailure);
  });
  await t.test('path metacharacters remain literal arguments and create no injected file',async()=>{
    const value=await input(await syntheticScan()),path=join(directory,'original $(touch INJECTED);.png');await writeFile(path,await readFile(value.path));
    assert.match((await extractDocumentText({...value,path},signal(),config,pdfConfig)).text,/SYNTHETIC/);await assert.rejects(access(join(directory,'INJECTED')));
  });
  await t.test('pre-cancelled and document-timeout calls release admission and clean up',async()=>{
    const value=await input(await syntheticScan()),abort=new AbortController();abort.abort();
    await assert.rejects(extractDocumentText(value,abort.signal,config,pdfConfig),e=>e instanceof OcrFailure&&e.reason==='cancelled');
    await assert.rejects(extractDocumentText(value,signal(),{...config,documentTimeoutMs:1},pdfConfig),e=>e instanceof OcrFailure&&e.reason==='timeout');
    assert.match((await extractDocumentText(value,signal(),config,pdfConfig)).text,/SYNTHETIC/);
  });
  await t.test('concurrent documents are bounded across processor instances',async()=>{
    const value=await input(await syntheticScan()),options={...config,maxConcurrency:1};const first=extractDocumentText(value,signal(),options,pdfConfig);
    await assert.rejects(extractDocumentText(value,signal(),options,pdfConfig),e=>e instanceof OcrFailure&&e.reason==='busy');await first;
  });
  await t.test('cancellation during native OCR kills and reaps the child process',async()=>{
    const value=await input(await syntheticScan()),abort=new AbortController();
    const running=runOcrCommand('tesseract',[value.path,'stdout','-l','eng','tsv'],directory,abort.signal,config);
    const pids=children();assert.equal(pids.length,1);
    // Wait until prlimit has exec'd the real OCR binary before cancelling it.
    for(let i=0;i<100&&readFileSync(`/proc/${pids[0]}/comm`,'utf8').trim()!=='tesseract';i++)await new Promise(resolve=>setTimeout(resolve,1));
    assert.equal(readFileSync(`/proc/${pids[0]}/comm`,'utf8').trim(),'tesseract');
    const limits=readFileSync(`/proc/${pids[0]}/limits`,'utf8');
    assert.match(limits,/Max cpu time\s+15\s+15/);assert.match(limits,/Max address space\s+536870912\s+536870912/);
    assert.match(limits,/Max file size\s+16777216\s+16777216/);abort.abort();
    await assert.rejects(running,e=>e instanceof OcrFailure&&e.reason==='cancelled');pids.forEach(gone);
  });
  await t.test('native wall timeout terminates the child and output overflow is bounded',async()=>{
    const value=await input(await syntheticScan());
    const running=runOcrCommand('tesseract',[value.path,'stdout','-l','eng','tsv'],directory,signal(),{...config,pageTimeoutMs:1});
    const pids=children();assert.ok(pids.length>0);await assert.rejects(running,e=>e instanceof OcrFailure&&e.reason==='timeout');pids.forEach(gone);
    await assert.rejects(runOcrCommand('tesseract',[value.path,'stdout','-l','eng','tsv'],directory,signal(),{...config,maxOutputBytes:128}),e=>e instanceof OcrFailure&&e.reason==='limit');
  });
  await t.test('OS address-space exhaustion fails safely and reaps the child',async()=>{
    const value=await input(await syntheticScan());const running=runOcrCommand('tesseract',[value.path,'stdout','-l','eng','tsv'],directory,signal(),{...config,memoryBytes:67108864});const pids=children();
    await assert.rejects(running,OcrFailure);pids.forEach(gone);
  });
  await t.test('secure retrieval closes and removes input before atomic OCR persistence',async()=>{
    const bytes=await syntheticScan(),f=await fixture(bytes),persist=f.service.persistExtraction.bind(f.service);
    f.service.persistExtraction=async(claim,result)=>{await assert.rejects(access(f.path()));return persist(claim,result);};
    assert.equal(await createProcessingWorker(f.service,lifecycle,createOcrProcessor(config,pdfConfig),f.originals).runOnce(),'completed');
    const row=await f.row();assert.match(row.extracted_text,/SYNTHETIC REPORT FIRST/);assert.equal(row.source_metadata.source.sha256,createHash('sha256').update(bytes).digest('hex'));assert.equal(row.processing_attempt,1);
  });
  for(const mode of ['stale','expired'] as const)await t.test(`${mode} lease after extraction is rejected by existing DB fencing`,async()=>{
    const f=await fixture(await syntheticScan()),base=f.originals;
    const originals={async withOriginal<T>(claim:Claim,abort:AbortSignal,use:(input:OriginalInput)=>Promise<T>){
      const result=await base.withOriginal(claim,abort,use);
      if(mode==='stale')await pool.query('UPDATE public.document_processing_jobs SET lease_token=$1 WHERE document_id=$2',[randomUUID(),f.documentId]);
      else await pool.query("UPDATE public.document_processing_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE document_id=$1",[f.documentId]);return result;
    }};
    assert.equal(await createProcessingWorker(f.service,lifecycle,createOcrProcessor(config,pdfConfig),originals).runOnce(),'lost');assert.equal(await f.row(),undefined);await assert.rejects(access(f.path()));
  });
  await t.test('lease loss inside the scope aborts OCR and awaits registered cleanup',async()=>{
    const f=await fixture(await syntheticScan()),job=await f.service.claim();assert.ok(job);
    const claim={documentId:f.documentId,patientId:f.patientId,token:job.lease_token!};let cleaned=false;
    await assert.rejects(f.originals.withOriginal(claim,signal(),async value=>{
      const scope=getOriginalScope(value)!;
      const work=(async()=>{try{await new Promise<void>(resolve=>scope.signal.addEventListener('abort',()=>resolve(),{once:true}));}
        finally{await new Promise(resolve=>setTimeout(resolve,30));cleaned=true;}})();scope.waitForCleanup(work);
      await pool.query('UPDATE public.document_processing_jobs SET lease_token=$1 WHERE document_id=$2',[randomUUID(),f.documentId]);await work;
    }));assert.equal(cleaned,true);await assert.rejects(access(f.path()));assert.equal(await f.row(),undefined);
  });
  await t.test('empty OCR worker fails safely and preserves original document metadata',async()=>{
    const f=await fixture(await sharp({create:{width:600,height:300,channels:3,background:'white'}}).png().toBuffer());
    assert.equal(await createProcessingWorker(f.service,lifecycle,createOcrProcessor(config,pdfConfig),f.originals).runOnce(),'failed');assert.equal(await f.row(),undefined);
    assert.equal((await pool.query('SELECT s3_bucket FROM public.medical_documents WHERE id=$1',[f.documentId])).rows[0].s3_bucket,'synthetic-ocr-originals');await assert.rejects(access(f.path()));
  });
  for(const mode of ['cancel','lease-loss'] as const)await t.test(`actual worker ${mode} during Tesseract leaves no children, files or evidence`,async()=>{
    const f=await fixture(await syntheticScan()),abort=new AbortController();
    const running=createProcessingWorker(f.service,lifecycle,createOcrProcessor(config,pdfConfig),f.originals).runOnce(abort.signal);
    let found=false;
    for(let i=0;i<1000;i++){
      found=children().some(pid=>{try{return readFileSync(`/proc/${pid}/cmdline`,'utf8').split('\0').includes('stdout');}catch{return false;}});
      if(found)break;await new Promise(resolve=>setTimeout(resolve,5));
    }
    assert.equal(found,true,'Expected a real native OCR subprocess');
    if(mode==='cancel')abort.abort();else await pool.query('UPDATE public.document_processing_jobs SET lease_token=$1 WHERE document_id=$2',[randomUUID(),f.documentId]);
    assert.equal(await running,mode==='cancel'?'failed':'lost');assert.equal(await f.row(),undefined);
    assert.deepEqual(children(),[]);await assert.rejects(access(f.path()));
  });
  await t.test('configuration rejects values outside every resource ceiling',()=>{
    for(const key of ['OCR_MAX_PAGES','OCR_MAX_FILE_BYTES','OCR_MAX_CHARACTERS','OCR_MAX_CONCURRENCY','OCR_DPI','OCR_MAX_EDGE','OCR_MAX_PIXELS','OCR_MAX_TEMP_BYTES','OCR_PAGE_TIMEOUT_MS','OCR_DOCUMENT_TIMEOUT_MS','OCR_CPU_SECONDS','OCR_MEMORY_BYTES','OCR_MAX_OUTPUT_BYTES']){
      const saved=process.env[key];try{process.env[key]='999999999999';assert.throws(getOcrConfig,ProcessingConfigurationError);}finally{if(saved===undefined)delete process.env[key];else process.env[key]=saved;}
    }
  });
  await t.test('all OCR children and private extraction directories are cleaned',async()=>{
    assert.deepEqual(children(),[]);
    assert.deepEqual((await readdir(tmpdir())).filter(n=>n.startsWith('health-wallet-ocr-')||n.startsWith('health-wallet-processing-')).sort(),tempBaseline);
  });
 }finally{
   for(const id of documents){await pool.query('DELETE FROM public.extracted_medical_text WHERE document_id=$1',[id]);await pool.query('DELETE FROM public.medical_documents WHERE id=$1',[id]);}
   for(const id of patients)await pool.query('DELETE FROM public.patients WHERE id=$1',[id]);
   await closeDatabasePool();await rm(directory,{recursive:true,force:true});
 }
});
