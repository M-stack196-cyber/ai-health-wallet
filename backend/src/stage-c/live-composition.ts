import {guard,assertCanary} from '../processing/background-config.js';
import {target,type RecordOfUpload,type Snapshot,type AwsRead} from '../integration/guards.js';
import {seedCanary,executeCanary,type CanaryPorts} from './controller.js';
import {checkPreparation,checkReceipt,uuid,type Preparation,type UploadReceipt} from './safety.js';
import {proposeCutoff,verifyDatabaseCutoff,type ReadDatabase} from './database.js';
import {observeReceipt,type ObjectReceipt} from './receipts.js';
import {captureSnapshot,verifySnapshot,type SnapshotDatabase} from './preservation.js';
import type {LiveOptions} from './runtime-flags.js';
import type {UnitPlan,Supervisor} from './supervision.js';
import type {SyntheticCredential} from './adapters.js';
import type {openJournal} from './evidence.js';
export interface CanaryManifest {
 version:2;run:string;target:typeof target;stage:'seeding'|'seeded'|'activating'|'completed'|'failed';
 patients:{role:'canary'|'control';id:string}[];documents:{role:'sentinel'|'mixed';id:string}[];uploads:RecordOfUpload[];
 fixtures:{sentinel:string;mixed:string};sentinelFingerprint?:string;completedFingerprint?:string;originals?:Record<string,unknown>;artifacts?:Record<string,string>;cutoff?:string;approvalPin?:string;
 events:{event:string;at:string;values:unknown}[];
}
export interface LiveResources {
 db:ReadDatabase&SnapshotDatabase;readAws:AwsRead;signal:AbortSignal;now():number;
 journal:Awaited<ReturnType<typeof openJournal>>;
 manifest:CanaryManifest;baseline?:Snapshot;
 fixture(role:'sentinel'|'mixed'):Buffer;
 api:{register(role:'canary'|'control',signal:AbortSignal):Promise<string>;login(role:'canary'|'control',id:string,c:SyntheticCredential,signal:AbortSignal):Promise<void>;
 upload(role:'sentinel'|'mixed',patient:string,bytes:Buffer,signal:AbortSignal):Promise<string>;denied(control:string,id:string,signal:AbortSignal):Promise<void>};
 expect(role:'sentinel'|'mixed',bytes:Buffer):void;
 original(role:'sentinel'|'mixed',id:string):Promise<ObjectReceipt>;
 captureOldObjects():Promise<unknown>;checkOldObjects(value:unknown):Promise<void>;
 unit:UnitPlan;supervisor:Supervisor;
 noOtherService():Promise<void>;ready(signal:AbortSignal):Promise<void>;cleanup():Promise<void>;lockReleased():Promise<void>;
}
const events=['registration-intent','registration-confirmed','sentinel-upload-intent','sentinel-confirmed','cutoff-proposed','service-start-intent','mixed-upload-intent','mixed-upload-confirmed','completed'];
export function validateManifest(options:LiveOptions,m:CanaryManifest){
 guard(m&&m.version===2&&m.run===options.run&&JSON.stringify(m.target)===JSON.stringify(target));
 guard(Array.isArray(m.patients)&&Array.isArray(m.documents)&&Array.isArray(m.uploads)&&Array.isArray(m.events));
 if(options.phase==='activate'){
  const p=options.preparation!;guard(p&&m.stage==='seeded'&&m.patients.length===2&&m.documents.length===1&&m.uploads.length===1);
  guard(m.patients[0].role==='canary'&&m.patients[0].id===p.config.canary.patientId&&m.patients[1].role==='control'&&m.patients[1].id===p.controlPatientId&&p.controlPatientId!==p.config.canary.patientId);
  guard(m.documents[0].role==='sentinel'&&uuid(m.documents[0].id)&&m.cutoff===p.config.canary.uploadCutoff&&m.uploads[0].scenario==='A'&&m.uploads[0].confirmed);
  guard(!m.events.some(e=>e.event==='mixed-upload-intent'||e.event==='service-start-intent'));
  guard(typeof m.sentinelFingerprint==='string'&&/^[a-f0-9]{32}$/.test(m.sentinelFingerprint));
  guard(!m.approvalPin||m.approvalPin===p.config.approvalSha256);
 }
}
export async function runComposedCanary(options:LiveOptions,r:LiveResources){
 validateManifest(options,r.manifest);const m=r.manifest;let baseline=r.baseline;
 const fingerprint=async(id:string)=>{const rows=(await r.db.query(`SELECT md5(to_jsonb(d)::text||to_jsonb(j)::text||COALESCE(to_jsonb(e)::text,'')) AS hash
   FROM public.medical_documents d JOIN public.document_processing_jobs j ON j.document_id=d.id
   LEFT JOIN public.extracted_medical_text e ON e.document_id=d.id WHERE d.id=$1::uuid AND d.patient_id=$2::uuid`,[id,m.patients[0].id])).rows;guard(rows.length===1&&/^[a-f0-9]{32}$/.test(rows[0].hash));return rows[0].hash as string;};
 const save=async()=>{await r.journal.save('manifest',m);await r.journal.save('receipts',{run:m.run,uploads:m.uploads,documents:m.documents});};
 const append=async(event:string,values:unknown)=>{
  guard(events.includes(event));m.events.push({event,at:new Date(r.now()).toISOString(),values});guard(m.events.length<=32);
  if(event==='registration-confirmed'){
   const v=values as {role:'canary'|'control';patient:string};guard(uuid(v.patient)&&!baseline?.patients.some(row=>row.id===v.patient)&&!m.patients.some(row=>row.id===v.patient));m.patients.push({role:v.role,id:v.patient});
  }
  if(event==='sentinel-confirmed'||event==='mixed-upload-confirmed'){
   const v=values as UploadReceipt;guard(!m.documents.some(d=>d.id===v.documentId||d.role===v.role));m.documents.push({role:v.role,id:v.documentId});if(v.role==='sentinel')m.sentinelFingerprint=await fingerprint(v.documentId);
  }
  if(event==='cutoff-proposed'){const v=values as {cutoff:string};assertCanary({patientId:m.patients[0].id,uploadCutoff:v.cutoff});m.cutoff=v.cutoff;m.stage='seeded';}
  if(event==='service-start-intent')m.stage='activating';if(event==='completed')m.stage='completed';await save();
 };
 const patient=()=>{guard(m.patients.length>=1);return m.patients[0].id;};
 const prep=()=>options.preparation??{run:m.run,config:{canary:{patientId:patient()}}};
 const receipt=async(role:'sentinel'|'mixed',id:string)=>observeReceipt(r.db,prep(),role,id,m.fixtures[role],()=>r.original(role,id));
 const preservation=async()=>{
  guard(baseline);const after=await captureSnapshot(r.db);
  const documents=m.documents.map(d=>d.id),extractions=(await r.db.query('SELECT id FROM public.extracted_medical_text WHERE document_id=ANY($1::uuid[]) AND patient_id=$2::uuid',[documents,patient()])).rows;
  verifySnapshot(baseline,after,m.patients.map(p=>p.id),documents,extractions.map(e=>e.id));
  const old=await r.journal.read('baseline');guard(old.run===m.run&&JSON.stringify(old.rows)===JSON.stringify(baseline));await r.checkOldObjects(old.objects);
 };
 const wait=async(ms:number,signal=r.signal)=>{signal.throwIfAborted();await new Promise<void>((resolve,reject)=>{const done=()=>{signal.removeEventListener('abort',abort);resolve();},timer=setTimeout(done,ms);const abort=()=>{clearTimeout(timer);reject(Error('Canary cancelled'));};signal.addEventListener('abort',abort,{once:true});});};
 try{
  if(options.phase==='seed'){
   guard(m.stage==='seeding'&&m.patients.length===0&&m.documents.length===0&&m.uploads.length===0);await r.noOtherService();
   const seeded=await seedCanary(m.run,{readAws:r.readAws,signal:r.signal,
    async preserveBaseline(){baseline=await captureSnapshot(r.db);await r.journal.save('baseline',{run:m.run,rows:baseline,objects:await r.captureOldObjects()});await save();},
    journal:append,register:role=>r.api.register(role,r.signal),
    async uploadSentinel(id){r.expect('sentinel',r.fixture('sentinel'));const document=await r.api.upload('sentinel',id,r.fixture('sentinel'),r.signal);return receipt('sentinel',document);},
    proposeCutoff:(id,doc)=>proposeCutoff(r.db,id,doc),preserve:()=>r.journal.flush()},'initial-synthetic-writes');
   await preservation();return seeded;
  }
  const p=options.preparation!;await checkPreparation(p);guard(baseline);await r.noOtherService();
  // Missing receipts, credentials and baseline are fatal; no discovery by email.
  const saved=await r.journal.read('receipts');guard(saved.run===m.run&&JSON.stringify(saved.uploads)===JSON.stringify(m.uploads)&&JSON.stringify(saved.documents)===JSON.stringify(m.documents));
  const credentials=await r.journal.read('credentials');guard(credentials.run===m.run);
  for(const role of ['canary','control'] as const){const owner=m.patients.find(v=>v.role===role)!;guard(credentials[role]);await r.api.login(role,owner.id,credentials[role],r.signal);}
  m.approvalPin=p.config.approvalSha256;await save();
  const sentinel=m.documents[0].id;guard(await fingerprint(sentinel)===m.sentinelFingerprint);
  const ports:CanaryPorts={readAws:r.readAws,signal:r.signal,now:r.now,journal:append,supervisor:r.supervisor,noOtherService:r.noOtherService,ready:r.ready,
   prepared:async()=>({sentinel:await receipt('sentinel',sentinel),sentinelSha:m.fixtures.sentinel,mixedSha:m.fixtures.mixed}),
   async checkDatabase(old,mixed){await verifyDatabaseCutoff(r.db,p,old,mixed);guard(await fingerprint(old)===m.sentinelFingerprint);},
   async uploadMixed(signal){r.expect('mixed',r.fixture('mixed'));const id=await r.api.upload('mixed',patient(),r.fixture('mixed'),signal);return receipt('mixed',id);},
   async observe(id,signal){
    const role=id===sentinel?'sentinel':'mixed';const end=r.now()+180000;
    while(true){signal.throwIfAborted();const value=await receipt(role,id);
     if(role==='sentinel'){guard(await fingerprint(id)===m.sentinelFingerprint);return value;}
     if(value.state==='completed'){const hash=await fingerprint(id);if(m.completedFingerprint)guard(hash===m.completedFingerprint);else{m.completedFingerprint=hash;await save();}return value;}
     guard(['pending','running'].includes(value.state)&&r.now()<end);await wait(1000,signal);
    }
   },
   crossPatientDenied:(id,signal)=>r.api.denied(p.controlPatientId,id,signal),verifyPreservation:preservation,
   async idleAndUnchanged(id,signal){const before=await fingerprint(id);guard(before===m.completedFingerprint);
    for(let n=0;n<3;n++){await wait(2500,signal);await r.ready(signal);guard(await fingerprint(id)===before&&await fingerprint(sentinel)===m.sentinelFingerprint);
     checkReceipt(p,await receipt('sentinel',sentinel),'sentinel',m.fixtures.sentinel,r.now());checkReceipt(p,await receipt('mixed',id),'mixed',m.fixtures.mixed,r.now(),true);}
   },verifyTemporaryCleanup:r.cleanup,verifyCoordinatorReleased:r.lockReleased,preserve:()=>r.journal.flush()};
  await executeCanary(p,r.unit,ports,'activate-synthetic-canary');await preservation();return undefined;
 }catch(error){m.stage='failed';await save();throw error;}
 finally{await r.journal.flush();}
}
