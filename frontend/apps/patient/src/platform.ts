import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import { File, Paths, Directory } from "expo-file-system";
import * as Sharing from "expo-sharing";
import {
  PatientSession,
  InputError,
  type MedicalDocument,
} from "@health-wallet/api";
const key = "health-wallet-refresh-v1";
const isWeb = Platform.OS === "web";
// expo-file-system has no web implementation, so build the directory lazily and never on web.
let transientDir: Directory | undefined;
function transient() {
  return (transientDir ??= new Directory(Paths.cache, "health-wallet-private"));
}
let exporting = false;
export async function clearFiles(force = false) {
  if (isWeb) return;
  const dir = transient();
  if ((force || !exporting) && dir.exists) dir.delete();
}
// Web has no secure store, so the refresh token is kept in memory only; it is never written to browser storage.
// A page reload signs the user out; this is intentional and required by the R8-BUILD-02 quality gate.
let webToken: string | null = null;
const storage = isWeb
  ? {
      read: async () => webToken,
      write: async (value: string) => {
        webToken = value;
      },
      remove: async () => {
        webToken = null;
      },
    }
  : {
      read: () => SecureStore.getItemAsync(key),
      write: (value: string) =>
        SecureStore.setItemAsync(key, value, {
          keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
        }),
      remove: () => SecureStore.deleteItemAsync(key),
    };
export function createSession() {
  const dev = typeof __DEV__ !== "undefined" && __DEV__;
  // Development only: fall back to the local backend on the LAN.
  let base =
    process.env.EXPO_PUBLIC_API_URL ||
    process.env.EXPO_PUBLIC_API_BASE_URL ||
    (dev ? "http://192.168.18.18:5000/api/v1" : undefined);
  // Development web only: the local API listens on loopback, so when the page itself is
  // opened on localhost / 127.0.0.1, use that same host for the API. One env value then
  // works on web (loopback) and on a phone (LAN address).
  if (
    dev &&
    isWeb &&
    base?.startsWith("http://") &&
    typeof window !== "undefined"
  ) {
    const host = window.location.hostname;
    if (host === "localhost" || host === "127.0.0.1")
      base = base.replace(
        /^http:\/\/192\.168\.\d{1,3}\.\d{1,3}(?=[:/]|$)/,
        "http://" + host,
      );
  }
  if (
    !base ||
    (!base.startsWith("https://") &&
      !(
        dev &&
        /^http:\/\/(localhost|127\.0\.0\.1|10\.0\.2\.2|192\.168\.\d{1,3}\.\d{1,3})(:\d+)?(\/.*)?$/.test(
          base,
        )
      ))
  )
    throw new InputError(
      "Configure a HTTPS EXPO_PUBLIC_API_URL. Loopback HTTP is allowed in development only.",
    );
  const session = new PatientSession(
    { baseUrl: base, timeoutMs: 60000 },
    storage,
  );
  session.onClear(() => {
    void clearFiles(true);
  });
  return session;
}
/** Called only after authenticated byte retrieval. No bearer token is passed to an external viewer. */
export async function presentOriginal(
  blob: Blob,
  document: MedicalDocument,
  isAuthorized: () => boolean,
) {
  if (!isAuthorized()) return;
  if (isWeb) throw new InputError("File viewing/export is unavailable on web.");
  await clearFiles();
  transient().create({ intermediates: true, idempotent: true });
  const suffix =
    document.content_type === "application/pdf"
      ? "pdf"
      : document.content_type === "image/png"
        ? "png"
        : "jpg";
  const file = new File(transient(), "original." + suffix);
  file.create();
  const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () =>
      reject(new Error("Unable to read the original file."));
    reader.readAsArrayBuffer(blob);
  });
  if (!isAuthorized()) {
    if (file.exists) file.delete();
    return;
  }
  file.write(new Uint8Array(bytes));
  try {
    if (!(await Sharing.isAvailableAsync()))
      throw new InputError(
        "File viewing/export is unavailable on this device.",
      );
    if (!isAuthorized()) return;
    exporting = true;
    await Sharing.shareAsync(file.uri, {
      mimeType: document.content_type,
      dialogTitle:
        "View or save original (exported copies remain outside this app)",
    });
  } finally {
    exporting = false;
    if (file.exists) file.delete();
  }
}
export async function pickedForm(
  asset: { uri: string; name: string; mimeType?: string; file?: Blob },
  metadata: { category: string; hospital_name: string; document_date?: string },
) {
  const form = new FormData();
  if (isWeb) {
    // TEMPORARY DEBUG: development builds only. Remove once web uploads are confirmed working.
    if (typeof __DEV__ !== "undefined" && __DEV__) {
      console.log("[DEBUG upload web]", asset.file instanceof Blob, asset);
      if (!asset.file)
        console.warn(
          "[DEBUG upload web] asset.file is missing; falling back to fetch(asset.uri)",
        );
    }
    // Browsers cannot send the React Native { uri, name, type } shape; FormData needs a real File/Blob.
    const blob: Blob =
      asset.file ??
      (await fetch(asset.uri)
        .then((r) => r.blob())
        .catch(() => {
          throw new InputError("Choose the file again, then retry the upload.");
        }));
    // The server requires the part's content type to match the file extension, so set it if the browser left it blank.
    const type = asset.mimeType || blob.type;
    form.append(
      "file",
      blob.type === type ? blob : new Blob([blob], { type }),
      asset.name,
    );
  } else
    form.append("file", {
      uri: asset.uri,
      name: asset.name,
      type: asset.mimeType,
    } as unknown as Blob);
  form.append("category", metadata.category);
  form.append("hospital_name", metadata.hospital_name);
  if (metadata.document_date)
    form.append("document_date", metadata.document_date);
  return form;
}
