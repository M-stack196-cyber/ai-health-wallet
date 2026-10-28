// Apply only the named local-development migration sequence after a verified checkpoint.
import {readFile,writeFile,realpath} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import pg from '../../backend/node_modules/pg/lib/index.js';
const root=fileURLToPath(new URL('../../',import.meta.url)),dotenv=createRequire(new URL('../../backend/package.json',import.meta.url))('dotenv');
if(process.argv[2]!=='--apply-checkpoint'||process.argv.length!==4)throw Error('Explicit --apply-checkpoint directory required.');
const dir=await realpath(process.argv[3]);if(!dir.startsWith(root+'.private-evidence/prd-v2-phase1b-development-'))throw Error('Checkpoint path refused.');
const checkpoint=JSON.parse(await readFile(dir+'/checkpoint.json','utf8'));
if(createHash('sha256').update(await readFile(dir+'/before.dump')).digest('hex')!==checkpoint.backupSha256)throw Error('Backup changed.');
const env=dotenv.parse(await readFile(root+'backend/.env','utf8')),migration=dotenv.parse(await readFile(root+'backend/.env.migrations','utf8'));
if(env.DB_HOST!=='127.0.0.1'||env.DB_PORT!=='5433'||env.DB_NAME!=='ai_health_wallet'||migration.MIGRATION_DB_USER!=='health_wallet_migrator')throw Error('Local development identity required.');
const c=new pg.Client({host:'127.0.0.1',port:5433,database:'ai_health_wallet',user:migration.MIGRATION_DB_USER,password:migration.MIGRATION_DB_PASSWORD});
try{
 await c.connect();await c.query("SET TIME ZONE 'UTC'");const history=(await c.query('SELECT version,name,checksum FROM schema_migrations ORDER BY version')).rows;
 if(JSON.stringify(history)!==JSON.stringify(checkpoint.history))throw Error('Migration history changed since checkpoint.');
 const columns={};
 for(const table of Object.keys(checkpoint.contents)){
  columns[table]=(await c.query('SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position',['public',table])).rows.map(x=>x.column_name);
  const now=(await c.query(`SELECT count(*)::int AS count,encode(sha256(convert_to(COALESCE(string_agg(to_jsonb(t)::text,E'\\n' ORDER BY to_jsonb(t)::text),''),'UTF8')),'hex') AS digest FROM public.${table} t`)).rows[0];
  if(JSON.stringify(now)!==JSON.stringify(checkpoint.contents[table]))throw Error('Development data changed since checkpoint.');
 }
 await writeFile(dir+'/original-columns.json',JSON.stringify(columns,null,2)+'\n',{mode:0o600});
 const {runMigrations}=await import('../../backend/src/database/migrations.ts');
 const {closeMigrationPool}=await import('../../backend/src/database/migration-pool.ts');
 let messages;try{messages=await runMigrations('up');}finally{await closeMigrationPool();}
 const preservation={};
 for(const table of Object.keys(columns)){
  const current=(await c.query('SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2',['public',table])).rows.map(x=>x.column_name);
  const extra=current.filter(x=>!columns[table].includes(x));
  const where=table==='schema_migrations'?' WHERE t.version=ANY($2::text[])':'';
  const values=table==='schema_migrations'?[extra,checkpoint.history.map(x=>x.version)]:[extra];
  const now=(await c.query(`SELECT count(*)::int AS count,encode(sha256(convert_to(COALESCE(string_agg((to_jsonb(t)-$1::text[])::text,E'\\n' ORDER BY (to_jsonb(t)-$1::text[])::text),''),'UTF8')),'hex') AS digest FROM public.${table} t${where}`,values)).rows[0];
  preservation[table]=JSON.stringify(now)===JSON.stringify(checkpoint.contents[table]);
 }
 const schema=(await c.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('patients','patient_auth_challenges','patient_auth_sessions','patient_security_events','patient_security_email_deliveries','patient_security_email_payloads') ORDER BY table_name,ordinal_position")).rows;
 const afterHistory=(await c.query('SELECT version,name,checksum FROM schema_migrations ORDER BY version')).rows;
 const dump=spawnSync('/usr/bin/pg_dump',['--format=custom','--schema-only','--no-password','--host=127.0.0.1','--port=5433','--username=health_wallet_migrator','--dbname=ai_health_wallet','--file='+dir+'/development-schema.dump'],{env:{PATH:process.env.PATH,PGPASSWORD:migration.MIGRATION_DB_PASSWORD},encoding:'utf8',timeout:60000});
 if(dump.status!==0)throw Error('Schema archive failed.');
 const qualified={kind:'phase1b-development-migration-qualification',messages,afterHistory,preservation,allExistingDataPreserved:Object.values(preservation).every(Boolean),schema,schemaArchiveSha256:createHash('sha256').update(await readFile(dir+'/development-schema.dump')).digest('hex')};
 await writeFile(dir+'/qualification.json',JSON.stringify(qualified,null,2)+'\n',{mode:0o600});
 if(!qualified.allExistingDataPreserved)throw Error('Original data changed during qualification; inspect private checkpoint.');
 console.log(JSON.stringify({migrationMessages:messages,versions:afterHistory.map(x=>x.version),originalTablesPreserved:Object.keys(preservation).length,allExistingDataPreserved:true,schemaArchive:dir+'/development-schema.dump'}));
}catch{console.error('Local development qualification failed; inspect private checkpoint and migration status. No destructive restore was attempted.');process.exitCode=1;}
finally{await c.end();}
