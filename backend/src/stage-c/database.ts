import {guard} from '../processing/background-config.js';
import type {Preparation} from './safety.js';
export interface ReadDatabase {query(sql:string,values?:unknown[]):Promise<{rows:Record<string,any>[]}>;}
// Millisecond canonical cutoff rounded UP from the PostgreSQL clock. It is
// proposed once after sentinel commit, never calculated during worker startup.
export async function proposeCutoff(db:ReadDatabase,patient:string,sentinel:string):Promise<string>{
 const result=await db.query(`SELECT to_char((date_trunc('milliseconds',clock_timestamp())+interval '1 millisecond') AT TIME ZONE 'UTC',
 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS cutoff FROM public.medical_documents
 WHERE id=$1::uuid AND patient_id=$2::uuid AND uploaded_at<=clock_timestamp()`,[sentinel,patient]);
 guard(result.rows.length===1);const cutoff=result.rows[0].cutoff;guard(typeof cutoff==='string');return cutoff;
}
// Pin UTC interpretation explicitly: to_char(timestamp AT TIME ZONE 'UTC').
export async function verifyDatabaseCutoff(db:ReadDatabase,p:Preparation,sentinel:string,mixed?:string){
 const result=await db.query(`SELECT
 clock_timestamp()>=$3::timestamptz AS cutoff_reached,
 (SELECT count(*)=1 FROM public.medical_documents WHERE id=$1::uuid AND patient_id=$2::uuid AND uploaded_at<$3::timestamptz) AS sentinel_before,
 (SELECT count(*)=0 FROM public.medical_documents WHERE patient_id=$4::uuid) AS control_empty,
 (SELECT count(*)=$6::int FROM public.medical_documents WHERE patient_id=$2::uuid) AS scope_exact,
 ($5::uuid IS NULL OR (SELECT count(*)=1 FROM public.medical_documents WHERE id=$5::uuid AND patient_id=$2::uuid AND uploaded_at>=$3::timestamptz)) AS mixed_after`,
 [sentinel,p.config.canary.patientId,p.config.canary.uploadCutoff,p.controlPatientId,mixed??null,mixed?2:1]);
 guard(result.rows.length===1&&['cutoff_reached','sentinel_before','control_empty','scope_exact','mixed_after'].every(k=>result.rows[0][k]===true));
}
