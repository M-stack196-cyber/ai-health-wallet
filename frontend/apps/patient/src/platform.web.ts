// Web only (Metro picks this file instead of platform.ts when the platform is "web"). Native builds never load it.
// Sign-in secrets live in memory only: nothing is written to browser storage or cookies, so a page reload signs the person out.
import {
  PatientSession,
  InputError,
  type MedicalDocument,
} from "@health-wallet/api";

// The only copy of the refresh credential on web: a variable inside this module.
let held: string | null = null;
const urls = new Set<string>();
let exporting = false;

export async function clearFiles(force = false) {
  if (!force && exporting) return;
  for (const url of urls) URL.revokeObjectURL(url);
  urls.clear();
}
export function createSession() {
  const base = process.env.EXPO_PUBLIC_API_URL;
  if (
    !base ||
    (!base.startsWith("https://") &&
      !(
        typeof __DEV__ !== "undefined" &&
        __DEV__ &&
        /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base)
      ))
  )
    throw new InputError(
      "Configure a HTTPS EXPO_PUBLIC_API_URL. Loopback HTTP is allowed in development only.",
    );
  const session = new PatientSession(
    { baseUrl: base, timeoutMs: 60000 },
    {
      read: async () => held,
      write: async (value: string) => {
        held = value;
      },
      remove: async () => {
        held = null;
      },
    },
  );
  session.onClear(() => {
    held = null;
    void clearFiles(true);
  });
  return session;
}
/** Called only after authenticated byte retrieval. The browser saves a copy; no bearer token is passed anywhere. */
export async function presentOriginal(
  blob: Blob,
  doc: MedicalDocument,
  isAuthorized: () => boolean,
) {
  if (!isAuthorized()) return;
  await clearFiles();
  const suffix =
    doc.content_type === "application/pdf"
      ? "pdf"
      : doc.content_type === "image/png"
        ? "png"
        : "jpg";
  const url = URL.createObjectURL(new Blob([blob], { type: doc.content_type }));
  urls.add(url);
  if (!isAuthorized()) {
    URL.revokeObjectURL(url);
    urls.delete(url);
    return;
  }
  exporting = true;
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = "original." + suffix;
    link.rel = "noopener";
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    // Give the browser a moment to start the download before the temporary address is released.
    setTimeout(() => {
      exporting = false;
      URL.revokeObjectURL(url);
      urls.delete(url);
    }, 5000);
  }
}
export function pickedForm(
  asset: { uri: string; name: string; mimeType?: string; file?: File },
  metadata: { category: string; hospital_name: string; document_date?: string },
) {
  if (!asset.file)
    throw new InputError("The selected file is no longer available. Choose it again.");
  const form = new FormData();
  form.append("file", asset.file, asset.name);
  form.append("category", metadata.category);
  form.append("hospital_name", metadata.hospital_name);
  if (metadata.document_date)
    form.append("document_date", metadata.document_date);
  return form;
}
