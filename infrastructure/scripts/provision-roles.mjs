import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';

const root = new URL('../../', import.meta.url);
const backend = new URL('backend/', root);
const require = createRequire(new URL('package.json', backend));
const { parse } = require('dotenv');
const { Client } = require('pg');
const runtimeFile = new URL('.env', backend);
const migrationFile = new URL('.env.migrations', backend);
const pendingFile = new URL('.env.roles.pending', backend);
const lockFile = new URL('.env.roles.lock', backend);
const roleNames = ['health_wallet_app', 'health_wallet_migrator'];

function fail(message) { throw new Error(message); }
function readEnv(file) {
  if (!fs.existsSync(file)) return {};
  if ((fs.statSync(file).mode & 0o077) !== 0) fail('Credential files must be accessible only to their owner.');
  return parse(fs.readFileSync(file));
}
function privateWrite(file, contents) {
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === contents) return;
  const temporary = new URL(file.href + '.tmp');
  const mode = fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : 0o600;
  fs.writeFileSync(temporary, contents, { mode, flag: 'wx' });
  fs.renameSync(temporary, file);
}
function admin(sql) {
  // The dedicated container's local bootstrap socket is the only elevated path.
  // Neither plaintext passwords nor verifiers appear in process arguments.
  try {
    return execFileSync('docker', ['exec', '-i', 'ai-health-wallet-postgres', 'psql',
      '-X', '-w', '-q', '-h', '/var/run/postgresql', '-U', 'health_wallet_user', '-d', 'ai_health_wallet',
      '-At', '-v', 'ON_ERROR_STOP=1'], {
      input: sql, encoding: 'utf8', timeout: 45000,
      maxBuffer: 4 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch { fail('Dedicated-container database operation failed. No SQL or credential details were logged.'); }
}

// ASCII random secrets avoid SASLprep ambiguity. Store only PostgreSQL's standard
// SCRAM verifier in role DDL, so SQL text never contains the actual password.
function scram(password) {
  const salt = randomBytes(16);
  const salted = pbkdf2Sync(password, salt, 4096, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest('base64');
  const serverKey = createHmac('sha256', salted).update('Server Key').digest('base64');
  return 'SCRAM-SHA-256$4096:' + salt.toString('base64') + '$' + storedKey + ':' + serverKey;
}
async function verifyLogin(user, password) {
  const client = new Client({ host: '127.0.0.1', port: 5433, database: 'ai_health_wallet',
    user, password, connectionTimeoutMillis: 3000, query_timeout: 5000 });
  try {
    await client.connect();
    const result = await client.query('SELECT current_user');
    if (result.rows[0].current_user !== user) fail('Database identity verification failed.');
  } catch { fail('A provisioned role could not authenticate with its stored local credentials. No password was changed.'); }
  finally { await client.end(); }
}

function snapshot(tables) {
  const counts = tables.flatMap(name => ["'" + name + "'", '(SELECT count(*) FROM public."' + name + '")']).join(', ');
  return JSON.parse(admin(`SELECT json_build_object(
    'relations', (SELECT json_agg(json_build_array(oid, relname, relkind) ORDER BY relname) FROM pg_class WHERE relnamespace = 'public'::regnamespace),
    'indexes', (SELECT json_agg(indexdef ORDER BY indexname) FROM pg_indexes WHERE schemaname = 'public'),
    'constraints', (SELECT json_agg(json_build_array(conname, pg_get_constraintdef(oid)) ORDER BY conrelid, conname) FROM pg_constraint WHERE connamespace = 'public'::regnamespace),
    'functions', (SELECT json_agg(json_build_array(oid, pg_get_functiondef(oid)) ORDER BY oid) FROM pg_proc WHERE pronamespace = 'public'::regnamespace),
    'ledger', (SELECT json_agg(row_to_json(m) ORDER BY version) FROM public.schema_migrations m),
    'counts', json_build_object(${counts})
  );`));
}

let lock;
try {
  try { lock = fs.openSync(lockFile, 'wx', 0o600); }
  catch { fail('Provisioning lock exists. Confirm no provisioning process is running before removing backend/.env.roles.lock.'); }
  fs.writeFileSync(lock, String(process.pid));
  const runtime = readEnv(runtimeFile);
  const migrations = readEnv(migrationFile);
  const pending = readEnv(pendingFile);
  if (runtime.DB_HOST !== '127.0.0.1' || runtime.DB_PORT !== '5433' || runtime.DB_NAME !== 'ai_health_wallet') {
    fail('Provisioning requires the existing dedicated database on 127.0.0.1:5433.');
  }
  let sql = fs.readFileSync(new URL('infrastructure/database-roles.sql', root), 'utf8');
  const tables = [...sql.matchAll(/^ALTER TABLE public\.([a-z_]+) OWNER/gm)].map(match => match[1]).sort();
  const functions = [...sql.matchAll(/^ALTER FUNCTION public\.([a-z_]+)\(\) OWNER/gm)].map(match => match[1]).sort();
  if (tables.length !== 14 || functions.length !== 3) fail('Review the provisioning object manifest before running it.');

  const existing = JSON.parse(admin(`SELECT json_build_object(
    'roles', (SELECT coalesce(json_agg(rolname ORDER BY rolname), '[]'::json) FROM pg_roles WHERE rolname IN ('health_wallet_app', 'health_wallet_migrator')),
    'tables', (SELECT json_agg(json_build_object('name', relname, 'kind', relkind, 'owner', pg_get_userbyid(relowner)) ORDER BY relname) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind <> 'i'),
    'functions', (SELECT json_agg(json_build_object('name', proname, 'owner', pg_get_userbyid(proowner), 'definer', prosecdef) ORDER BY proname) FROM pg_proc WHERE pronamespace = 'public'::regnamespace),
    'memberships', (SELECT count(*) FROM pg_auth_members WHERE member IN (SELECT oid FROM pg_roles WHERE rolname IN ('health_wallet_app', 'health_wallet_migrator')) OR roleid IN (SELECT oid FROM pg_roles WHERE rolname IN ('health_wallet_app', 'health_wallet_migrator'))),
    'schemas', (SELECT json_agg(json_build_object('name', nspname, 'owner', pg_get_userbyid(nspowner))) FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname <> 'information_schema')
  );`));
  const expectedOwners = ['health_wallet_user', 'health_wallet_migrator'];
  if (JSON.stringify(existing.tables?.map(row => row.name)) !== JSON.stringify(tables)
      || existing.tables.some(row => row.kind !== 'r' || !expectedOwners.includes(row.owner))
      || JSON.stringify(existing.functions?.map(row => row.name)) !== JSON.stringify(functions)
      || existing.functions.some(row => row.definer || !expectedOwners.includes(row.owner))
      || Number(existing.memberships) !== 0
      || existing.schemas.length !== 1 || existing.schemas[0].name !== 'public'
      || !['pg_database_owner', ...expectedOwners].includes(existing.schemas[0].owner)) {
    fail('Unexpected objects, ownership or role memberships found. Review before provisioning; no ownership changes applied.');
  }

  const appPassword = pending.DB_PASSWORD || (runtime.DB_USER === roleNames[0] ? runtime.DB_PASSWORD : undefined);
  const migrationPassword = pending.MIGRATION_DB_PASSWORD || (migrations.MIGRATION_DB_USER === roleNames[1] ? migrations.MIGRATION_DB_PASSWORD : undefined);
  const credentials = { DB_PASSWORD: appPassword, MIGRATION_DB_PASSWORD: migrationPassword };
  for (const [index, key] of ['DB_PASSWORD', 'MIGRATION_DB_PASSWORD'].entries()) {
    if (existing.roles.includes(roleNames[index])) {
      if (!credentials[key]) fail('An existing role has no saved local credentials. Restore its secret file; provisioning does not rotate passwords.');
      await verifyLogin(roleNames[index], credentials[key]);
    } else if (!credentials[key]) credentials[key] = randomBytes(32).toString('hex');
  }
  if (credentials.DB_PASSWORD === credentials.MIGRATION_DB_PASSWORD) fail('Runtime and migration passwords must differ.');
  privateWrite(pendingFile, Object.entries(credentials).map(([key, value]) => key + '=' + JSON.stringify(value)).join('\n') + '\n');
  const before = snapshot(tables);
  if (before.indexes?.length !== 55 || before.relations?.length !== 69) fail('Unexpected relation/index inventory; review before transferring ownership.');
  const migrationPath = new URL('migrations/0001_initial_schema.sql', backend);
  const checksum = createHash('sha256').update(fs.readFileSync(migrationPath)).digest('hex');
  if (before.ledger?.length !== 1 || before.ledger[0].version !== '0001' || before.ledger[0].checksum !== checksum) {
    fail('Expected unchanged Phase 1.4 migration history before provisioning.');
  }

  console.log('Validated 14 tables, 55 indexes, 3 invoker functions, schema ownership and migration checksum.');
  console.log('Applying explicit role flags, ownership transfers, revocations and grants to the dedicated database.');
  sql = sql.replace('__APP_SCRAM__', scram(credentials.DB_PASSWORD))
    .replace('__MIGRATOR_SCRAM__', scram(credentials.MIGRATION_DB_PASSWORD));
  admin(`SET log_statement = 'none'; SET log_min_error_statement = 'panic';
    SET log_min_duration_statement = -1; SET log_min_duration_sample = -1;
    SET log_transaction_sample_rate = 0; SET log_duration = off;
    ${sql}`);
  if (JSON.stringify(snapshot(tables)) !== JSON.stringify(before)) {
    fail('Post-provision schema/data snapshot differs. Credentials retained in the ignored pending file for recovery.');
  }
  await verifyLogin(roleNames[0], credentials.DB_PASSWORD);
  await verifyLogin(roleNames[1], credentials.MIGRATION_DB_PASSWORD);
  let updated = fs.readFileSync(runtimeFile, 'utf8');
  for (const [key, value] of Object.entries({ DB_USER: roleNames[0], DB_PASSWORD: credentials.DB_PASSWORD })) {
    const line = key + '=' + JSON.stringify(value);
    const pattern = new RegExp('^' + key + '=.*$', 'm');
    updated = pattern.test(updated) ? updated.replace(pattern, () => line) : updated.trimEnd() + '\n' + line + '\n';
  }
  privateWrite(runtimeFile, updated);
  privateWrite(migrationFile, 'MIGRATION_DB_USER=health_wallet_migrator\nMIGRATION_DB_PASSWORD=' + JSON.stringify(credentials.MIGRATION_DB_PASSWORD) + '\n');
  fs.unlinkSync(pendingFile);
  console.log('Provisioning complete. Credentials stored separately with owner-only permissions; no passwords rotated for existing roles.');
  console.log('All object identities/definitions, record counts and migration ledger contents preserved.');
} catch (error) {
  // Our own controlled errors only; never print child stderr, SQL or pg errors.
  console.error(error instanceof Error && !('code' in error) ? error.message : 'Role provisioning failed without logging credential details.');
  process.exitCode = 1;
} finally {
  if (lock !== undefined) { fs.closeSync(lock); fs.unlinkSync(lockFile); }
}
