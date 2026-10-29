import * as SecureStore from "expo-secure-store";
import { File, Paths, Directory } from "expo-file-system";
import * as Sharing from "expo-sharing";
import {
  PatientSession,
  InputError,
  type MedicalDocument,
} from "@health-wallet/api";
const key = "health-wallet-refresh-v1";
const transient = new Directory(Paths.cache, "health-wallet-private");
let exporting = false;
export async function clearFiles(force = false) {
  if ((force || !exporting) && transient.exists) transient.delete();
}
export function createSession() {
  const base = process.env.EXPO_PUBLIC_API_URL;
  if (
    !base ||
    (!base.startsWith("https://") &&
      !(
        typeof __DEV__ !== "undefined" &&
        __DEV__ &&
        /^http:\/\/(localhost|127\.0\.0\.1|10\.0\.2\.2)(:\d+)?$/.test(base)
      ))
  )
    throw new InputError(
      "Configure a HTTPS EXPO_PUBLIC_API_URL. Loopback HTTP is allowed in development only.",
    );
  const session = new PatientSession(
    { baseUrl: base, timeoutMs: 60000 },
    {
      read: () => SecureStore.getItemAsync(key),
      write: (value) =>
        SecureStore.setItemAsync(key, value, {
          keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
        }),
      remove: () => SecureStore.deleteItemAsync(key),
    },
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
  await clearFiles();
  transient.create({ intermediates: true, idempotent: true });
  const suffix =
    document.content_type === "application/pdf"
      ? "pdf"
      : document.content_type === "image/png"
        ? "png"
        : "jpg";
  const file = new File(transient, "original." + suffix);
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
export function pickedForm(
  asset: { uri: string; name: string; mimeType?: string },
  metadata: { category: string; hospital_name: string; document_date?: string },
) {
  const form = new FormData();
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
