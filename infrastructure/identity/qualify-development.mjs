// Local-development checkpoint/qualification only. No production endpoint accepted.
import {readFile,mkdtemp,chmod,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import pg from '../../backend/node_modules/pg/lib/index.js';
import {createRequire} from 'node:module';
const dotenv=createRequire(new URL('../../backend/package.json',import.meta.url))('dotenv');
const root=fileURLToPath(new URL('../../',import.meta.url));
const mode=process.argv[2];if(mode!=='--checkpoint')throw Error('Explicit --checkpoint required.');
const runtime=dotenv.parse(await readFile(root+'backend/.env','utf8')),migration=dotenv.parse(await readFile(root+'backend/.env.migrations','utf8'));
if(runtime.DB_HOST!=='127.0.0.1'||runtime.DB_PORT!=='5433'||runtime.DB_NAME!=='ai_health_wallet'||migration.MIGRATION_DB_USER!=='health_wallet_migrator')throw Error('Dedicated local development identity required.');
const config={host:runtime.DB_HOST,port:5433,database:runtime.DB_NAME,user:migration.MIGRATION_DB_USER,password:migration.MIGRATION_DB_PASSWORD};
const c=new pg.Client(config);let directory;
try{
 await c.connect();await c.query("SET TIME ZONE 'UTC'");const identity=(await c.query("SELECT current_database() AS db,current_user AS role,current_setting('server_version_num')::int AS version")).rows[0];
 if(identity.db!=='ai_health_wallet'||identity.role!=='health_wallet_migrator'||identity.version<160000||identity.version>=170000)throw Error('Development PostgreSQL identity refused.');
 directory=await mkdtemp(root+'.private-evidence/prd-v2-phase1b-development-');await chmod(directory,0o700);
 const history=(await c.query('SELECT version,name,checksum FROM public.schema_migrations ORDER BY version')).rows;
 const tables=(await c.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(r=>r.tablename);
 const contents={};
 for(const table of tables){if(!/^[a-z_]+$/.test(table))throw Error('Unexpected table identifier.');
  contents[table]=(await c.query(`SELECT count(*)::int AS count,encode(sha256(convert_to(COALESCE(string_agg(to_jsonb(t)::text,E'\\n' ORDER BY to_jsonb(t)::text),''),'UTF8')),'hex') AS digest FROM public.${table} t`)).rows[0];}
 const dump=spawnSync('/usr/bin/pg_dump',['--format=custom','--no-password','--host=127.0.0.1','--port=5433','--username=health_wallet_migrator','--dbname=ai_health_wallet','--file='+directory+'/before.dump'],{env:{PATH:process.env.PATH,PGPASSWORD:config.password},encoding:'utf8',timeout:60000,maxBuffer:1024*1024});
 if(dump.status!==0)throw Error('Local backup failed; details withheld.');await chmod(directory+'/before.dump',0o600);
 const verify=spawnSync('/usr/bin/pg_restore',['--list',directory+'/before.dump'],{encoding:'utf8',timeout:10000});if(verify.status!==0)throw Error('Backup archive verification failed.');
 const record={kind:'phase1b-local-development-checkpoint',identity,history,contents,backupSha256:createHash('sha256').update(await readFile(directory+'/before.dump')).digest('hex'),dumpArchiveReadable:true};
 await writeFile(directory+'/checkpoint.json',JSON.stringify(record,null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify({checkpointDirectory:directory,identity,appliedVersions:history.map(r=>r.version),tables:tables.length,backupVerified:true}));
}catch{console.error('Local development checkpoint failed; no migration was attempted.');process.exitCode=1;}
finally{await c.end();}
