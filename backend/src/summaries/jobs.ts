import {randomUUID,randomBytes,createHash} from 'node:crypto';
import type {QueryResultRow} from 'pg';
import type {ReportedFactV1,SummaryInputV1,SummaryProvenanceV1,SummaryValidationContext} from './contracts.js';
import {canonicalSummaryJson,parseSummaryJson,summaryInputDigest,validateSummaryInput,validateSummaryOutput,validateSummaryStructure,renderSummary} from './validation.js';
import {validateExtraction} from '../processing/extraction.js';

export interface SummaryConnection {query<Row extends QueryResultRow=QueryResultRow>(sql:string,values?:unknown[]):Promise<{rows:Row[]}>;release(discard?:boolean):void;}
export interface SummaryDatabase {connect():Promise<SummaryConnection>;}
export type SummaryPipeline=Omit<SummaryProvenanceV1,'input_sha256'>;
export type SummaryJobFailure='INVALID_INPUT'|'SOURCE_INELIGIBLE'|'CONFIG_CONFLICT'|'INVALID_SUMMARY'|'LEASE_LOST'|'DATABASE_UNAVAILABLE'|'PUBLICATION_INTERRUPTED';
export class SummaryJobError extends Error {constructor(readonly code:SummaryJobFailure){super('Summary job refused: '+code);this.name='SummaryJobError';}}
export const summaryFailureCodes=['MODEL_FAILED','MODEL_TIMEOUT','INVALID_SUMMARY','LEASE_EXPIRED','CANCELLED','SOURCE_SUPERSEDED'] as const;
export type StoredSummaryFailure=typeof summaryFailureCodes[number];
export interface SummaryJobConfig {maxAttempts:number;leaseMs:number;attemptMs:number;retryBaseMs:number;retryMaxMs:number;recoveryBatch:number;}
export const defaultSummaryJobConfig:Readonly<SummaryJobConfig>=Object.freeze({maxAttempts:3,leaseMs:15000,attemptMs:60000,retryBaseMs:1000,retryMaxMs:30000,recoveryBatch:20});
export interface SummaryClaim {jobId:string;token:string;}
export interface SummarySnapshot extends QueryResultRow {id:string;document_id:string;patient_id:string;extraction_id:string;processing_attempt:number;processing_claim_token:string;extracted_text:string;source_metadata:any;extractor_version:string;source_fingerprint:string;}
export interface SummaryJob extends QueryResultRow {id:string;snapshot_id:string;document_id:string;patient_id:string;pipeline_config:SummaryPipeline;pipeline_fingerprint:string;catalogue_sha256:string;canonical_input:string;input_sha256:string;state:string;attempt_count:number;max_attempts:number;lease_token:string|null;}
const uuid=(v:unknown)=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const live=`j.id=$1 AND j.patient_id=$2 AND j.lease_token=$3 AND j.state='running' AND j.lease_expires_at>clock_timestamp() AND j.attempt_deadline_at>clock_timestamp()`;
const current=`EXISTS(SELECT 1 FROM public.summary_source_snapshots s WHERE s.id=j.snapshot_id AND s.patient_id=j.patient_id AND public.summary_source_current(s))`;

// Real OCR confidence is a fractional mean, but the canonical encoder accepts safe integers only; fractions are hashed as their text.
const integerSafe=(value:unknown):unknown=>JSON.parse(JSON.stringify(value),(_key,v)=>typeof v==='number'&&!Number.isSafeInteger(v)?String(v):v);
function snapshotSource(s:SummarySnapshot):SummaryInputV1['source'] {
 const e=validateExtraction({text:s.extracted_text,method:s.source_metadata.method,extractor:s.source_metadata.extractor,source:s.source_metadata.source});
 return {text:e.text,text_sha256:hash(e.text),original_sha256:s.source_metadata.source.sha256,
  metadata_sha256:hash(canonicalSummaryJson(integerSafe(e.metadata))),processing_attempt:s.processing_attempt,extraction_status:'completed',
  method:s.source_metadata.method,page_count:s.source_metadata.source.pageCount};
}

