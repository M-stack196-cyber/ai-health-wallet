import {createOriginalReader,type OriginalStorage} from "./original-reader.js";
import {StorageFailure,validStorageReference} from "./storage-safety.js";
export {StorageFailure,validStorageReference} from "./storage-safety.js";
import { createReadStream } from "node:fs";
import { finished } from "node:stream/promises";
import {
  S3Client, GetPublicAccessBlockCommand, GetBucketPolicyStatusCommand,
  GetBucketOwnershipControlsCommand, GetBucketEncryptionCommand,
  PutObjectCommand, DeleteObjectCommand, HeadObjectCommand, GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { S3StorageConfig } from "../config/documents.js";
import type { FileType } from "./validation.js";

export interface StoredObject { versionId?: string; }
export interface UploadObject { key: string; path: string; bytes: number; mime: string; checksum: string; signal: AbortSignal; }
export interface DocumentStorage {
  readonly bucket: string;
  readonly prefix: string;
  // Optional for older injected adapters; patient file delivery fails closed if absent.
  readOriginal?: OriginalStorage["readOriginal"];
  put(input: UploadObject): Promise<StoredObject>;
  remove(key: string, receipt?: StoredObject): Promise<void>;
  download(key: string, filename: string, type: FileType, expiresIn: number): Promise<string>;
}
function named(error: unknown, name: string): boolean { return error instanceof Error && error.name === name; }
function notFound(error: unknown): boolean { return named(error, "NotFound") || named(error, "NoSuchKey"); }
export function createS3Storage(config: S3StorageConfig, dependencies: { client?: S3Client; presign?: typeof getSignedUrl } = {}): DocumentStorage & OriginalStorage {
  const client = dependencies.client ?? new S3Client({ region: config.region, maxAttempts: 2,
    ignoreConfiguredEndpointUrls: true, requestHandler: { connectionTimeout: 3000, requestTimeout: 10000 } });
  const presign = dependencies.presign ?? getSignedUrl;
  const scope = { Bucket: config.bucket, ExpectedBucketOwner: config.ownerAccountId };
  const ownKey = (key: string) => { if (!validStorageReference(config, config.bucket, key)) throw new StorageFailure(); };

  async function verifyPrivate(signal: AbortSignal): Promise<void> {
    const block = await client.send(new GetPublicAccessBlockCommand(scope), { abortSignal: signal });
    const flags = block.PublicAccessBlockConfiguration;
    if (!flags?.BlockPublicAcls || !flags.IgnorePublicAcls || !flags.BlockPublicPolicy || !flags.RestrictPublicBuckets) throw new StorageFailure();
    try {
      const policy = await client.send(new GetBucketPolicyStatusCommand(scope), { abortSignal: signal });
      if (policy.PolicyStatus?.IsPublic !== false) throw new StorageFailure();
    } catch (error) { if (!named(error, "NoSuchBucketPolicy")) throw error; }
    const ownership = await client.send(new GetBucketOwnershipControlsCommand(scope), { abortSignal: signal });
    if (!ownership.OwnershipControls?.Rules?.some(rule => rule.ObjectOwnership === "BucketOwnerEnforced")) throw new StorageFailure();
    const encryption = await client.send(new GetBucketEncryptionCommand(scope), { abortSignal: signal });
    if (!encryption.ServerSideEncryptionConfiguration?.Rules?.some(rule => {
      const value = rule.ApplyServerSideEncryptionByDefault;
      return value?.SSEAlgorithm === config.encryption && (config.encryption !== "aws:kms" || value.KMSMasterKeyID === config.kmsKeyId);
    })) throw new StorageFailure();
  }
  return {
    bucket: config.bucket, prefix: config.prefix,
    ...createOriginalReader(config,client,verifyPrivate),
    async put(input) {
      ownKey(input.key);
      try { await verifyPrivate(input.signal); }
      catch { throw new StorageFailure(false); }
      const body = createReadStream(input.path);
      try {
        const result = await client.send(new PutObjectCommand({ ...scope, Key: input.key,
          Body: body, ContentLength: input.bytes, ContentType: input.mime, ChecksumSHA256: input.checksum,
          ServerSideEncryption: config.encryption, SSEKMSKeyId: config.kmsKeyId,
          IfNoneMatch: "*", CacheControl: "private, no-store" }), { abortSignal: input.signal });
        return { versionId: result.VersionId };
      } catch (error) {
        // A conditional conflict never authorizes removing a pre-existing object.
        throw new StorageFailure(!named(error, "PreconditionFailed") && !named(error, "ConditionalRequestConflict"));
      } finally { body.destroy(); await finished(body).catch(() => undefined); }
    },
    async remove(key, receipt) {
      ownKey(key);
      const signal = AbortSignal.timeout(10000);
      try {
        let versionId = receipt?.versionId;
        if (!receipt) {
          try { versionId = (await client.send(new HeadObjectCommand({ ...scope, Key: key }), { abortSignal: signal })).VersionId; }
          catch (error) { if (notFound(error)) return; throw error; }
        }
        await client.send(new DeleteObjectCommand({ ...scope, Key: key, VersionId: versionId }), { abortSignal: signal });
      } catch { throw new StorageFailure(); }
    },
    async download(key, filename, type, expiresIn) {
      ownKey(key);
      const signal = AbortSignal.timeout(10000);
      try {
        await verifyPrivate(signal);
        const head = await client.send(new HeadObjectCommand({ ...scope, Key: key }), { abortSignal: signal });
        const mime = type === "pdf" ? "application/pdf" : type === "png" ? "image/png" : "image/jpeg";
        if (!head.ContentLength || head.ContentType !== mime || head.ServerSideEncryption !== config.encryption
            || (config.encryption === "aws:kms" && head.SSEKMSKeyId !== config.kmsKeyId)) throw new StorageFailure();
        const encoded = encodeURIComponent(filename).replace(/['()*]/g, character => "%" + character.charCodeAt(0).toString(16).toUpperCase());
        const url = await presign(client, new GetObjectCommand({ ...scope, Key: key, VersionId: head.VersionId,
          ResponseContentType: mime, ResponseContentDisposition: "attachment; filename=\"document." + type + "\"; filename*=UTF-8''" + encoded,
          ResponseCacheControl: "private, no-store" }), { expiresIn });
        const parsed = new URL(url);
        const suffix = config.region.startsWith("cn-") ? "amazonaws.com.cn" : "amazonaws.com";
        if (parsed.protocol !== "https:" || parsed.username || parsed.password
            || parsed.hostname !== config.bucket + ".s3." + config.region + "." + suffix || parsed.pathname !== "/" + key) throw new StorageFailure();
        return url;
      } catch { throw new StorageFailure(); }
    },
  };
}
