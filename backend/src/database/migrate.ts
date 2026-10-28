import { DatabaseConfigurationError } from "../config/env.js";

try {
  const { runMigrations } = await import("./migrations.js");
  const mode = process.argv[2];
  if (mode !== "up" && mode !== "status") {
    console.error("Usage: npm run db:migrate OR npm run db:status");
    process.exitCode = 1;
  } else {
    for (const message of await runMigrations(mode)) console.log(message);
  }
} catch (error: unknown) {
  const { MigrationError } = await import("./migrations.js").catch(() => ({ MigrationError: null }));
  if (error instanceof DatabaseConfigurationError || (MigrationError && error instanceof MigrationError)) {
    console.error(error.message);
  } else {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    console.error("Database migration command failed" + (/^[0-9A-Z]{5}$/.test(code) ? " (SQLSTATE " + code + ")" : "") + ". No database error details were logged.");
  }
  process.exitCode = 1;
} finally {
  const database = await import("./migration-pool.js").catch(() => null);
  if (database) await database.closeMigrationPool();
}