// No pool/environment imports, scheduler, API route or service startup. Scope is mandatory.
export function createSummaryJobRepository(database:SummaryDatabase,patientId:string,options:SummaryJobConfig={...defaultSummaryJobConfig}) {
  const config={...options};
  if(!uuid(patientId)||!Object.values(config).every(Number.isSafeInteger)||config.maxAttempts<1||config.maxAttempts>3||config.leaseMs<20||config.leaseMs>60000||config.attemptMs<config.leaseMs||config.attemptMs>300000||config.retryBaseMs<5||config.retryMaxMs<config.retryBaseMs||config.retryMaxMs>300000||config.recoveryBatch<1||config.recoveryBatch>50)throw new SummaryJobError('INVALID_INPUT');
  function id(value:unknown){if(!uuid(value))throw new SummaryJobError('INVALID_INPUT');}
  function claim(c:SummaryClaim){if(!c)throw new SummaryJobError('INVALID_INPUT');id(c.jobId);id(c.token);}
  async function tx<T>(fn:(c:SummaryConnection)=>Promise<T>):Promise<T>{
    let c:Awaited<ReturnType<SummaryDatabase['connect']>>|undefined;let discard=false;
    try{c=await database.connect();await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='2s'");await c.query("SET LOCAL statement_timeout='5s'");const out=await fn(c);await c.query('COMMIT');return out;}
    catch(e){try{await c?.query('ROLLBACK');}catch{discard=true;}const code=e instanceof SummaryJobError?e.code:((e as any)?.code==='23514'&&(e as any)?.message==='SUMMARY_LEASE_LOST'?'LEASE_LOST':((e as any)?.code==='23514'&&(e as any)?.message==='SUMMARY_SOURCE_INELIGIBLE'?'SOURCE_INELIGIBLE':'DATABASE_UNAVAILABLE'));throw new SummaryJobError(code);}
    finally{c?.release(discard);}
  }
  const identity=(c:SummaryClaim)=>[c.jobId,patientId,c.token];
  function authority(j:SummaryJob,s:SummarySnapshot):{input:SummaryInputV1;context:SummaryValidationContext;recipe:SummaryProvenanceV1}{
    try{const input=parseSummaryJson(Buffer.from(j.canonical_input),'input') as SummaryInputV1;
      const context={...input.scope,input_sha256:j.input_sha256};
      if(input.scope.request_id!==j.id||input.scope.source_ref!==j.snapshot_id)throw new Error();
      validateSummaryInput(input,context);
      if(canonicalSummaryJson(input.source)!==canonicalSummaryJson(snapshotSource(s))||hash(canonicalSummaryJson(input.facts))!==j.catalogue_sha256)throw new Error();
      const recipe={...j.pipeline_config,input_sha256:j.input_sha256};
      if(!validateSummaryStructure('SummaryProvenanceV1',recipe))throw new Error();return {input,context,recipe};
    }catch{throw new SummaryJobError('INVALID_INPUT');}
  }
  async function enqueueJob(snapshotId:string,facts:ReportedFactV1[],pipeline:SummaryPipeline):Promise<{job:SummaryJob;created:boolean}>{
      id(snapshotId);
      let catalogue:string,recipe:SummaryPipeline;
      try{catalogue=canonicalSummaryJson(facts);recipe=JSON.parse(canonicalSummaryJson(pipeline));if(!validateSummaryStructure('SummaryProvenanceV1',{...recipe,input_sha256:'0'.repeat(64)})||Object.hasOwn(recipe,'input_sha256'))throw new Error();}
      catch{throw new SummaryJobError('INVALID_INPUT');}
      return tx(async c=>{
        const s=(await c.query<SummarySnapshot>('SELECT * FROM public.summary_source_snapshots WHERE id=$1 AND patient_id=$2',[snapshotId,patientId])).rows[0];
        if(!s)throw new SummaryJobError('SOURCE_INELIGIBLE');
        const good=(await c.query('SELECT 1 FROM public.summary_source_snapshots s WHERE s.id=$1 AND s.patient_id=$2 AND public.lock_summary_source(s)',[snapshotId,patientId])).rows.length===1;
        if(!good)throw new SummaryJobError('SOURCE_INELIGIBLE');
        const jobId=randomUUID();let input:SummaryInputV1;
        try{
          input={schema_version:1,kind:'medical-summary-input',scope:{request_id:jobId,source_ref:s.id,scope_token:randomBytes(32).toString('hex')},
            source:snapshotSource(s),facts:JSON.parse(catalogue)};
          validateSummaryInput(input,{...input.scope,input_sha256:summaryInputDigest(input)});
        }catch{throw new SummaryJobError('INVALID_INPUT');}
        const body=canonicalSummaryJson(input);
        const inserted=(await c.query<SummaryJob>(`INSERT INTO public.medical_summary_jobs(id,snapshot_id,document_id,patient_id,pipeline_config,pipeline_fingerprint,catalogue_sha256,canonical_input,input_sha256,max_attempts)
          VALUES($1,$2,$3,$4,$5::jsonb,public.summary_digest($5::jsonb::text),$6,$7,public.summary_digest($7),$8)
          ON CONFLICT(snapshot_id,pipeline_fingerprint) DO NOTHING RETURNING *`,[jobId,s.id,s.document_id,patientId,canonicalSummaryJson(recipe),hash(catalogue),body,config.maxAttempts])).rows[0];
        if(inserted)return {job:inserted,created:true};
        const old=(await c.query<SummaryJob>('SELECT * FROM public.medical_summary_jobs WHERE snapshot_id=$1 AND patient_id=$2 AND pipeline_fingerprint=public.summary_digest($3::jsonb::text)',[s.id,patientId,canonicalSummaryJson(recipe)])).rows[0];
        if(!old||old.catalogue_sha256!==hash(catalogue))throw new SummaryJobError('CONFIG_CONFLICT');return {job:old,created:false};
      });
    }
  return {
    get patientScope(){return patientId;},
    enqueueWithOutcome:enqueueJob,
    async enqueue(snapshotId:string,facts:ReportedFactV1[],pipeline:SummaryPipeline){return (await enqueueJob(snapshotId,facts,pipeline)).job;},
    async captureSnapshot(documentId:string):Promise<SummarySnapshot>{
      id(documentId);return tx(async c=>{
        // INSERT trigger rechecks and locks the actual current OCR rows.
        const row=(await c.query<SummarySnapshot>(`INSERT INTO public.summary_source_snapshots
          (document_id,patient_id,extraction_id,processing_attempt,processing_claim_token,extracted_text,source_metadata,extractor_version,source_fingerprint)
          SELECT e.document_id,e.patient_id,e.id,e.processing_attempt,e.processing_claim_token,e.extracted_text,e.source_metadata,e.extractor_version,
            public.summary_extraction_fingerprint(e.id,e.extracted_text,e.source_metadata,e.extractor_version,e.processing_attempt,e.processing_claim_token)
          FROM public.extracted_medical_text e JOIN public.document_processing_jobs j ON (j.document_id,j.patient_id)=(e.document_id,e.patient_id)
          JOIN public.medical_documents d ON (d.id,d.patient_id)=(e.document_id,e.patient_id)
          WHERE e.document_id=$1 AND e.patient_id=$2 AND e.processing_status='completed' AND j.state='completed' AND public.document_accessible(d.id,d.patient_id)
            AND e.processing_attempt=j.attempt_count AND e.processing_claim_token IS NOT NULL AND octet_length(e.extracted_text)<=32768
          ON CONFLICT(extraction_id,processing_attempt,processing_claim_token,source_fingerprint) DO NOTHING RETURNING *`,[documentId,patientId])).rows[0];
        if(row)return row;
        const existing=(await c.query<SummarySnapshot>(`SELECT s.* FROM public.summary_source_snapshots s WHERE s.document_id=$1 AND s.patient_id=$2 AND public.summary_source_current(s)`,[documentId,patientId])).rows[0];
        if(!existing)throw new SummaryJobError('SOURCE_INELIGIBLE');return existing;
      });
    },
    async getSnapshot(snapshotId:string){id(snapshotId);return tx(async c=>(await c.query<SummarySnapshot>('SELECT * FROM public.summary_source_snapshots WHERE id=$1 AND patient_id=$2',[snapshotId,patientId])).rows[0]);},
    async getJob(jobId:string){id(jobId);return tx(async c=>(await c.query<SummaryJob>('SELECT * FROM public.medical_summary_jobs WHERE id=$1 AND patient_id=$2',[jobId,patientId])).rows[0]);},
    async discover(limit=20){if(!Number.isSafeInteger(limit)||limit<1||limit>50)throw new SummaryJobError('INVALID_INPUT');return tx(async c=>(await c.query<SummaryJob>(`SELECT j.* FROM public.medical_summary_jobs j WHERE j.patient_id=$1 AND j.state IN ('pending','retry_wait') AND j.next_attempt_at<=clock_timestamp() AND j.attempt_count<j.max_attempts AND ${current} ORDER BY j.next_attempt_at,j.created_at,j.id LIMIT $2`,[patientId,limit])).rows);},
    async claim():Promise<SummaryJob|undefined>{
      try{return await tx(async c=>{
        try{return (await c.query<SummaryJob>(`WITH candidate AS (SELECT j.id FROM public.medical_summary_jobs j
          WHERE j.patient_id=$1 AND j.state IN ('pending','retry_wait') AND j.next_attempt_at<=clock_timestamp() AND j.attempt_count<j.max_attempts AND ${current}
          AND NOT EXISTS(SELECT 1 FROM public.medical_summary_jobs busy WHERE busy.state='running')
          ORDER BY j.next_attempt_at,j.created_at,j.id LIMIT 1 FOR UPDATE OF j SKIP LOCKED)
          UPDATE public.medical_summary_jobs j SET state='running',attempt_count=j.attempt_count+1,started_at=clock_timestamp(),finished_at=NULL,
            lease_token=$2,lease_expires_at=clock_timestamp()+$3*interval '1 millisecond',attempt_deadline_at=clock_timestamp()+$4*interval '1 millisecond'
          FROM candidate x WHERE j.id=x.id AND j.patient_id=$1 RETURNING j.*`,[patientId,randomUUID(),config.leaseMs,config.attemptMs])).rows[0];}
        catch(e){if((e as any)?.code==='23505'&&(e as any)?.constraint==='summary_single_running')throw new SummaryJobError('LEASE_LOST');throw e;}
      });}catch(e){if(e instanceof SummaryJobError&&e.code==='LEASE_LOST')return undefined;throw e;}
    },
    async generationInput(c:SummaryClaim){claim(c);return tx(async db=>{const j=(await db.query<SummaryJob>(`SELECT j.* FROM public.medical_summary_jobs j WHERE ${live} AND ${current}`,identity(c))).rows[0];if(!j)throw new SummaryJobError('LEASE_LOST');const s=(await db.query<SummarySnapshot>('SELECT * FROM public.summary_source_snapshots WHERE id=$1 AND patient_id=$2',[j.snapshot_id,patientId])).rows[0];if(!s)throw new SummaryJobError('SOURCE_INELIGIBLE');return authority(j,s);});},
    async heartbeat(c:SummaryClaim){claim(c);return tx(async db=>(await db.query(`UPDATE public.medical_summary_jobs j SET lease_expires_at=LEAST(attempt_deadline_at,clock_timestamp()+$4*interval '1 millisecond') WHERE ${live} AND ${current} RETURNING j.id`,[...identity(c),config.leaseMs])).rows.length===1);},
    async publish(c:SummaryClaim,candidate:unknown,signal?:AbortSignal):Promise<boolean>{
      claim(c);return tx(async db=>{
        const interrupted=()=>{if(signal?.aborted)throw new SummaryJobError('PUBLICATION_INTERRUPTED');};interrupted();
        let j=(await db.query<SummaryJob>(`SELECT j.* FROM public.medical_summary_jobs j WHERE ${live}`,identity(c))).rows[0];if(!j)return false;
        const s=(await db.query<SummarySnapshot>('SELECT * FROM public.summary_source_snapshots WHERE id=$1 AND patient_id=$2',[j.snapshot_id,patientId])).rows[0];
        if(!s||(await db.query('SELECT 1 FROM public.summary_source_snapshots s WHERE s.id=$1 AND s.patient_id=$2 AND public.lock_summary_source(s)',[j.snapshot_id,patientId])).rows.length!==1)return false;
        j=(await db.query<SummaryJob>(`SELECT j.* FROM public.medical_summary_jobs j WHERE ${live} FOR UPDATE`,identity(c))).rows[0];if(!j)return false;
        interrupted();const {input,context,recipe}=authority(j,s);let output,text;
        try{output=validateSummaryOutput(candidate,input,context,recipe);text=renderSummary(output,input,context,recipe);}catch{throw new SummaryJobError('INVALID_SUMMARY');}
        await db.query(`INSERT INTO public.ai_report_summaries(document_id,patient_id,summary_text,processing_status,model_name,model_version,generated_at,
          summary_contract_version,source_snapshot_id,summary_job_id,source_fingerprint,pipeline_fingerprint,input_sha256,structured_output,provenance,accepted_attempt,publication_token)
          VALUES($1,$2,$3,'completed',$4,$5,clock_timestamp(),1,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14)`,
          [j.document_id,patientId,text,recipe.model_id,recipe.model_revision,j.snapshot_id,j.id,s.source_fingerprint,j.pipeline_fingerprint,j.input_sha256,canonicalSummaryJson(output),canonicalSummaryJson(recipe),j.attempt_count,c.token]);
        interrupted();
        const done=await db.query(`UPDATE public.medical_summary_jobs j SET state='completed',finished_at=clock_timestamp(),completion_token=lease_token,lease_token=NULL,lease_expires_at=NULL,attempt_deadline_at=NULL,last_error_code=NULL WHERE ${live} RETURNING id`,identity(c));
        if(done.rows.length!==1)throw new SummaryJobError('LEASE_LOST');interrupted();return true;
      });
    },
    async fail(c:SummaryClaim,code:StoredSummaryFailure,retryable=false){claim(c);if(!summaryFailureCodes.includes(code)||typeof retryable!=='boolean')throw new SummaryJobError('INVALID_INPUT');return tx(async db=>(await db.query(`UPDATE public.medical_summary_jobs j SET state=CASE WHEN $5 AND attempt_count<max_attempts THEN 'retry_wait' ELSE 'failed' END,finished_at=clock_timestamp(),lease_token=NULL,lease_expires_at=NULL,attempt_deadline_at=NULL,last_error_code=$4,next_attempt_at=clock_timestamp()+LEAST($7::double precision,$6*power(2,attempt_count-1))*interval '1 millisecond' WHERE ${live} RETURNING id`,[...identity(c),code,retryable,config.retryBaseMs,config.retryMaxMs])).rows.length===1);},
    async retry(jobId:string){id(jobId);return tx(async db=>(await db.query(`UPDATE public.medical_summary_jobs j SET state='retry_wait',next_attempt_at=clock_timestamp(),last_error_code='MODEL_FAILED' WHERE j.id=$1 AND j.patient_id=$2 AND j.state='failed' AND j.attempt_count<j.max_attempts AND ${current} RETURNING id`,[jobId,patientId])).rows.length===1);},
    async cancel(jobId:string){id(jobId);return tx(async db=>(await db.query(`UPDATE public.medical_summary_jobs SET state='cancelled',finished_at=clock_timestamp(),lease_token=NULL,lease_expires_at=NULL,attempt_deadline_at=NULL,last_error_code='CANCELLED' WHERE id=$1 AND patient_id=$2 AND state IN ('pending','retry_wait','running') RETURNING id`,[jobId,patientId])).rows.length===1);},
    async recover(){return tx(async db=>(await db.query(`WITH candidates AS(SELECT j.id FROM public.medical_summary_jobs j WHERE j.patient_id=$1
      AND j.state IN ('pending','retry_wait','running') AND (NOT ${current} OR (j.state='running' AND (j.lease_expires_at<=clock_timestamp() OR j.attempt_deadline_at<=clock_timestamp())))
      ORDER BY j.created_at,j.id LIMIT $2 FOR UPDATE OF j SKIP LOCKED)
      UPDATE public.medical_summary_jobs j SET state=CASE WHEN NOT ${current} THEN 'superseded' WHEN attempt_count<max_attempts THEN 'retry_wait' ELSE 'failed' END,
      finished_at=clock_timestamp(),lease_token=NULL,lease_expires_at=NULL,attempt_deadline_at=NULL,
      last_error_code=CASE WHEN NOT ${current} THEN 'SOURCE_SUPERSEDED' ELSE 'LEASE_EXPIRED' END,
      next_attempt_at=clock_timestamp()+LEAST($4::double precision,$3*power(2,GREATEST(attempt_count-1,0)))*interval '1 millisecond'
      FROM candidates x WHERE j.id=x.id AND j.patient_id=$1 RETURNING j.id`,[patientId,config.recoveryBatch,config.retryBaseMs,config.retryMaxMs])).rows.length);},
    async summaries(documentId:string){id(documentId);return tx(async db=>(await db.query(`SELECT a.*,s.extraction_id,s.processing_attempt,s.extractor_version,CASE WHEN a.summary_contract_version=1 THEN public.summary_source_current(s) ELSE false END AS is_current
      FROM public.ai_report_summaries a LEFT JOIN public.summary_source_snapshots s ON s.id=a.source_snapshot_id AND s.patient_id=a.patient_id
      WHERE a.document_id=$1 AND a.patient_id=$2 AND a.processing_status='completed' AND a.summary_contract_version=1 AND public.summary_source_current(s) ORDER BY a.created_at DESC,a.id LIMIT 50`,[documentId,patientId])).rows);},
  };
}
