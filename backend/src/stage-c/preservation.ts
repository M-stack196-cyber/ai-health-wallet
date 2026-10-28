import {guard} from '../processing/background-config.js';
import {assertPreserved,type Snapshot} from '../integration/guards.js';
export interface SnapshotDatabase {connect():Promise<{query(sql:string,values?:unknown[]):Promise<{rows:any[]}>;release():void}>;}
export async function captureSnapshot(db:SnapshotDatabase):Promise<Snapshot>{
 const c=await db.connect();try{
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const tables=(await c.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'schema_migrations' ORDER BY tablename")).rows;
  const out:Snapshot={};for(const {tablename}of tables){guard(/^[a-z_]+$/.test(tablename));out[tablename]=(await c.query(`SELECT COALESCE(to_jsonb(t)->>'id',to_jsonb(t)->>'document_id',to_jsonb(t)->>'version') AS id, md5(to_jsonb(t)::text) AS hash FROM public."${tablename}" t ORDER BY 1`)).rows;}
  await c.query('COMMIT');guard(Buffer.byteLength(JSON.stringify(out))<=900000);return out;
 }catch(error){await c.query('ROLLBACK').catch(()=>{});throw error;}finally{c.release();}
}
export function preservationAllowlist(patients:string[],documents:string[],extractions:string[]){return {patients:new Set(patients),medical_documents:new Set(documents),document_processing_jobs:new Set(documents),extracted_medical_text:new Set(extractions)};}
export function verifySnapshot(before:Snapshot,after:Snapshot,patients:string[],documents:string[],extractions:string[]){assertPreserved(before,after,preservationAllowlist(patients,documents,extractions));}
