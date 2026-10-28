import {guard} from '../processing/background-config.js';
import {type AwsRead} from '../integration/guards.js';
import {checkPreparation,freshPreflight,checkReceipt,uuid,hash,type Preparation,type UploadReceipt} from './safety.js';
import {renderUnit,checkUnit,stopOwned,type UnitPlan,type Supervisor} from './supervision.js';
// Ports are explicitly supplied by a separately approved live composition.
// No API application, database pool, AWS client or worker is imported here.
export interface SeedPorts {
 readAws:AwsRead; signal:AbortSignal;
 preserveBaseline():Promise<void>;journal(event:string,values:unknown):Promise<void>;
 register(role:'canary'|'control'):Promise<string>;
 uploadSentinel(patient:string):Promise<UploadReceipt>;
 proposeCutoff(patient:string,sentinel:string):Promise<string>;
 preserve():Promise<void>;
}
export async function seedCanary(run:string,ports:SeedPorts,authorization:'initial-synthetic-writes'){
 guard(authorization==='initial-synthetic-writes'&&/^stage-c-[a-f0-9]{24}$/.test(run));
 try{
  await freshPreflight(ports.readAws);ports.signal.throwIfAborted();await ports.preserveBaseline();
  const patients:string[]=[];
  for(const role of ['canary','control'] as const){
   await freshPreflight(ports.readAws);ports.signal.throwIfAborted();await ports.journal('registration-intent',{run,role});
   const patient=await ports.register(role);guard(uuid(patient)&&!patients.includes(patient));patients.push(patient);
   await ports.journal('registration-confirmed',{run,role,patient});
  }
  await freshPreflight(ports.readAws);ports.signal.throwIfAborted();await ports.journal('sentinel-upload-intent',{run,patient:patients[0]});
  const sentinel=await ports.uploadSentinel(patients[0]);
  guard(sentinel.run===run&&sentinel.patientId===patients[0]&&sentinel.role==='sentinel'&&uuid(sentinel.documentId)&&sentinel.confirmed&&sentinel.jobCount===1&&sentinel.state==='pending'&&sentinel.attempt===0&&sentinel.extractions===0);
  await ports.journal('sentinel-confirmed',sentinel);
  const cutoff=await ports.proposeCutoff(patients[0],sentinel.documentId);
  // The seed phase stops here. It never writes an approval file or starts a unit.
  await ports.journal('cutoff-proposed',{run,patients,cutoff});return {patients,sentinel,cutoff};
 }finally{await ports.preserve();}
}
export interface CanaryPorts {
 readAws:AwsRead;signal:AbortSignal;now():number;
 // This must verify exact existing manifest, fresh receipts, fixture hashes,
 // baseline ownership and independent approval pin before returning.
 prepared():Promise<{sentinel:UploadReceipt;sentinelSha:string;mixedSha:string}>;
 checkDatabase(sentinel:string,mixed?:string):Promise<void>;
 noOtherService():Promise<void>;
 journal(event:string,values:unknown):Promise<void>;
 supervisor:Supervisor;
 ready(signal:AbortSignal):Promise<void>;
 uploadMixed(signal:AbortSignal):Promise<UploadReceipt>;
 observe(document:string,signal:AbortSignal):Promise<UploadReceipt>;
 crossPatientDenied(document:string,signal:AbortSignal):Promise<void>;
 // Compare full non-canary baseline, old S3 HEAD receipts and scoped current rows.
 verifyPreservation():Promise<void>;
 idleAndUnchanged(document:string,signal:AbortSignal):Promise<void>;
 verifyTemporaryCleanup():Promise<void>;
 verifyCoordinatorReleased():Promise<void>;
 preserve():Promise<void>;
}
export async function executeCanary(p:Preparation,unit:UnitPlan,ports:CanaryPorts,authorization:'activate-synthetic-canary'){
 guard(authorization==='activate-synthetic-canary'&&unit.run===p.run);
 p=Object.freeze({...p,config:Object.freeze({...p.config,canary:Object.freeze({...p.config.canary})})});unit=Object.freeze({...unit});
 renderUnit(unit);await checkPreparation(p);
 const deadline=AbortSignal.timeout(600000),signal=AbortSignal.any([ports.signal,deadline]);
 const step=async()=>{signal.throwIfAborted();await checkPreparation(p);};
 let mayOwnUnit=false;let mixed:string|undefined;
 async function start(){
  await step();await freshPreflight(ports.readAws);await step();await ports.noOtherService();
  await ports.journal('service-start-intent',{run:p.run,approvalSha256:p.config.approvalSha256,uploadCutoff:p.config.canary.uploadCutoff});
  // Set before launch: a lost acknowledgement still requires exact-owned inspection.
  mayOwnUnit=true;await ports.supervisor.start(renderUnit(unit),signal);
  checkUnit(unit,await ports.supervisor.inspect(),true);await ports.ready(signal);await step();
 }
 async function stop(){await stopOwned(unit,ports.supervisor);mayOwnUnit=false;await ports.verifyTemporaryCleanup();await ports.verifyCoordinatorReleased();}
 try{
  const prepared=await ports.prepared();guard(hash(prepared.sentinelSha)&&hash(prepared.mixedSha));
  checkReceipt(p,prepared.sentinel,'sentinel',prepared.sentinelSha,ports.now());
  await ports.checkDatabase(prepared.sentinel.documentId);await ports.verifyPreservation();await start();
  await ports.checkDatabase(prepared.sentinel.documentId);await ports.crossPatientDenied(prepared.sentinel.documentId,signal);
  await freshPreflight(ports.readAws);await step();await ports.journal('mixed-upload-intent',{run:p.run,sha256:prepared.mixedSha});
  const upload=await ports.uploadMixed(signal);mixed=upload.documentId;
  checkReceipt(p,upload,'mixed',prepared.mixedSha,ports.now());guard(mixed!==prepared.sentinel.documentId&&upload.key!==prepared.sentinel.key);
  await ports.journal('mixed-upload-confirmed',upload);await ports.checkDatabase(prepared.sentinel.documentId,mixed);
  const completed=await ports.observe(mixed,signal);checkReceipt(p,completed,'mixed',prepared.mixedSha,ports.now(),true);
  guard(completed.documentId===mixed&&completed.key===upload.key&&completed.versionId===upload.versionId);
  await ports.crossPatientDenied(mixed,signal);await ports.idleAndUnchanged(mixed,signal);await ports.verifyPreservation();await stop();
  // One sequential idle restart. Reuse the exact same file, pin, scope and cutoff.
  await start();await ports.idleAndUnchanged(mixed,signal);await ports.checkDatabase(prepared.sentinel.documentId,mixed);
  const sentinel=await ports.observe(prepared.sentinel.documentId,signal);
  checkReceipt(p,sentinel,'sentinel',prepared.sentinelSha,ports.now());
  guard(sentinel.documentId===prepared.sentinel.documentId&&sentinel.key===prepared.sentinel.key&&sentinel.versionId===prepared.sentinel.versionId);
  await ports.verifyPreservation();await stop();await ports.journal('completed',{run:p.run,patients:2,documents:2,jobs:2,objects:2,extractions:1});
 }finally{
  try{if(mayOwnUnit)await stop();}finally{await ports.preserve();}
 }
}
