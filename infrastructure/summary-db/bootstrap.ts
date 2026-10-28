import pg from '../../backend/node_modules/pg/lib/index.js';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {loadMigrations,applyMigration} from '../../backend/src/database/migrations.js';
import {closeMigrationPool} from '../../backend/src/database/migration-pool.js';
import {assertIsolated} from '../stage-b/isolation.js';
await assertIsolated();
const {parse}=createRequire(new URL('../../backend/package.json',import.meta.url))('dotenv');
const admin=parse(await readFile('/work/infrastructure/.env','utf8'));
const runtime=parse(await readFile('/work/backend/.env','utf8'));
const migration=parse(await readFile('/work/backend/.env.migrations','utf8'));
const client=new pg.Client({host:'127.0.0.1',port:5433,database:'ai_health_wallet',user:'health_wallet_user',password:admin.POSTGRES_PASSWORD});
try{
 await client.connect();
 const identity=(await client.query('SELECT current_database() AS db,current_user AS role,current_setting(\'server_version_num\')::int AS version')).rows[0];
 if(identity.db!=='ai_health_wallet'||identity.role!=='health_wallet_user'||identity.version<160000||identity.version>=170000)throw Error('Isolated bootstrap identity refused');
 if((await client.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'")).rows[0].n!==0)throw Error('Disposable database is not empty');
 await client.query(`CREATE TABLE public.schema_migrations(version TEXT PRIMARY KEY CHECK(version ~ '^[0-9]{4}$'),name TEXT NOT NULL UNIQUE,checksum TEXT NOT NULL CHECK(checksum ~ '^[0-9a-f]{64}$'),applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
 const files=await loadMigrations();if(files.map(f=>f.version).join(',')!=='0001,0002,0003,0004')throw Error('Migration inventory mismatch');
 await applyMigration(client,files[0]);
 // Legacy synthetic rows exist before 0003/0004 and must survive unchanged.
 await client.query(`INSERT INTO public.patients(id,email,password_hash,full_name)
 VALUES('11111111-1111-4111-8111-111111111111','legacy@example.invalid','$argon2id$v=19$m=65536,t=3,p=1$syntheticSalt$syntheticHashNotAnActualPassword','Synthetic legacy')`);
 await client.query(`INSERT INTO public.medical_documents(id,patient_id,s3_bucket,s3_object_key,original_filename,file_type,category,processing_status)
 VALUES('22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111','synthetic','synthetic-legacy','synthetic.pdf','pdf','lab_report','completed')`);
 await client.query(`INSERT INTO public.extracted_medical_text(document_id,patient_id,extracted_text,processing_status)
 VALUES('22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111','Synthetic legacy extraction','completed')`);
 await client.query(`INSERT INTO public.ai_report_summaries(id,document_id,patient_id,summary_text,processing_status,generated_at)
 VALUES('33333333-3333-4333-8333-333333333333','22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111','Synthetic legacy summary','completed',clock_timestamp())`);
 // Fresh test-only credentials contain hexadecimal characters exclusively.
 for(const password of [runtime.DB_PASSWORD,migration.MIGRATION_DB_PASSWORD])if(!/^[a-f0-9]{64}$/.test(password))throw Error('Test credential format refused');
 const sql=(await readFile('/work/infrastructure/database-roles.sql','utf8')).replace('__APP_SCRAM__',runtime.DB_PASSWORD).replace('__MIGRATOR_SCRAM__',migration.MIGRATION_DB_PASSWORD);
 await client.query(sql);
 await client.query(`COMMENT ON DATABASE ai_health_wallet IS 'stage-b:${process.env.STAGE_B_RUN_ID}'`);
 console.log(JSON.stringify({bootstrap:'passed',initialMigration:files[0].version,checksumVerified:createHash('sha256').update(files[0].sql).digest('hex')===files[0].checksum}));
}catch{console.error('Isolated bootstrap failed; details withheld.');process.exitCode=1;}
finally{await client.end();await closeMigrationPool();}
