/** Pure decision about where migrations may run. Returns a short reason when the target is refused. */
export interface MigrationTarget { host: string; port: number; database: string; }
const rds = /^[a-z][a-z0-9-]{0,62}\.[a-z0-9]{8,16}\.us-east-1\.rds\.amazonaws\.com$/;
export function migrationTargetProblem(target: MigrationTarget, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const mode = env.MIGRATION_TARGET ?? "local";
  if (mode === "staging") {
    // Disposable staging in us-east-1 only; the operator must repeat the exact host, and the link must be verified TLS.
    if (!rds.test(target.host)) return "host is not a us-east-1 RDS endpoint";
    if (target.port !== 5432) return "port is not 5432";
    if (target.database !== "ai_health_wallet_staging") return "database is not ai_health_wallet_staging";
    if (env.MIGRATION_CONFIRM_HOST !== target.host) return "MIGRATION_CONFIRM_HOST does not repeat the host";
    if (!env.DB_SSL_CA_FILE) return "DB_SSL_CA_FILE is missing";
    return undefined;
  }
  if (mode !== "local") return "MIGRATION_TARGET must be local or staging";
  if (target.host !== "127.0.0.1" || target.port !== 5433 || target.database !== "ai_health_wallet") return "local migrations need the dedicated database on 127.0.0.1:5433";
  return undefined;
}
