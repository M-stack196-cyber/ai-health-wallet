import {createHash} from 'node:crypto';
import {guard} from '../processing/background-config.js';
import {assertSystemIdentity,artifactRoles,validateSystemPlan,type ArtifactPins,type SystemPlan,type TransientIdentity,type ProcessIdentity} from './system-supervision.js';
export const systemProofChecks=['inside-protection','effective-limits','native-containment','graceful-cleanup','controller-loss-cleanup','runtime-expiry-cleanup'] as const;
export interface ApplicationSystemProof {
  version:3;kind:'health-wallet-application-system-supervision';manager:'system';passed:true;
  createdAt:string;bootId:string;run:string;artifacts:ArtifactPins;
  worker:TransientIdentity;controller:TransientIdentity;
  originalProcesses:readonly ProcessIdentity[];
  checks:readonly {check:typeof systemProofChecks[number];passed:true}[];
}
export interface SystemProofExpectation {plan:SystemPlan;workerInvocationId:string;receiptSha256:string;now:number;}
// Bytes and independent launch pins must come from a future private-file reader.
// No receipt is generated from a successful start or Python-probe booleans.
export function verifyApplicationSystemProof(bytes:Uint8Array,expected:SystemProofExpectation):ApplicationSystemProof {
  validateSystemPlan(expected.plan);guard(bytes.byteLength>0&&bytes.byteLength<=65536);
  guard(/^[a-f0-9]{64}$/.test(expected.receiptSha256)&&createHash('sha256').update(bytes).digest('hex')===expected.receiptSha256);
  let r:ApplicationSystemProof;try{r=JSON.parse(Buffer.from(bytes).toString('utf8')) as ApplicationSystemProof;}catch{guard(false);}
  guard(r.version===3&&r.kind==='health-wallet-application-system-supervision'&&r.manager==='system'&&r.passed===true);
  guard(r.run===expected.plan.run&&r.bootId===expected.plan.bootId);
  const when=Date.parse(r.createdAt);guard(Number.isFinite(expected.now)&&Number.isFinite(when)&&when<=expected.now&&expected.now-when<=3600000);
  guard(r.artifacts&&Object.keys(r.artifacts).sort().join(',')===[...artifactRoles].sort().join(','));
  for(const role of artifactRoles){const pin=expected.plan.artifacts[role];guard(r.artifacts[role]?.path===pin.path&&r.artifacts[role]?.sha256===pin.sha256);}
  assertSystemIdentity(expected.plan,r.worker,'worker',expected.workerInvocationId);
  assertSystemIdentity(expected.plan,r.controller,'controller',expected.plan.controllerInvocationId);
  guard(Array.isArray(r.originalProcesses)&&r.originalProcesses.length>=2&&r.originalProcesses.length<=128);
  guard(new Set(r.originalProcesses.map(p=>p.pid)).size===r.originalProcesses.length);
  const uid=r.originalProcesses[0].uid;guard(Number.isSafeInteger(uid)&&uid>0);
  for(const p of r.originalProcesses)guard(Number.isSafeInteger(p.pid)&&p.pid>1&&/^\d+$/.test(p.startTime)&&p.uid===uid&&p.bootId===r.bootId);
  guard(Array.isArray(r.checks)&&r.checks.length===systemProofChecks.length&&systemProofChecks.every(name=>r.checks.filter(c=>c.check===name&&c.passed===true).length===1));
  return r;
}
