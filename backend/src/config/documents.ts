import "./env.js";
import { localStorageConfig, LocalStorageRefused, type LocalStorageConfig } from "../documents/local-storage.js";

export class DocumentConfigurationError extends Error {}
export interface S3StorageConfig {
  region: string;
  bucket: string;
  prefix: string;
  ownerAccountId: string;
  encryption: "AES256" | "aws:kms";
  kmsKeyId?: string;
}
export interface DocumentConfig {
  maxFileBytes: number;
  maxConcurrentUploads: number;
  uploadTimeoutMs: number;
  validationTimeoutMs: number;
  maxImagePixels: number;
  maxPdfPages: number;
  downloadExpirySeconds: number;
  uploadRateLimitMax: number;
  storage: S3StorageConfig | null;
  // Local development folder storage (synthetic files only; never S3). Null unless explicitly requested and allowed.
  localStorage?: LocalStorageConfig | null;
}
export function getDocumentConfig(): DocumentConfig {
  const integer = (key: string, fallback: number, min: number, max: number) => {
    const raw = process.env[key] ?? String(fallback);
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) {
      throw new DocumentConfigurationError(key + " is outside its permitted integer range.");
    }
    return value;
  };
  const enabled = process.env.DOCUMENT_STORAGE_ENABLED ?? "false";
  if (enabled !== "true" && enabled !== "false") throw new DocumentConfigurationError("DOCUMENT_STORAGE_ENABLED must be true or false.");
  let storage: S3StorageConfig | null = null;
  let localStorage: LocalStorageConfig | null = null;
  try { localStorage = localStorageConfig(process.env); }
  catch (error) { throw new DocumentConfigurationError(error instanceof LocalStorageRefused ? error.message : "Local file storage configuration is invalid."); }
  if (enabled === "true") {
    const region = process.env.AWS_REGION ?? "";
    const bucket = process.env.S3_BUCKET ?? "";
    const prefix = process.env.S3_DOCUMENT_PREFIX ?? "medical-documents/";
    const ownerAccountId = process.env.S3_BUCKET_OWNER_ACCOUNT_ID ?? "";
    const encryption = process.env.S3_ENCRYPTION ?? "AES256";
    const kmsKeyId = process.env.S3_KMS_KEY_ARN;
    if (!/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(region)) throw new DocumentConfigurationError("AWS_REGION is required when document storage is enabled.");
    if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) throw new DocumentConfigurationError("S3_BUCKET must be a dedicated DNS-safe bucket name without dots.");
    if (!/^[a-z0-9][a-z0-9/_-]{0,99}\/$/.test(prefix) || prefix.includes("//")) throw new DocumentConfigurationError("S3_DOCUMENT_PREFIX must be a generic relative prefix ending in a slash.");
    if (!/^\d{12}$/.test(ownerAccountId)) throw new DocumentConfigurationError("S3_BUCKET_OWNER_ACCOUNT_ID must identify the approved bucket owner.");
    if (encryption !== "AES256" && encryption !== "aws:kms") throw new DocumentConfigurationError("S3_ENCRYPTION must be AES256 or aws:kms.");
    if (encryption === "aws:kms" && (!kmsKeyId || !kmsKeyId.startsWith("arn:aws:kms:" + region + ":" + ownerAccountId + ":key/"))) {
      throw new DocumentConfigurationError("S3_KMS_KEY_ARN must be the approved regional KMS key ARN.");
    }
    if (process.env.AWS_ENDPOINT_URL || process.env.AWS_ENDPOINT_URL_S3) throw new DocumentConfigurationError("Custom AWS endpoints are not permitted for private document storage.");
    storage = { region, bucket, prefix, ownerAccountId, encryption, ...(encryption === "aws:kms" ? { kmsKeyId } : {}) };
  }
  return {
    maxFileBytes: integer("DOCUMENT_MAX_UPLOAD_BYTES", 5242880, 1024, 20971520),
    maxConcurrentUploads: integer("DOCUMENT_MAX_CONCURRENT_UPLOADS", 2, 1, 4),
    uploadTimeoutMs: integer("DOCUMENT_UPLOAD_TIMEOUT_MS", 15000, 1000, 30000),
    validationTimeoutMs: integer("DOCUMENT_VALIDATION_TIMEOUT_MS", 5000, 1000, 10000),
    maxImagePixels: integer("DOCUMENT_MAX_IMAGE_PIXELS", 16000000, 1000, 20000000),
    maxPdfPages: integer("DOCUMENT_MAX_PDF_PAGES", 100, 1, 200),
    downloadExpirySeconds: integer("DOCUMENT_DOWNLOAD_EXPIRY_SECONDS", 60, 30, 300),
    uploadRateLimitMax: integer("DOCUMENT_UPLOAD_RATE_LIMIT_MAX", 20, 1, 100),
    storage,
    localStorage,
  };
}
