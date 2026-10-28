import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import type { PoolClient } from "pg";
import { pool, closeDatabasePool } from "./pool.js";
import { migrationPool, closeMigrationPool } from "./migration-pool.js";
import {
  applyMigration, assertDedicatedDatabase, loadMigrations, MIGRATION_LOCK,
  MigrationError, runMigrations, validateMigrationHistory,
} from "./migrations.js";

const tables = [
  "patients", "guardian_contacts", "medical_documents", "extracted_medical_text",
  "medical_document_chunks", "ai_report_summaries", "doctor_sharing_grants",
  "sharing_grant_documents", "doctor_otp_challenges", "guardian_notification_events",
  "serious_finding_evaluations", "rag_interactions", "rag_interaction_sources", "schema_migrations",
];
const indexes = [
  "medical_documents_patient_upload_idx", "medical_documents_patient_hospital_idx",
  "medical_documents_patient_category_idx", "medical_documents_patient_timeline_idx",
  "extracted_medical_text_patient_idx", "medical_document_chunks_patient_idx",
  "ai_report_summaries_document_idx", "ai_report_summaries_patient_idx",
  "doctor_sharing_grants_patient_idx", "sharing_grant_documents_grant_patient_idx",
  "sharing_grant_documents_document_idx", "sharing_grant_documents_patient_idx",
  "doctor_otp_challenges_grant_idx", "doctor_otp_challenges_patient_idx",
  "guardian_notifications_document_idx", "guardian_notifications_guardian_idx",
  "guardian_notifications_patient_idx", "serious_finding_evaluations_document_idx",
  "serious_finding_evaluations_summary_idx", "serious_finding_evaluations_patient_idx",
  "rag_interactions_patient_idx", "rag_interactions_grant_idx",
  "rag_interaction_sources_interaction_idx", "rag_interaction_sources_document_idx",
  "rag_interaction_sources_grant_idx", "rag_interaction_sources_patient_idx",
];

async function rejectSQL(client: PoolClient, sql: string, values: unknown[], code: string): Promise<void> {
  await client.query("SAVEPOINT expected_rejection");
  try {
    await assert.rejects(client.query(sql, values), (error: unknown) => {
      return !!error && typeof error === "object" && "code" in error && error.code === code;
    });
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT expected_rejection");
    await client.query("RELEASE SAVEPOINT expected_rejection");
  }
}

