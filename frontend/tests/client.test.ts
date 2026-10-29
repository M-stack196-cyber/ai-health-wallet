import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ApiClient,
  ApiError,
  InputError,
  safeMessage,
  DoctorSession,
  PatientSession,
  patientApi,
  doctorApi,
  shareReference,
  validateFile,
  grantState,
  searchLoaded,
  type MedicalDocument,
} from "../packages/api/src/index.ts";
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
function vault() {
  let stored: string | null = null;
  return {
    read: async () => stored,
    write: async (v: string) => {
      stored = v;
    },
    remove: async () => {
      stored = null;
    },
    get value() {
      return stored;
    },
  };
}
const tokens = {
  access_token: "access-secret",
  refresh_token: "refresh-secret",
  expires_in: 900,
  refresh_expires_in: 3600,
};
test("patient login stores only refresh credential; restored session rotates and logout clears secure storage", async () => {
  const storage = vault(),
    calls: { url: string; init?: RequestInit }[] = [];
  const transport: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return json(String(url).endsWith("/logout") ? { success: true } : tokens);
  };
  const session = new PatientSession(
    { baseUrl: "https://synthetic.invalid", fetch: transport },
    storage,
  );
  await session.login("a@example.invalid", "password");
  assert.equal(storage.value, "refresh-secret");
  assert.ok(!storage.value?.includes("access"));
  const restored = new PatientSession(
    { baseUrl: "https://synthetic.invalid", fetch: transport },
    storage,
  );
  assert.equal(await restored.restore(), true);
  await restored.logout();
  assert.equal(storage.value, null);
  assert.equal(restored.authorized, false);
  assert.equal(
    (calls.at(-1)?.init?.headers as Record<string, string>).Authorization,
    "Bearer access-secret",
  );
});
test("patient concurrent renewal is single-flight and rejected refresh clears credentials", async () => {
  const storage = vault();
  let refresh = 0;
  const session = new PatientSession(
    {
      baseUrl: "",
      fetch: async (url) => {
        if (String(url).endsWith("/login"))
          return json({ ...tokens, expires_in: 0 });
        if (String(url).endsWith("/refresh")) {
          refresh++;
          await new Promise((r) => setTimeout(r, 10));
          return json(tokens);
        }
        return json({ patient: {} });
      },
    },
    storage,
  );
  await session.login("a", "b");
  await Promise.all([
    patientApi(session).profile(),
    patientApi(session).profile(),
  ]);
  assert.equal(refresh, 1);
  session.clear();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(storage.value, null);
});
test("restoration cannot retain invalid/revoked refresh and reset invalidates the local session", async () => {
  const storage = vault();
  await storage.write("revoked");
  const denied = new PatientSession(
    { baseUrl: "", fetch: async () => json({}, 401) },
    storage,
  );
  assert.equal(await denied.restore(), false);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(storage.value, null);
  const session = new PatientSession(
    { baseUrl: "", fetch: async () => json(tokens) },
    storage,
  );
  await session.login("a", "b");
  await session.reset("email-code", "replacement");
  assert.equal(session.authorized, false);
});
test("doctor denial clears token, aborts in-flight work, and stale response cannot resurrect data", async () => {
  let release: (r: Response) => void = () => {};
  const pending = new Promise<Response>((r) => {
    release = r;
  });
  const session = new DoctorSession({
    baseUrl: "",
    fetch: async (url) =>
      String(url).includes("/slow")
        ? pending
        : json(
            {
              error: {
                code: "SHARE_ACCESS_DENIED",
                message: "sensitive database details",
              },
            },
            403,
          ),
  });
  session.authorize("secret", new Date(Date.now() + 60000).toISOString());
  let clears = 0;
  session.onClear(() => clears++);
  const slow = session.request("/api/v1/slow");
  const failure = assert.rejects(slow, ApiError);
  await assert.rejects(
    session.request("/api/v1/doctor/records"),
    (e) => e instanceof ApiError && !e.message.includes("database"),
  );
  release(json({ medical: "late" }));
  await failure;
  assert.equal(clears, 1);
  assert.equal(session.authorized, false);
});
test("doctor expiry clears session without another request", async () => {
  const session = new DoctorSession({ baseUrl: "" });
  session.authorize("token", new Date(Date.now() + 20).toISOString());
  await new Promise((r) => setTimeout(r, 45));
  assert.equal(session.authorized, false);
});
test("public OTP failure does not grant access; timeout/network failure normalized", async () => {
  const session = new DoctorSession({
    baseUrl: "",
    fetch: async () => json({ error: { code: "NO" } }, 403),
  });
  await assert.rejects(
    doctorApi(session).verify({
      share_token: "x",
      email: "x",
      challenge_id: "x",
      otp: "x",
    }),
    ApiError,
    InputError,
    safeMessage,
  );
  assert.equal(session.authorized, false);
  const offline = new ApiClient({
    baseUrl: "",
    timeoutMs: 5,
    fetch: async (_url, init) =>
      new Promise((_r, reject) =>
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("network detail")),
        ),
      ),
  });
  await assert.rejects(
    offline.request("/api/v1/x", "GET", undefined, false),
    (e) =>
      e instanceof ApiError && e.status === 0 && !e.message.includes("detail"),
  );
});
test("safe QR/link references, category/filter encoding, exact selected scope and upload validation", async () => {
  const reference = "sh1." + "a".repeat(64);
  assert.equal(
    shareReference("https://doctor.invalid/#/share/" + reference),
    reference,
  );
  assert.equal(shareReference(reference), reference);
  assert.throws(() => shareReference("patient-id"));
  for (const [name, mime] of [
    ["a.pdf", "application/pdf"],
    ["a.jpg", "image/jpeg"],
    ["a.jpeg", "image/jpeg"],
    ["a.png", "image/png"],
  ])
    assert.equal(validateFile(name, mime), mime);
  assert.throws(() => validateFile("a.exe", "application/pdf"));
  assert.throws(() => validateFile("a.png", "image/jpeg"));
  let body: unknown,
    url = "";
  const session = new DoctorSession({
    baseUrl: "",
    fetch: async (u, i) => {
      url = String(u);
      body = i?.body;
      return json({});
    },
  });
  session.authorize("token", new Date(Date.now() + 60000).toISOString());
  await doctorApi(session).records({
    hospital: "A & B",
    category: "lab_report",
    uploaded_from: "2026-01-01",
  });
  assert.ok(url.includes("hospital=A+%26+B"));
  assert.throws(() => patientApi(session).share([], "qr_code"));
  await patientApi(session).share(["selected-only"], "qr_code");
  assert.deepEqual(JSON.parse(String(body)), {
    document_ids: ["selected-only"],
    share_type: "qr_code",
  });
  session.clear();
});
test("central API contracts cover auth, guardian, document lifecycle, summaries, timeline, RAG and grants", async () => {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const session = new DoctorSession({
    baseUrl: "",
    fetch: async (url, init) => {
      calls.push({
        url: String(url),
        method: init?.method ?? "GET",
        body: init?.body,
      });
      return json({});
    },
  });
  session.authorize("token", new Date(Date.now() + 60000).toISOString());
  const api = patientApi(session);
  await api.register({ full_name: "A", email: "a", password: "p" });
  await api.verify("code");
  await api.resend("a");
  await api.forgot("a");
  await api.guardian();
  await api.setGuardian("a");
  await api.setGuardian("b", true);
  await api.resendGuardian();
  await api.removeGuardian();
  await api.processing("doc");
  await api.retry("doc");
  await api.metadata("doc", {
    hospital_name: "Hospital",
    category: "lab_report",
  });
  await api.remove("doc");
  await api.summary("doc");
  await api.requestSummary("doc");
  await api.summaryJob("job");
  await api.retrySummary("job");
  await api.requestHistory();
  await api.history("job");
  await api.timeline({ offset: 20 });
  await api.ask("question");
  await api.grants();
  await api.revoke("grant");
  assert.equal(calls.length, 23);
  assert.ok(calls.some((c) => c.url.endsWith("/verification/resend")));
  assert.ok(calls.some((c) => c.method === "PUT"));
  assert.ok(calls.some((c) => c.url.endsWith("/processing-retries")));
  assert.ok(calls.some((c) => c.method === "DELETE"));
  session.clear();
});
test("display helpers preserve truthful grant status and search only supplied scope", () => {
  const grant = {
    id: "x",
    sharing_method: "qr_code",
    created_at: "",
    expires_at: "2026-01-01",
    revoked_at: null,
  };
  assert.equal(grantState(grant, Date.parse("2026-02-01")), "Expired");
  assert.equal(grantState({ ...grant, revoked_at: "date" }), "Revoked");
  const document = {
    id: "selected",
    original_filename: "report.pdf",
    hospital_name: "Synthetic Hospital",
    category_label: "Lab Report",
  } as MedicalDocument;
  assert.deepEqual(searchLoaded([document], "hospital"), [document]);
  assert.deepEqual(searchLoaded([document], "unshared"), []);
});
test("Expo CLI patched Zod preserves plugin parsing and MCP command schema contract", async () => {
  const { createRequire } = await import("node:module");
  const require = createRequire(new URL("../package.json", import.meta.url));
  const path = await import("node:path");
  const cli = path.dirname(
    require.resolve("@expo/cli/package.json", {
      paths: [path.dirname(require.resolve("expo/package.json"))],
    }),
  );
  const { PluginSchema, DevToolsPluginOutputSchema } = require(
    cli + "/build/src/start/server/DevToolsPlugin.schema.js",
  );
  const { createMCPDevToolsExtensionSchema } = require(
    cli + "/build/src/start/server/createMCPDevToolsExtensionSchema.js",
  );
  const plugin = {
    packageName: "synthetic-tools",
    packageRoot: "/synthetic",
    cliExtensions: {
      description: "Synthetic only",
      entryPoint: "index.js",
      commands: [
        {
          name: "probe",
          title: "Probe",
          environments: ["mcp"],
          parameters: [{ name: "count", type: "number" }],
        },
      ],
    },
  };
  assert.equal(PluginSchema.safeParse(plugin).success, true);
  assert.equal(
    PluginSchema.safeParse({ ...plugin, packageName: "" }).success,
    false,
  );
  const schema = createMCPDevToolsExtensionSchema(plugin);
  assert.deepEqual(schema.parse({ command: "probe", count: 2 }), {
    command: "probe",
    count: 2,
  });
  assert.equal(schema.safeParse({ command: "not-declared" }).success, false);
  assert.equal(
    DevToolsPluginOutputSchema.safeParse([
      { type: "text", text: "synthetic", level: "info" },
    ]).success,
    true,
  );
});

test("unknown native/server exception details are never presented to users", () => {
  assert.equal(
    safeMessage(new InputError("Choose a supported file.")),
    "Choose a supported file.",
  );
  assert.equal(
    safeMessage(new ApiError(429, "LIMIT")),
    "Too many attempts. Wait before trying again.",
  );
  assert.ok(
    !safeMessage(
      new Error("secret-token /private/internal/storage/path"),
    ).includes("secret-token"),
  );
});
test("secure storage failure prevents a retained patient session", async () => {
  let removed = 0;
  const client = new PatientSession(
    { baseUrl: "", fetch: async () => json(tokens) },
    {
      read: async () => null,
      write: async () => {
        throw new Error("native keychain unavailable");
      },
      remove: async () => {
        removed++;
      },
    },
  );
  await assert.rejects(
    client.login("synthetic@example.invalid", "synthetic password"),
    ApiError,
  );
  assert.equal(client.authorized, false);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(removed, 1);
});
