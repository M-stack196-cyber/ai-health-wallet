import {randomBytes} from 'node:crypto';
import {guard} from '../processing/background-config.js';
import {createGuardedStorage,target,type RecordOfUpload} from '../integration/guards.js';
import type {DocumentStorage} from '../documents/storage.js';
import type {OriginalStorage} from '../documents/original-reader.js';
import {uuid} from './safety.js';
// Reuses the Gate 2 storage journal/fixture guards, without its direct worker.
// A=sentinel and C=mixed. Both belong to the same newly approved canary patient.
export function canaryStorage(base:DocumentStorage&OriginalStorage,uploads:RecordOfUpload[],save:()=>Promise<void>){
 const guarded=createGuardedStorage(base,{...target,mode:'run',liveWrites:true},uploads,save);
 return {storage:guarded.storage,expect(role:'sentinel'|'mixed',bytes:Buffer){guarded.expect(role==='sentinel'?'A':'C',bytes,'application/pdf');}};
}
export interface SyntheticCredential {email:string;password:string;}
export function syntheticApi(baseUrl:string,run:string,request:typeof fetch,remember?:(role:'canary'|'control',credential:SyntheticCredential)=>Promise<void>){
 const url=new URL(baseUrl);guard(url.origin===baseUrl&&url.protocol==='http:'&&url.hostname==='127.0.0.1'&&!url.username&&!url.password&&!!url.port);
 guard(/^stage-c-[a-f0-9]{24}$/.test(run));const sessions=new Map<string,string>(),attempts=new Set<string>(),owners=new Map<string,string>();
 async function call(path:string,method:string,body:FormData|Record<string,string>|undefined,token:string|undefined,signal:AbortSignal){
  signal.throwIfAborted();const headers:Record<string,string>={};if(token)headers.Authorization='Bearer '+token;
  if(body&&!(body instanceof FormData))headers['Content-Type']='application/json';
  const response=await request(baseUrl+path,{method,headers,body:body instanceof FormData?body:body?JSON.stringify(body):undefined,
   redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(30000)])});
  guard(Number(response.headers.get('content-length')??0)<=1048576);
  const reader=response.body?.getReader();guard(reader);const chunks:Uint8Array[]=[];let length=0;
  try{while(true){const item=await reader.read();if(item.done)break;length+=item.value.length;guard(length<=1048576);chunks.push(item.value);}}
  finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  return {status:response.status,json:JSON.parse(Buffer.concat(chunks).toString())};
 }
 return {
  async register(role:'canary'|'control',signal:AbortSignal){
   guard(!attempts.has('register-'+role));attempts.add('register-'+role);
   const email=run+'-'+role+'@example.invalid',password=randomBytes(32).toString('base64url');
   if(remember)await remember(role,{email,password});
   const r=await call('/api/v1/auth/register','POST',{email,password,full_name:'Synthetic Stage C'},undefined,signal);
   guard(r.status===201&&r.json.success&&uuid(r.json.patient?.id));const id=r.json.patient.id;
   const login=await call('/api/v1/auth/login','POST',{email,password},undefined,signal);guard(login.status===200&&typeof login.json.access_token==='string');
   guard(!sessions.has(id));sessions.set(id,login.json.access_token);owners.set(role,id);return id;
  },
  async login(role:'canary'|'control',patient:string,credential:SyntheticCredential,signal:AbortSignal){
   guard(uuid(patient)&&!owners.has(role)&&credential.email===run+'-'+role+'@example.invalid'&&/^[a-zA-Z0-9_-]{43}$/.test(credential.password));
   const result=await call('/api/v1/auth/login','POST',{email:credential.email,password:credential.password},undefined,signal);guard(result.status===200&&typeof result.json.access_token==='string');
   const me=await call('/api/v1/patients/me','GET',undefined,result.json.access_token,signal);guard(me.status===200&&me.json.patient?.id===patient);
   owners.set(role,patient);sessions.set(patient,result.json.access_token);
  },
  async upload(role:'sentinel'|'mixed',patient:string,bytes:Buffer,signal:AbortSignal){
   guard(!attempts.has('upload-'+role)&&sessions.has(patient)&&owners.get('canary')===patient&&bytes.length>0&&bytes.length<=1048576);attempts.add('upload-'+role);
   const body=new FormData();body.set('category','lab_report');body.set('hospital_name','Synthetic Stage C');
   body.set('file',new Blob([new Uint8Array(bytes)],{type:'application/pdf'}),'synthetic-'+role+'.pdf');
   const result=await call('/api/v1/documents','POST',body,sessions.get(patient),signal);
   guard(result.status===201&&result.json.success&&uuid(result.json.document?.id));return result.json.document.id as string;
  },
  async denied(control:string,document:string,signal:AbortSignal){
   guard(sessions.has(control)&&owners.get('control')===control&&uuid(document));
   for(const suffix of ['','/download'])guard((await call('/api/v1/documents/'+document+suffix,'GET',undefined,sessions.get(control),signal)).status===404);
  },
  close(){sessions.clear();owners.clear();}
 };
}
