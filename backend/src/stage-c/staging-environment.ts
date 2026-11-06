/** Checks the DEFINITION of the disposable staging environment (us-east-1, single node). Returns problem codes only, never values.
 *  Secrets must arrive as NAME_FILE paths, not as plain values. This is a readiness check, not an approval of anything. */
const secretNames = ["JWT_SECRET", "ADMIN_JWT_SECRET", "DB_PASSWORD", "MIGRATION_DB_PASSWORD", "AUTH_SECURITY_EMAIL_ENCRYPTION_KEY", "AUTH_SECURITY_EMAIL_AUTHORIZATION",
  "GUARDIAN_SYNTHETIC_REFERENCE_KEY", "RAG_SERVICE_TOKEN", "SUMMARY_SERVICE_TOKEN", "OCR_SERVICE_TOKEN"] as const;
export const secretVariableNames: readonly string[] = secretNames;
const rds = /^[a-z][a-z0-9-]{0,62}\.[a-z0-9]{8,16}\.us-east-1\.rds\.amazonaws\.com$/;
export function stagingEnvironmentProblems(env: Record<string, string | undefined>): string[] {
  const problems: string[] = [], bad = (code: string) => problems.push(code);
  for (const name of secretNames) if (env[name]) bad("SECRET_AS_PLAIN_VALUE:" + name);
  for (const name of ["JWT_SECRET_FILE", "DB_PASSWORD_FILE"]) if (!env[name]) bad("MISSING:" + name);
  for (const name of Object.keys(env)) if (/^AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN|PROFILE)$|^AWS_ENDPOINT_URL/.test(name) && env[name]) bad("STATIC_AWS_CREDENTIAL_OR_ENDPOINT:" + name);
  if (env.NODE_ENV !== "production") bad("NODE_ENV");
  if (env.AWS_REGION !== "us-east-1") bad("AWS_REGION");
  if (env.DOCUMENT_STORAGE_ENABLED !== "true") bad("DOCUMENT_STORAGE_ENABLED");
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(env.S3_BUCKET ?? "")) bad("S3_BUCKET");
  if (!/^\d{12}$/.test(env.S3_BUCKET_OWNER_ACCOUNT_ID ?? "")) bad("S3_BUCKET_OWNER_ACCOUNT_ID");
  if (env.S3_ENCRYPTION !== "aws:kms" || !(env.S3_KMS_KEY_ARN ?? "").startsWith("arn:aws:kms:us-east-1:" + (env.S3_BUCKET_OWNER_ACCOUNT_ID ?? "") + ":key/")) bad("S3_ENCRYPTION");
  if (!rds.test(env.DB_HOST ?? "")) bad("DB_HOST");
  if (env.DB_PORT !== "5432") bad("DB_PORT");
  if (env.DB_NAME !== "ai_health_wallet_staging") bad("DB_NAME");
  if (env.DB_USER !== "health_wallet_app") bad("DB_USER");
  if (!env.DB_SSL_CA_FILE) bad("DB_SSL_CA_FILE");
  if (!/^[0-3]$/.test(env.TRUST_PROXY_HOPS ?? "")) bad("TRUST_PROXY_HOPS");
  if (!/^https:\/\//.test(env.FRONTEND_ORIGIN ?? "") && !/^\$\{|^http:\/\/127\.0\.0\.1/.test(env.FRONTEND_ORIGIN ?? "")) bad("FRONTEND_ORIGIN");
  // Everything outside the owner's approvals stays off.
  if (!["disabled", "sandbox", undefined].includes(env.AUTH_SECURITY_EMAIL_MODE)) bad("AUTH_SECURITY_EMAIL_MODE");
  if (!["disabled", "synthetic-offline", undefined].includes(env.GUARDIAN_NOTIFICATIONS_MODE)) bad("GUARDIAN_NOTIFICATIONS_MODE");
  for (const name of ["PROCESSING_SERVICE_ENABLED", "PROCESSING_OPERATIONAL_ENABLED", "SUMMARY_EXECUTOR_ENABLED"]) if (env[name] && env[name] !== "false") bad("MUST_BE_FALSE:" + name);
  for (const name of ["RAG_PROVIDER", "SUMMARY_PROVIDER"]) if (env[name] && env[name] !== "synthetic-offline") bad("PROVIDER_NOT_APPROVED:" + name);
  if (env.RAG_SERVICE_URL && !/^http:\/\/127\.0\.0\.1:\d+\//.test(env.RAG_SERVICE_URL)) bad("RAG_SERVICE_URL");
  return problems;
}
