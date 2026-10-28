import type {Options,Preflight,Scenario,ScenarioScope,RecordOfUpload} from './guards.js';
import {target,requireLive,insist,createGuardedStorage,assertPreserved,type Snapshot} from './guards.js';
import {executeScenarios} from './workflow.js';
import {createHash,randomUUID,randomBytes} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rename,readFile,readdir,chmod,open} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import type {Server} from 'node:http';
import {createScenarioWorker} from './scoped-worker.js';

// Dynamic application imports below are unreachable from --preflight and ordinary import.
export async function runLiveScenarios(options:Options,report:Preflight,credentials:{accessKeyId:string;secretAccessKey:string;sessionToken?:string}){
  requireLive(options,report);
  const [{S3Client,HeadObjectCommand},{createApp},{pool,closeDatabasePool},configs,documents,{createS3Storage},{createOcrProcessor},{syntheticDigitalPdf},{syntheticScan,syntheticScannedPdf}]=await Promise.all([
    import('@aws-sdk/client-s3'),import('../app.js'),import('../database/pool.js'),import('../processing/config.js'),import('../config/documents.js'),
    import('../documents/storage.js'),import('../processing/ocr-processor.js'),import('../processing/fixtures/pdf-fixtures.js'),import('../processing/fixtures/ocr-fixtures.js')]);
  const client=new S3Client({region:target.region,credentials,ignoreConfiguredEndpointUrls:true,maxAttempts:2,requestHandler:{connectionTimeout:3000,requestTimeout:10000}});
  let server:Server|undefined,root='',runtime='',baseUrl='',stopped=false;
  const runId=randomUUID(),uploads:RecordOfUpload[]=[],tokens=new Map<Scenario,string>();
  const patients:{scenario:Scenario;id:string}[]=[],documentsCreated:ScenarioScope[]=[];
  const fixtures=new Map<Scenario,{bytes:Buffer;type:'pdf'|'png';sha256:string}>();
  let baseline:Snapshot|undefined;
  let saving=Promise.resolve();
  const save=()=>{
    saving=saving.then(async()=>{
      if(!root)return;const path=join(root,'manifest.pending');
      await writeFile(path,JSON.stringify({runId,profile:target.profile,account:target.account,bucket:target.bucket,region:target.region,patients,documents:documentsCreated,uploads},null,2),{mode:0o600,flag:'wx',flush:true});
      await rename(path,join(root,'manifest.json'));const directory=await open(root,'r');try{await directory.sync();}finally{await directory.close();}
    });return saving;
  };
  const documentsConfig=documents.getDocumentConfig();insist(documentsConfig.storage,'STORAGE_DISABLED');
  const guarded=createGuardedStorage(createS3Storage(documentsConfig.storage,{client}),options,uploads,save);
  const environmentTmp=process.env.TMPDIR;
  const snapshot=async()=>{
    const connection=await pool.connect();
    try{
      await connection.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const tables=(await connection.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'schema_migrations' ORDER BY tablename")).rows;
      const result:Snapshot={};
      for(const {tablename}of tables){
        insist(/^[a-z_]+$/.test(tablename),'SCHEMA');
        // Table names come only from the catalog and must pass the identifier allowlist.
        result[tablename]=(await connection.query(`SELECT COALESCE(to_jsonb(t)->>'id',to_jsonb(t)->>'document_id',to_jsonb(t)->>'version') AS id, md5(to_jsonb(t)::text) AS hash FROM public."${tablename}" t ORDER BY 1`)).rows;
      }
      await connection.query('COMMIT');return result;
    }catch(error){await connection.query('ROLLBACK').catch(()=>{});throw error;}finally{connection.release();}
  };
  const api=async(path:string,method='GET',body?:unknown,scenario?:Scenario)=>{
    const headers:Record<string,string>={};if(scenario)headers.Authorization='Bearer '+tokens.get(scenario);
    if(body&&!(body instanceof FormData))headers['Content-Type']='application/json';
    const response=await fetch(baseUrl+path,{method,headers,body:body instanceof FormData?body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(30000)])});
    const json=await response.json() as any;return {status:response.status,json};
  };
  const rows=async(scope:ScenarioScope)=>{
    const [d,j,e]=await Promise.all([
      pool.query('SELECT * FROM public.medical_documents WHERE id=$1 AND patient_id=$2',[scope.documentId,scope.patientId]),
      pool.query('SELECT * FROM public.document_processing_jobs WHERE document_id=$1 AND patient_id=$2',[scope.documentId,scope.patientId]),
      pool.query('SELECT * FROM public.extracted_medical_text WHERE document_id=$1 AND patient_id=$2',[scope.documentId,scope.patientId])]);return {d:d.rows,j:j.rows,e:e.rows};
  };
  const claims=new Map<Scenario,{token:string;attempt:number}>();
  const controller=new AbortController(),cancel=()=>controller.abort();
  process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
  try{
    await executeScenarios(options,report,{
      async prepare(){
        baseline=await snapshot();
        root=await mkdtemp(join(tmpdir(),'health-wallet-live-verification-'));await chmod(root,0o700);
        runtime=join(root,'runtime');await mkdir(runtime,{mode:0o700});process.env.TMPDIR=runtime;
        for(const scenario of ['A','B','C'] as const){
          const bytes=scenario==='A'?syntheticDigitalPdf([['SYNTHETIC DIGITAL REPORT FIRST','GLUCOSE 90 mg/dL']]):scenario==='B'?await syntheticScan('SYNTHETIC IMAGE REPORT SECOND'):
            await syntheticScannedPdf([{text:'SYNTHETIC EMBEDDED PAGE FIRST'},{scan:'SYNTHETIC SCANNED PAGE SECOND'}]);
          const type=scenario==='B'?'png':'pdf';insist(bytes.length<1048576,'FIXTURE');fixtures.set(scenario,{bytes,type,sha256:createHash('sha256').update(bytes).digest('hex')});
          await writeFile(join(root,`synthetic-${scenario}.${type}`),bytes,{mode:0o600});
        }
        await save();const app=createApp({documentStorage:guarded.storage});server=app.listen(0,'127.0.0.1');await once(server,'listening');
        const address=server.address();insist(address&&typeof address==='object','LOCAL_SERVER');baseUrl=`http://127.0.0.1:${address.port}`;
      },
      async register(scenario){
        controller.signal.throwIfAborted();const email=`phase22d-${runId}-${scenario.toLowerCase()}@example.invalid`,password=randomBytes(32).toString('base64url');
        const registered=await api('/api/v1/auth/register','POST',{email,password,full_name:`Synthetic Phase 2.2D ${scenario}`});
        insist(registered.status===201&&registered.json.success&&typeof registered.json.patient?.id==='string','REGISTER');
        const id=registered.json.patient.id;insist(!baseline!.patients.some(row=>row.id===id),'PATIENT_EXISTS');patients.push({scenario,id});await save();
        const login=await api('/api/v1/auth/login','POST',{email,password});insist(login.status===200&&typeof login.json.access_token==='string','LOGIN');tokens.set(scenario,login.json.access_token);return id;
      },
      async upload(scenario,patientId){
        controller.signal.throwIfAborted();const fixture=fixtures.get(scenario)!,mime=fixture.type==='pdf'?'application/pdf':'image/png';guarded.expect(scenario,fixture.bytes,mime);
        const body=new FormData();body.set('category','lab_report');body.set('hospital_name','Synthetic Verification '+runId);body.set('file',new Blob([new Uint8Array(fixture.bytes)],{type:mime}),`phase22d-${runId}-${scenario}.${fixture.type}`);
        const result=await api('/api/v1/documents','POST',body,scenario);insist(result.status===201&&result.json.success,'UPLOAD');
        const id=result.json.document?.id;insist(typeof id==='string','DOCUMENT');documentsCreated.push({scenario,patientId,documentId:id});await save();return id;
      },
      async process(scope,registry){
        const before=await rows(scope);insist(before.d.length===1&&before.j.length===1&&!before.e.length&&before.j[0].state==='pending'&&before.j[0].attempt_count===0,'PENDING_JOB');
        const count=await pool.query('SELECT count(*)::int AS n FROM public.medical_documents WHERE patient_id=$1',[scope.patientId]);
        const jobCount=await pool.query('SELECT count(*)::int AS n FROM public.document_processing_jobs WHERE patient_id=$1',[scope.patientId]);
        insist(count.rows[0].n===1&&jobCount.rows[0].n===1,'EXCLUSIVE_SCOPE');
        const config=configs.getProcessingConfig();const processor=createOcrProcessor({...configs.getOcrConfig(),maxConcurrency:1},configs.getDigitalPdfConfig());
        const worker=createScenarioWorker(pool,config,scope,registry,async context=>{
          claims.set(scope.scenario,{token:context.claim.token,attempt:context.attempt});await processor({...context,
            async withOriginal(use){return context.withOriginal(async input=>{
              insist(createHash('sha256').update(await readFile(input.path)).digest('hex')===fixtures.get(scope.scenario)!.sha256,'RETRIEVED_HASH');return use(input);
            });},async persistExtraction(result){insist((await readdir(runtime)).length===0,'CLEANUP_BEFORE_PERSIST');await context.persistExtraction(result);}});
        },guarded.storage,documentsConfig,configs.getRetrievalConfig());
        insist(await worker.runOnce(controller.signal)==='completed','WORKER');const beforeDuplicate=await rows(scope);
        insist(await worker.runOnce(controller.signal)==='idle','DUPLICATE');insist(JSON.stringify(await rows(scope))===JSON.stringify(beforeDuplicate),'DUPLICATE_CHANGED');
      },
      async verify(scope,allPatients){
        const state=await rows(scope),fixture=fixtures.get(scope.scenario)!,upload=uploads.find(u=>u.scenario===scope.scenario)!;
        insist(state.d.length===1&&state.j.length===1&&state.e.length===1&&state.d[0].processing_status==='completed'&&state.j[0].state==='completed','COMPLETION');
        const extraction=state.e[0],claim=claims.get(scope.scenario)!;
        insist(extraction.processing_status==='completed'&&extraction.processing_attempt===claim.attempt&&claim.attempt===1&&extraction.processing_claim_token===claim.token&&state.j[0].attempt_count===claim.attempt,'ATTEMPT_EVIDENCE');
        insist(state.d[0].s3_bucket===target.bucket&&state.d[0].s3_object_key===upload.key,'OBJECT_ASSOCIATION');
        const meta=extraction.source_metadata,methods=scope.scenario==='A'?['pdf_text']:scope.scenario==='B'?['ocr']:['pdf_text','ocr'];
        insist(meta.source.sha256===fixture.sha256&&meta.source.pageCount===methods.length&&meta.method===(scope.scenario==='A'?'pdf_text':scope.scenario==='B'?'ocr':'mixed'),'PROVENANCE');
        insist(meta.source.pages.every((p:any,i:number)=>p.page===i+1&&p.method===methods[i])&&meta.source.pages.length===methods.length,'PAGE_ORDER');
        const phrases=scope.scenario==='A'?['SYNTHETIC DIGITAL REPORT FIRST','GLUCOSE 90 mg/dL']:scope.scenario==='B'?['SYNTHETIC IMAGE REPORT SECOND']:['SYNTHETIC EMBEDDED PAGE FIRST','SYNTHETIC SCANNED PAGE SECOND'];
        let position=-1;for(const phrase of phrases){const next=extraction.extracted_text.indexOf(phrase);insist(next>position,'EXTRACTED_TEXT');position=next;}
        for(const page of meta.source.pages)insist(page.method==='pdf_text'?!Object.hasOwn(page,'confidence'):typeof page.confidence==='number'&&page.confidence>=0&&page.confidence<=100,'CONFIDENCE');
        const head=await client.send(new HeadObjectCommand({Bucket:target.bucket,Key:upload.key,ExpectedBucketOwner:target.account,VersionId:upload.versionId}),{abortSignal:AbortSignal.timeout(10000)});
        insist(head.ContentLength===fixture.bytes.length&&head.ServerSideEncryption==='AES256'&&head.ContentType===upload.mime&&head.VersionId===upload.versionId,'OBJECT_METADATA');
        const anonymous=await fetch(`https://${target.bucket}.s3.${target.region}.amazonaws.com/${upload.key}`,{headers:{Range:'bytes=0-0'},redirect:'error',signal:AbortSignal.timeout(10000)});
        await anonymous.body?.cancel();insist([403,404].includes(anonymous.status),'OBJECT_PUBLIC');
        for(const [other]of allPatients)if(other!==scope.scenario){
          insist((await api(`/api/v1/documents/${scope.documentId}`,'GET',undefined,other)).status===404,'CROSS_PATIENT');
          insist((await api(`/api/v1/documents/${scope.documentId}/download`,'GET',undefined,other)).status===404,'CROSS_PATIENT');
        }
        insist((await readdir(runtime)).length===0,'TEMPORARY_FILES');
        const childList=await readFile(`/proc/${process.pid}/task/${process.pid}/children`,'utf8');insist(!childList.trim(),'CHILD_PROCESSES');
        console.log(JSON.stringify({scenario:scope.scenario,passed:true,method:meta.method,pages:methods.length}));
      },
      async preserve(){
        if(!baseline)return;const after=await snapshot();
        const allowed:Record<string,Set<string>>={patients:new Set(patients.map(p=>p.id)),medical_documents:new Set(documentsCreated.map(d=>d.documentId)),document_processing_jobs:new Set(documentsCreated.map(d=>d.documentId)),extracted_medical_text:new Set()};
        for(const scope of documentsCreated)for(const r of (await rows(scope)).e)allowed.extracted_medical_text.add(r.id);
        assertPreserved(baseline,after,allowed);
        console.log(JSON.stringify({preservation:true,retained:true}));await save();
      },
      async close(){
        if(stopped)return;stopped=true;controller.abort();tokens.clear();
        try{if(server){server.closeAllConnections();await new Promise<void>(resolve=>server!.close(()=>resolve()));}}finally{await closeDatabasePool();client.destroy();}
      }
    });
  }finally{
    process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);
    if(environmentTmp===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=environmentTmp;
    if(root)console.log(JSON.stringify({retainedManifest:join(root,'manifest.json'),cleanupPerformed:false}));
  }
}
