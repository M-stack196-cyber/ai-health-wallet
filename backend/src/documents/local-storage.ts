// LOCAL DEVELOPMENT STORAGE ONLY. Synthetic sample files only. This is NOT S3 and is never S3 evidence (M03-002 stays BLOCKED).
// It exists so the local demo stack can run as separate processes without AWS. It refuses to exist outside NODE_ENV development/local,
// when any AWS or S3 setting is present, or when the folder is inside the repository, shared, or not owned by this user.
// Ownership and authorization are NOT decided here: as with S3, the routes derive the patient and key from the database, and this
// adapter accepts only the same strict key shape (validStorageReference) that the S3 adapter accepts.
import { createReadStream, createWriteStream, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { lstat, mkdir, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { DocumentStorage, StoredObject, UploadObject } from "./storage.js";
import { InvalidStoredOriginal, type OriginalStorage, type ReadOriginalInput } from "./original-reader.js";
import { StorageFailure, validStorageReference } from "./storage-safety.js";

export class LocalStorageRefused extends Error {}
export interface LocalStorageConfig { directory: string; prefix: string; bucket: string; }
export const LOCAL_STORAGE_BUCKET = "local-file-synthetic";
const MARKER = ".synthetic-only-local-storage";
const MARKER_TEXT = "synthetic sample files only; local development storage; not S3\n";
const REPOSITORY_ROOT = resolve(new URL("../../../", import.meta.url).pathname);

/** Returns null when local storage is not requested. Throws LocalStorageRefused (messages never contain values). */
export function localStorageConfig(env: NodeJS.ProcessEnv, repositoryRoot: string = REPOSITORY_ROOT): LocalStorageConfig | null {
  const directory = env.DOCUMENT_STORAGE_LOCAL_DIR;
  if (directory === undefined || directory === "") return null;
  if (env.NODE_ENV !== "development" && env.NODE_ENV !== "local") throw new LocalStorageRefused("Local file storage is allowed only when NODE_ENV is development or local.");
  if (env.DOCUMENT_STORAGE_ENABLED === "true") throw new LocalStorageRefused("Local file storage cannot be combined with S3 document storage.");
  if (Object.entries(env).some(([name, value]) => /^(AWS_|S3_)/.test(name) && value !== undefined && value !== "")) {
    throw new LocalStorageRefused("Local file storage is refused while any AWS or S3 setting is present.");
  }
  if (env.DOCUMENT_STORAGE_LOCAL_SYNTHETIC_ONLY !== "true") throw new LocalStorageRefused("Local file storage requires DOCUMENT_STORAGE_LOCAL_SYNTHETIC_ONLY=true (synthetic sample files only).");
  if (!isAbsolute(directory) || normalize(directory) !== directory || directory.endsWith(sep) || directory.split(sep).includes("..") || directory.length > 300 || /[\0\r\n]/.test(directory)) {
    throw new LocalStorageRefused("DOCUMENT_STORAGE_LOCAL_DIR must be a normalized absolute path.");
  }
  const root = resolve(repositoryRoot);
  if (directory === root || directory.startsWith(root + sep)) throw new LocalStorageRefused("DOCUMENT_STORAGE_LOCAL_DIR must be outside the repository.");
  return { directory, prefix: "medical-documents/", bucket: LOCAL_STORAGE_BUCKET };
}

function privateFolder(path: string, create: boolean): void {
  if (create) mkdirSync(path, { recursive: true, mode: 0o700 });
  const status = lstatSync(path);
  const uid = process.getuid?.();
  if (!status.isDirectory() || status.isSymbolicLink() || uid === undefined || status.uid !== uid || (status.mode & 0o077) !== 0) {
    throw new LocalStorageRefused("Local storage folder must be a real folder owned by this user with owner-only permissions.");
  }
}

export function createLocalStorage(config: LocalStorageConfig): DocumentStorage & OriginalStorage {
  privateFolder(config.directory, true);
  const markerPath = join(config.directory, MARKER);
  try { if (readFileSync(markerPath, "utf8") !== MARKER_TEXT) throw new LocalStorageRefused("Local storage folder is not a synthetic-only folder."); }
  catch (error) {
    if (error instanceof LocalStorageRefused) throw error;
    writeFileSync(markerPath, MARKER_TEXT, { mode: 0o600, flag: "wx" });
  }
  const reference = { bucket: config.bucket, prefix: config.prefix };
  const pathFor = (key: string) => {
    if (!validStorageReference(reference, config.bucket, key)) throw new StorageFailure();
    return join(config.directory, key);
  };
  async function ensureParent(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    privateFolder(dirname(path), false);
  }
  return {
    bucket: config.bucket, prefix: config.prefix,
    async put(input: UploadObject): Promise<StoredObject> {
      const path = pathFor(input.key);
      let created = false;
      try {
        await ensureParent(path);
        const hash = createHash("sha256");
        let bytes = 0;
        const counter = new Transform({ transform(chunk: Buffer, _encoding, callback) { bytes += chunk.length; hash.update(chunk); callback(null, chunk); } });
        const out = createWriteStream(path, { flags: "wx", mode: 0o600 });
        created = true;
        await pipeline(createReadStream(input.path), counter, out, { signal: input.signal });
        if (bytes !== input.bytes || hash.digest("base64") !== input.checksum) throw new StorageFailure(true);
        return {};
      } catch (error) {
        const exists = (error as NodeJS.ErrnoException)?.code === "EEXIST";
        // A pre-existing object is never removed by a failed conditional write.
        if (created && !exists) await unlink(path).catch(() => undefined);
        throw error instanceof StorageFailure ? error : new StorageFailure(!exists);
      }
    },
    async remove(key: string): Promise<void> {
      const path = pathFor(key);
      try { await unlink(path); } catch (error) { if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw new StorageFailure(); }
    },
    async download(): Promise<string> {
      // No pre-signed URLs exist locally. Bytes are delivered only through readOriginal (authorized server-side stream).
      throw new StorageFailure();
    },
    async readOriginal(input: ReadOriginalInput): Promise<{ bytes: number }> {
      if (!validStorageReference(reference, config.bucket, input.key) || !input.key.endsWith("." + input.type)
        || !["pdf", "jpg", "jpeg", "png"].includes(input.type)
        || !Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1 || input.maxBytes > 20971520
        || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 30000) throw new InvalidStoredOriginal();
      const path = join(config.directory, input.key);
      const signal = AbortSignal.any([input.signal, AbortSignal.timeout(input.timeoutMs)]);
      try {
        signal.throwIfAborted();
        const status = await lstat(path);
        const uid = process.getuid?.();
        if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1 || uid === undefined || status.uid !== uid
          || (status.mode & 0o077) !== 0 || status.size < 1 || status.size > input.maxBytes) throw new InvalidStoredOriginal();
        let bytes = 0;
        const limiter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          if (bytes > input.maxBytes || bytes > status.size) { callback(new InvalidStoredOriginal()); return; }
          callback(null, chunk);
        } });
        await pipeline(createReadStream(path), limiter, createWriteStream(input.destination, { flags: "wx", mode: 0o600 }), { signal });
        if (bytes !== status.size) throw new InvalidStoredOriginal();
        return { bytes };
      } catch (error) {
        if (error instanceof InvalidStoredOriginal) throw error;
        throw new StorageFailure();
      }
    },
  };
}
