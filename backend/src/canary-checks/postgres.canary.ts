import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {networkInterfaces} from 'node:os';
import {getDatabaseConfig} from '../config/env.js';
import {verifyDatabaseCutoff,proposeCutoff} from '../stage-c/database.js';
import {createCanaryRepository} from '../processing/background-repository.js';
import {getProcessingConfig} from '../processing/config.js';
import type {Preparation} from '../stage-c/safety.js';
const run=process.env.STAGE_B_RUN_ID;
assert.match(run??'',/^stage-b-[a-f0-9]{24}$/);assert.equal((await readFile('/stage-b-identity','utf8')).trim(),run);
assert.ok(Object.entries(networkInterfaces()).every(([n,a])=>n==='lo'||!a?.length));
assert.equal((await readFile('/proc/net/route','utf8')).trim().split('\n').length,1);
const pool=new pg.Pool({...getDatabaseConfig(),max:2,connectionTimeoutMillis:3000,statement_timeout:3000,query_timeout:5000});
assert.equal((await pool.query("SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=current_database()")).rows[0].marker,'stage-b:'+run);
const patients:string[]=[],documents:string[]=[];
const cutoff='2026-10-21T12:00:00.000Z';
async function patient(){const id=randomUUID();patients.push(id);await pool.query("INSERT INTO public.patients(id,email,password_hash,full_name) VALUES($1,$2,'$argon2id$v=19$m=65536,t=3,p=1$syntheticSalt$syntheticHashNotAnActualPassword','Synthetic Stage C')",[id,id+'@example.invalid']);return id;}
async function document(owner:string,uploaded:string){const id=randomUUID();documents.push(id);await pool.query(`INSERT INTO public.medical_documents(id,patient_id,s3_bucket,s3_object_key,original_filename,file_type,category,uploaded_at) VALUES($1,$2,'synthetic-stage-c',$3,'synthetic.pdf','pdf','lab_report',$4)`,[id,owner,'medical-documents/'+id+'.pdf',uploaded]);return id;}
test('Stage C isolated database timestamp and historical exclusion',{timeout:30000},async t=>{
 try{
 const owner=await patient(),control=await patient();
 const p={run:'stage-c-'+'c'.repeat(24),controlPatientId:control,config:{canary:{patientId:owner,uploadCutoff:cutoff}}} as Preparation;
 const sentinel=await document(owner,'2026-10-21T11:59:59.999999Z');
 await t.test('PostgreSQL microsecond pre-cutoff sentinel and empty control verified',async()=>{await verifyDatabaseCutoff(pool,p,sentinel);});
 const eligible=await document(owner,cutoff);
 await t.test('exact cutoff is eligible and fixed configuration survives revalidation',async()=>{await verifyDatabaseCutoff(pool,p,sentinel,eligible);await verifyDatabaseCutoff(pool,structuredClone(p),sentinel,eligible);});
 await t.test('actual SQL discovery, claims, recovery and metrics exclude sentinel',async()=>{
  const {repository,queueCount}=createCanaryRepository(pool,getProcessingConfig(),p.config.canary);
  assert.deepEqual((await repository.discover(10)).map(j=>j.document_id),[eligible]);assert.equal(await queueCount(),1);
  assert.equal((await repository.claim())!.document_id,eligible);assert.equal(await repository.claim(),undefined);assert.equal(await repository.recover(),0);assert.equal(await queueCount(),0);
  const old=(await pool.query('SELECT state,attempt_count FROM public.document_processing_jobs WHERE document_id=$1',[sentinel])).rows[0];assert.deepEqual(old,{state:'pending',attempt_count:0});
 });
 await t.test('wrong owner or reversed timestamp receipts fail closed',async()=>{await assert.rejects(verifyDatabaseCutoff(pool,p,eligible,sentinel));await assert.rejects(verifyDatabaseCutoff(pool,{...p,controlPatientId:owner},sentinel,eligible));});
 await t.test('cutoff proposal uses UTC database clock, not host startup clock',async()=>{
  const client=await pool.connect();try{await client.query("SET TIME ZONE 'Pacific/Auckland'");
   const proposed=await proposeCutoff(client,owner,sentinel);assert.match(proposed,/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
   const check=await client.query('SELECT $1::timestamptz > uploaded_at AS newer, abs(extract(epoch FROM ($1::timestamptz-clock_timestamp())))<2 AS near FROM public.medical_documents WHERE id=$2',[proposed,sentinel]);
   assert.equal(check.rows[0].newer,true);assert.equal(check.rows[0].near,true);
  }finally{await client.query("SET TIME ZONE 'UTC'");client.release();}
 });
 }finally{await pool.query('DELETE FROM public.medical_documents WHERE id=ANY($1::uuid[])',[documents]);await pool.query('DELETE FROM public.patients WHERE id=ANY($1::uuid[])',[patients]);await pool.end();}
});
