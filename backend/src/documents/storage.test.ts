import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { S3Client } from "@aws-sdk/client-s3";
import type { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { S3StorageConfig } from "../config/documents.js";
import { createS3Storage, StorageFailure, validStorageReference } from "./storage.js";

test("Phase 2.1 AWS SDK adapter with no AWS network calls", async (t) => {
  const config: S3StorageConfig = { bucket: "synthetic-private-medical-bucket", prefix: "medical-documents/",
    region: "us-east-1", ownerAccountId: "000000000000", encryption: "AES256" };
  const key = config.prefix + randomUUID() + ".pdf";
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  let unsafe = "";
  let versionId: string | undefined = "synthetic-version";
  let publicPolicy = false;
  let noPolicy = false;
  let missingHead = false;
  let putError: string | undefined;
  let encryption = "AES256";
  let kmsKey: string | undefined;
  let signing: { input: Record<string, unknown>; expiresIn: unknown } | undefined;
  const client = { async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
    const name = command.constructor.name;
    calls.push({ name, input: command.input });
    switch (name) {
      case "GetPublicAccessBlockCommand": return { PublicAccessBlockConfiguration: {
        BlockPublicAcls: unsafe !== "block", IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true } };
      case "GetBucketPolicyStatusCommand": {
        if (noPolicy) throw Object.assign(new Error("synthetic"), { name: "NoSuchBucketPolicy" });
        return { PolicyStatus: { IsPublic: publicPolicy } };
      }
      case "GetBucketOwnershipControlsCommand": return { OwnershipControls: { Rules: [{ ObjectOwnership: unsafe === "ownership" ? "ObjectWriter" : "BucketOwnerEnforced" }] } };
      case "GetBucketEncryptionCommand": return { ServerSideEncryptionConfiguration: { Rules: [{ ApplyServerSideEncryptionByDefault: {
        SSEAlgorithm: unsafe === "encryption" ? "unsupported" : encryption, KMSMasterKeyID: kmsKey } }] } };
      case "PutObjectCommand": {
        if (putError) throw Object.assign(new Error("synthetic"), { name: putError });
        return { VersionId: versionId };
      }
      case "HeadObjectCommand": {
        if (missingHead) throw Object.assign(new Error("synthetic"), { name: "NotFound" });
        return { ContentLength: 12, ContentType: "application/pdf", ServerSideEncryption: encryption, SSEKMSKeyId: kmsKey, VersionId: versionId };
      }
      case "DeleteObjectCommand": return {};
      default: throw new Error("Unexpected mocked command");
    }
  } } as unknown as S3Client;
  const presign = (async (_client: unknown, command: { input: Record<string, unknown> }, options: { expiresIn: number }) => {
    signing = { input: command.input, expiresIn: options.expiresIn };
    return "https://" + config.bucket + ".s3." + config.region + ".amazonaws.com/" + key + "?X-Amz-Signature=synthetic";
  }) as unknown as typeof getSignedUrl;
  const storage = createS3Storage(config, { client, presign });
  const directory = await mkdtemp(tmpdir() + "/health-wallet-sdk-test-");
  const path = directory + "/synthetic.bin";
  await writeFile(path, "synthetic", { mode: 0o600 });
  const input = { key, path, bytes: 9, mime: "application/pdf", checksum: "c3ludGhldGlj", signal: AbortSignal.timeout(10000) };
  try {
    await t.test("encrypted conditional PutObject is confined to expected owner/bucket/prefix", async () => {
      const receipt = await storage.put(input);
      assert.equal(receipt.versionId, "synthetic-version");
      const put = calls.find(call => call.name === "PutObjectCommand")!.input;
      assert.equal(put.Bucket, config.bucket); assert.equal(put.Key, key);
      assert.equal(put.ExpectedBucketOwner, config.ownerAccountId);
      assert.equal(put.ServerSideEncryption, "AES256"); assert.equal(put.IfNoneMatch, "*");
      assert.equal(put.ChecksumSHA256, input.checksum); assert.equal(put.ACL, undefined); assert.equal(put.Metadata, undefined);
      assert.ok(calls.every(call => call.input.ExpectedBucketOwner === config.ownerAccountId));
    });
    await t.test("unsafe public access, ownership or encryption fail before any write", async () => {
      for (const mode of ["block", "ownership", "encryption"]) {
        unsafe = mode; const count = calls.filter(call => call.name === "PutObjectCommand").length;
        await assert.rejects(storage.put(input), (error: unknown) => error instanceof StorageFailure && !error.mayHaveWritten);
        assert.equal(calls.filter(call => call.name === "PutObjectCommand").length, count);
      }
      unsafe = "";
      publicPolicy = true;
      await assert.rejects(storage.put(input), StorageFailure);
      publicPolicy = false;
    });
    await t.test("a bucket with no policy remains allowed when other private controls pass", async () => {
      noPolicy = true;
      try { await storage.put(input); } finally { noPolicy = false; }
    });
    await t.test("presigned GET uses attachment, cache controls, exact version and bounded expiry", async () => {
      const url = await storage.download(key, "synthetic report.pdf", "pdf", 60);
      assert.ok(url.startsWith("https://")); assert.ok(signing);
      assert.equal(signing.expiresIn, 60); assert.equal(signing.input.VersionId, versionId);
      assert.equal(signing.input.ResponseContentType, "application/pdf");
      assert.equal(signing.input.ResponseCacheControl, "private, no-store");
      assert.ok(String(signing.input.ResponseContentDisposition).startsWith("attachment;"));
      assert.ok(!String(signing.input.ResponseContentDisposition).includes("\r"));
    });
    await t.test("missing objects and unsafe storage conditions never yield a URL", async () => {
      missingHead = true;
      await assert.rejects(storage.download(key, "synthetic.pdf", "pdf", 60), StorageFailure);
      missingHead = false;
      unsafe = "block";
      await assert.rejects(storage.download(key, "synthetic.pdf", "pdf", 60), StorageFailure);
      unsafe = "";
    });
    await t.test("reference traversal/foreign prefixes are denied before any SDK call", async () => {
      const before = calls.length;
      assert.equal(validStorageReference(storage, "another-bucket", key), false);
      for (const candidate of ["../outside.pdf", config.prefix + "../outside.pdf", "other/" + randomUUID() + ".pdf", config.prefix + randomUUID() + ".exe"]) {
        await assert.rejects(storage.remove(candidate), StorageFailure);
        await assert.rejects(storage.download(candidate, "test.pdf", "pdf", 60), StorageFailure);
      }
      assert.equal(calls.length, before);
    });
    await t.test("conditional write conflicts never authorize cleanup of existing keys", async () => {
      putError = "PreconditionFailed";
      await assert.rejects(storage.put(input), (error: unknown) => error instanceof StorageFailure && !error.mayHaveWritten);
      putError = "NetworkingError";
      await assert.rejects(storage.put(input), (error: unknown) => error instanceof StorageFailure && error.mayHaveWritten);
      putError = undefined;
    });
    await t.test("cleanup uses exact returned version and handles lost upload acknowledgements", async () => {
      await storage.remove(key, { versionId: "specific-new-version" });
      assert.equal(calls.at(-1)!.input.VersionId, "specific-new-version");
      await storage.remove(key);
      assert.equal(calls.at(-1)!.name, "DeleteObjectCommand"); assert.equal(calls.at(-1)!.input.VersionId, versionId);
      missingHead = true; const before = calls.filter(call => call.name === "DeleteObjectCommand").length;
      await storage.remove(key);
      assert.equal(calls.filter(call => call.name === "DeleteObjectCommand").length, before);
      missingHead = false;
    });
    await t.test("approved SSE-KMS settings flow into private checks and upload encryption", async () => {
      encryption = "aws:kms"; kmsKey = "arn:aws:kms:us-east-1:000000000000:key/synthetic-key";
      const kms = createS3Storage({ ...config, encryption: "aws:kms", kmsKeyId: kmsKey }, { client, presign });
      await kms.put(input);
      assert.equal(calls.at(-1)!.input.ServerSideEncryption, "aws:kms");
      assert.equal(calls.at(-1)!.input.SSEKMSKeyId, kmsKey);
      encryption = "AES256"; kmsKey = undefined;
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