test("Phase 1.4 database verification", { timeout: 60000 }, async (t) => {
  assertDedicatedDatabase();
  try {
    await t.test("all migrations applied; repeat runs preserve table identities and ledger", async () => {
      const files = await loadMigrations();
      const status = await runMigrations("status");
      assert.equal(status.length, files.length);
      assert.ok(status.every((line) => line.startsWith("applied ")), "Run npm run db:migrate before verification");
      const before = await pool.query("SELECT oid, relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' ORDER BY relname");
      assert.deepEqual(await runMigrations("up"), ["Database is up to date; no migrations applied."]);
      assert.deepEqual(await runMigrations("up"), ["Database is up to date; no migrations applied."]);
      const after = await pool.query("SELECT oid, relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' ORDER BY relname");
      assert.deepEqual(after.rows, before.rows);
      const ledger = await migrationPool.query("SELECT version FROM public.schema_migrations ORDER BY version");
      assert.deepEqual(ledger.rows.map((row) => row.version), files.map((file) => file.version));
    });

    await t.test("required tables, explicit indexes, FK index coverage and UTC-aware timestamps", async () => {
      const actualTables = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
      for (const name of tables) assert.ok(actualTables.rows.some((row) => row.tablename === name), name);
      const actualIndexes = await pool.query("SELECT indexname FROM pg_indexes WHERE schemaname = 'public'");
      for (const name of indexes) assert.ok(actualIndexes.rows.some((row) => row.indexname === name), name);
      const missingIndexes = await pool.query(`SELECT c.conname FROM pg_constraint c
        WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace
        AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.conrelid AND i.indisvalid
          AND i.indpred IS NULL AND (SELECT array_agg(k.key ORDER BY k.position)
            FROM unnest(i.indkey) WITH ORDINALITY AS k(key, position)
            WHERE k.position <= cardinality(c.conkey)) = c.conkey)`);
      assert.deepEqual(missingIndexes.rows, []);
      const wrongTimes = await pool.query(`SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ANY($1::text[])
        AND column_name LIKE '%\\_at' ESCAPE '\\' AND data_type <> 'timestamp with time zone'`, [tables]);
      assert.deepEqual(wrongTimes.rows, []);
    });

    await t.test("migration history detects drift, missing files and out-of-order additions", async () => {
      const files = await loadMigrations();
      const records = files.map(({ version, name, checksum }) => ({ version, name, checksum }));
      assert.throws(() => validateMigrationHistory(files, [{ ...records[0], checksum: "0".repeat(64) }]), MigrationError);
      assert.throws(() => validateMigrationHistory([], records), MigrationError);
      assert.throws(() => validateMigrationHistory([{ ...files[0], version: "0000" }, ...files], records), MigrationError);
    });

    await t.test("concurrent migration operation is rejected by advisory lock", async () => {
      const client = await migrationPool.connect();
      try {
        await client.query("SELECT pg_advisory_lock($1, $2)", [...MIGRATION_LOCK]);
        await assert.rejects(runMigrations("up"), MigrationError);
      } finally {
        await client.query("SELECT pg_advisory_unlock($1, $2)", [...MIGRATION_LOCK]);
        client.release();
      }
    });

    await t.test("a failing migration rolls back DDL and does not enter the ledger", async () => {
      const client = await migrationPool.connect();
      try {
        await assert.rejects(applyMigration(client, {
          version: "9999", name: "9999_rollback_probe.sql", checksum: "f".repeat(64),
          sql: "CREATE TEMP TABLE phase14_rollback_probe (id integer); SELECT 1 / 0;",
        }), (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === "22012");
        assert.equal((await client.query("SELECT to_regclass('pg_temp.phase14_rollback_probe') AS probe")).rows[0].probe, null);
        assert.equal((await client.query("SELECT count(*)::int AS n FROM public.schema_migrations WHERE version = '9999'")).rows[0].n, 0);
      } finally { client.release(); }
    });

    const client = await pool.connect();
    const patientA = randomUUID();
    const patientB = randomUUID();
    const documentA = randomUUID();
    const documentB = randomUUID();
    const guardianA = randomUUID();
    const guardianB = randomUUID();
    const grantA = randomUUID();
    const grantB = randomUUID();
    const summaryA = randomUUID();
    const patientInteraction = randomUUID();
    const doctorInteraction = randomUUID();
    try {
      await client.query("BEGIN");
      for (const id of [patientA, patientB]) {
        await client.query(`INSERT INTO public.patients (id, email, password_hash, full_name)
          VALUES ($1, $2, $3, 'Synthetic Patient')`, [id, id + "@example.invalid", "$argon2id$v=19$m=65536,t=3,p=1$syntheticSalt$syntheticHashNotAnActualPassword"]);
      }
      for (const [id, owner] of [[documentA, patientA], [documentB, patientB]]) {
        await client.query(`INSERT INTO public.medical_documents
          (id, patient_id, s3_bucket, s3_object_key, original_filename, file_type, category, hospital_name, document_date)
          VALUES ($1, $2, 'synthetic-private-bucket', $3, 'synthetic.pdf', 'pdf', 'lab_report', 'Synthetic Hospital', '2026-01-01')`, [id, owner, "synthetic/" + id]);
      }
      for (const [id, owner] of [[guardianA, patientA], [guardianB, patientB]]) {
        await client.query(`INSERT INTO public.guardian_contacts (id, patient_id, email, consented_at, consent_version)
          VALUES ($1, $2, 'guardian@example.invalid', now(), 'synthetic-v1')`, [id, owner]);
      }
      for (const [id, owner] of [[grantA, patientA], [grantB, patientB]]) {
        await client.query(`INSERT INTO public.doctor_sharing_grants
          (id, patient_id, doctor_email, sharing_method, token_digest, expires_at)
          VALUES ($1, $2, 'doctor@example.invalid', 'unique_link', $3, now() + interval '1 hour')`, [id, owner, randomBytes(32)]);
      }
      await client.query("INSERT INTO public.sharing_grant_documents VALUES ($1, $2, $3)", [grantA, documentA, patientA]);

      await t.test("foreign keys reject nonexistent patient and document references", async () => {
        await rejectSQL(client, "INSERT INTO public.guardian_contacts (patient_id, email) VALUES ($1, 'missing@example.invalid')", [randomUUID()], "23503");
        await rejectSQL(client, "INSERT INTO public.medical_document_chunks (document_id, patient_id, chunk_order, chunk_text) VALUES ($1, $2, 0, 'synthetic')", [randomUUID(), patientA], "23503");
      });
      await t.test("document categories, file types and processing states are constrained", async () => {
        await rejectSQL(client, "UPDATE public.medical_documents SET category = 'invalid' WHERE id = $1", [documentA], "23514");
        await rejectSQL(client, "UPDATE public.medical_documents SET file_type = 'exe' WHERE id = $1", [documentA], "23514");
        await rejectSQL(client, "UPDATE public.medical_documents SET processing_status = 'invalid' WHERE id = $1", [documentA], "23514");
        await client.query("UPDATE public.medical_documents SET processing_status = 'completed' WHERE id = $1", [documentA]);
        await client.query("UPDATE public.medical_documents SET processing_status = 'failed' WHERE id = $1", [documentA]);
      });
      await t.test("sharing associations reject cross-patient documents and duplicates", async () => {
        await rejectSQL(client, "INSERT INTO public.sharing_grant_documents VALUES ($1, $2, $3)", [grantA, documentB, patientA], "23503");
        await rejectSQL(client, "INSERT INTO public.sharing_grant_documents VALUES ($1, $2, $3)", [grantA, documentB, patientB], "23503");
        await rejectSQL(client, "INSERT INTO public.sharing_grant_documents VALUES ($1, $2, $3)", [grantA, documentA, patientA], "23505");
      });
      await t.test("extraction, chunks and summaries preserve document ownership", async () => {
        // Synthetic evidence must now carry the current attempt and token.
        const token=randomUUID();
        await client.query(`UPDATE public.document_processing_jobs SET state='running',attempt_count=1,started_at=clock_timestamp(),
          lease_token=$1,lease_expires_at=clock_timestamp()+interval '1 minute',attempt_deadline_at=clock_timestamp()+interval '5 minutes'
          WHERE document_id=$2 AND patient_id=$3`,[token,documentA,patientA]);
        await client.query(`INSERT INTO public.extracted_medical_text(document_id,patient_id,extracted_text,processing_status,extractor_version,source_metadata,processing_attempt,processing_claim_token)
          VALUES($1,$2,'Synthetic OCR','completed','synthetic-v1',$3::jsonb,1,$4)`,[documentA,patientA,
          JSON.stringify({schemaVersion:1,method:'ocr',extractor:{name:'synthetic-fixture',version:'synthetic-v1'},source:{sha256:'0'.repeat(64),pageCount:1,pages:[{page:1,method:'ocr'}]}}),token]);
        await client.query("INSERT INTO public.medical_document_chunks (document_id, patient_id, chunk_order, chunk_text) VALUES ($1, $2, 0, 'Synthetic chunk')", [documentA, patientA]);
        await client.query("INSERT INTO public.ai_report_summaries (id, document_id, patient_id, summary_text, processing_status, generated_at) VALUES ($1, $2, $3, 'Synthetic summary', 'completed', now())", [summaryA, documentA, patientA]);
        for (const sql of [
          "INSERT INTO public.extracted_medical_text (document_id, patient_id) VALUES ($1, $2)",
          "INSERT INTO public.medical_document_chunks (document_id, patient_id, chunk_order, chunk_text) VALUES ($1, $2, 1, 'Synthetic')",
          "INSERT INTO public.ai_report_summaries (document_id, patient_id) VALUES ($1, $2)",
        ]) await rejectSQL(client, sql, [documentA, patientB], "23503");
        await rejectSQL(client, "UPDATE public.extracted_medical_text SET processing_status = 'invalid' WHERE document_id = $1", [documentA], "23514");
        await rejectSQL(client, "UPDATE public.ai_report_summaries SET processing_status = 'invalid' WHERE id = $1", [summaryA], "23514");
        await rejectSQL(client, "INSERT INTO public.medical_document_chunks (document_id, patient_id, chunk_order, chunk_text) VALUES ($1, $2, 0, 'Duplicate')", [documentA, patientA], "23505");
      });
      await t.test("OTP challenges bind the correct grant and doctor; expiry and verifiers are constrained", async () => {
        const insert = `INSERT INTO public.doctor_otp_challenges
          (grant_id, patient_id, doctor_email, otp_verifier, verifier_key_version, expires_at)
          VALUES ($1, $2, $3, $4, 'synthetic-key-v1', now() + interval '5 minutes')`;
        await client.query(insert, [grantA, patientA, "doctor@example.invalid", randomBytes(32)]);
        await rejectSQL(client, insert, [grantA, patientB, "doctor@example.invalid", randomBytes(32)], "23503");
        await rejectSQL(client, insert, [grantA, patientA, "wrong@example.invalid", randomBytes(32)], "23503");
        await rejectSQL(client, insert, [grantA, patientA, "doctor@example.invalid", Buffer.from("123456")], "23514");
        await rejectSQL(client, "UPDATE public.doctor_otp_challenges SET attempt_count = -1 WHERE grant_id = $1", [grantA], "23514");
        await rejectSQL(client, "UPDATE public.doctor_sharing_grants SET expires_at = created_at WHERE id = $1", [grantA], "23514");
        await rejectSQL(client, "UPDATE public.patients SET password_hash = 'plaintext-password' WHERE id = $1", [patientA], "23514");
      });
      await t.test("notifications reject wrong guardians; a delivery failure preserves its document", async () => {
        const insert = `INSERT INTO public.guardian_notification_events
          (patient_id, document_id, guardian_contact_id, notification_type, delivery_status, failure_code)
          VALUES ($1, $2, $3, 'routine_report', 'failed', 'synthetic_delivery_failure')`;
        await client.query(insert, [patientA, documentA, guardianA]);
        await rejectSQL(client, insert, [patientA, documentA, guardianB], "23503");
        await rejectSQL(client, insert, [patientB, documentA, guardianB], "23503");
        assert.equal((await client.query("SELECT count(*)::int AS n FROM public.medical_documents WHERE id = $1", [documentA])).rows[0].n, 1);
        await rejectSQL(client, "DELETE FROM public.medical_documents WHERE id = $1", [documentA], "23503");
      });
      await t.test("finding outcomes and AI explanation references preserve document ownership", async () => {
        for (const outcome of ["flagged", "not_flagged", "indeterminate"]) {
          await client.query(`INSERT INTO public.serious_finding_evaluations
            (document_id, patient_id, rule_set_version, detection_result, flagged_findings, ai_summary_id)
            VALUES ($1, $2, 'synthetic-v1', $3, $4::jsonb, $5)`, [documentA, patientA, outcome, outcome === "flagged" ? '[{"source":"synthetic"}]' : null, summaryA]);
        }
        await rejectSQL(client, "INSERT INTO public.serious_finding_evaluations (document_id, patient_id, rule_set_version, detection_result) VALUES ($1, $2, 'v1', 'invalid')", [documentA, patientA], "23514");
        await rejectSQL(client, "INSERT INTO public.serious_finding_evaluations (document_id, patient_id, rule_set_version, detection_result, ai_summary_id) VALUES ($1, $2, 'v1', 'indeterminate', $3)", [documentB, patientB, summaryA], "23503");
      });
      await t.test("RAG sources enforce patient ownership, selected records and NULL bypass protection", async () => {
        await client.query("INSERT INTO public.rag_interactions (id, patient_id, question) VALUES ($1, $2, 'Synthetic patient question')", [patientInteraction, patientA]);
        await client.query("INSERT INTO public.rag_interactions (id, patient_id, sharing_grant_id, question) VALUES ($1, $2, $3, 'Synthetic doctor question')", [doctorInteraction, patientA, grantA]);
        const insert = "INSERT INTO public.rag_interaction_sources (interaction_id, document_id, patient_id, sharing_grant_id) VALUES ($1, $2, $3, $4)";
        await client.query(insert, [patientInteraction, documentA, patientA, null]);
        await client.query(insert, [doctorInteraction, documentA, patientA, grantA]);
        await rejectSQL(client, insert, [patientInteraction, documentB, patientA, null], "23503");
        await rejectSQL(client, "UPDATE public.rag_interaction_sources SET sharing_grant_id = NULL WHERE interaction_id = $1", [doctorInteraction], "23503");
        await rejectSQL(client, "UPDATE public.rag_interactions SET sharing_grant_id = NULL WHERE id = $1", [doctorInteraction], "23514");
        const unselected = randomUUID();
        await client.query("INSERT INTO public.medical_documents (id, patient_id, s3_bucket, s3_object_key, original_filename, file_type, category) VALUES ($1, $2, 'synthetic-bucket', $3, 'synthetic.png', 'png', 'other_medical_document')", [unselected, patientA, unselected]);
        await rejectSQL(client, insert, [doctorInteraction, unselected, patientA, grantA], "23503");
      });
      await t.test("timeline uses document date with UTC upload fallback and updated_at is maintained", async () => {
        const result = await client.query(`SELECT COALESCE(document_date, (uploaded_at AT TIME ZONE 'UTC')::date)::text AS timeline_date
          FROM public.medical_documents WHERE id = $1`, [documentA]);
        assert.equal(result.rows[0].timeline_date, "2026-01-01");
        await client.query("UPDATE public.medical_documents SET document_date = NULL WHERE id = $1", [documentA]);
        const fallback = await client.query("SELECT COALESCE(document_date, (uploaded_at AT TIME ZONE 'UTC')::date) = (uploaded_at AT TIME ZONE 'UTC')::date AS correct FROM public.medical_documents WHERE id = $1", [documentA]);
        assert.equal(fallback.rows[0].correct, true);
        await client.query("UPDATE public.patients SET updated_at = '2000-01-01T00:00:00Z' WHERE id = $1", [patientA]);
        assert.equal((await client.query("SELECT updated_at > '2000-01-01T00:00:00Z'::timestamptz AS updated FROM public.patients WHERE id = $1", [patientA])).rows[0].updated, true);
      });
      await t.test("duplicate migration ledger entries are rejected", async () => {
        const migrationClient = await migrationPool.connect();
        try {
          await migrationClient.query("BEGIN");
          await rejectSQL(migrationClient, "INSERT INTO public.schema_migrations (version, name, checksum) SELECT version, name, checksum FROM public.schema_migrations LIMIT 1", [], "23505");
        } finally { await migrationClient.query("ROLLBACK"); migrationClient.release(); }
      });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    await t.test("synthetic records were rolled back", async () => {
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM public.patients WHERE id = ANY($1::uuid[])", [[patientA, patientB]])).rows[0].n, 0);
    });

    await t.test("database credential files are ignored and untracked", () => {
      const root = new URL("../../../", import.meta.url);
      const ignored = execFileSync("git", ["check-ignore", "backend/.env", "backend/.env.migrations", "infrastructure/.env"], { cwd: root, encoding: "utf8" });
      assert.deepEqual(ignored.trim().split("\n").sort(), ["backend/.env", "backend/.env.migrations", "infrastructure/.env"]);
      assert.equal(execFileSync("git", ["ls-files", "--", "backend/.env", "backend/.env.migrations", "infrastructure/.env"], { cwd: root, encoding: "utf8" }), "");
    });

    await t.test("existing health endpoints return their original successful responses", async () => {
      const { default: app } = await import("../app.js");
      const server = app.listen(0, "127.0.0.1");
      try {
        await once(server, "listening");
        const address = server.address();
        assert.ok(address && typeof address === "object");
        const base = "http://127.0.0.1:" + address.port;
        for (const [route, expected] of [
          ["/api/v1/health", { success: true, message: "AI Health Wallet API is running" }],
          ["/api/v1/health/db", { success: true, database: "connected" }],
        ] as const) {
          const response = await fetch(base + route, { signal: AbortSignal.timeout(8000) });
          assert.equal(response.status, 200);
          assert.deepEqual(await response.json(), expected);
        }
      } finally {
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
    });
  } finally { await Promise.all([closeDatabasePool(), closeMigrationPool()]); }
});
