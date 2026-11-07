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
  AdminSession,
  adminApi,
  adminMessage,
  validateSettingInput,
  validateDecisionInput,
  validateRuleForm,
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
test("account deletion request posts only the password and the exact confirmation to the patient route", async () => {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const session = new DoctorSession({
    baseUrl: "",
    fetch: async (url, init) => {
      calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body });
      return json({ success: true, deletion_request: { id: "r", state: "policy_pending", requested_at: "x" }, access_revoked: true, physical_deletion: "not_performed" });
    },
  });
  session.authorize("token", new Date(Date.now() + 60000).toISOString());
  const result = await patientApi(session).requestAccountDeletion("pw", "DELETE_MY_ACCOUNT");
  assert.equal(result.physical_deletion, "not_performed");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.ok(calls[0].url.endsWith("/api/v1/patients/me/deletion-request"));
  assert.deepEqual(JSON.parse(String(calls[0].body)), { current_password: "pw", confirmation: "DELETE_MY_ACCOUNT" });
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

test("admin session keeps the token in memory only, ends with a stated reason at expiry, and a role denial does not sign the admin out", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  let denyNext = false;
  const transport: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const path = new URL(String(url), "https://synthetic.invalid").pathname;
    if (path === "/api/v1/admin/auth/login")
      return json({ success: true, access_token: "admin-secret", token_type: "Bearer", expires_in: 1 });
    if (denyNext) return json({ error: { code: "FORBIDDEN" } }, 403);
    return json({ success: true, patients: [], next_cursor: null });
  };
  const globals = globalThis as unknown as Record<string, unknown>;
  const before = [globals.localStorage, globals.sessionStorage];
  const session = new AdminSession({ baseUrl: "https://synthetic.invalid", fetch: transport });
  const ended: (string | undefined)[] = [];
  session.onClear(() => ended.push(session.endReason));
  await assert.rejects(adminApi(session).patients(), ApiError, "protected calls need a session first");
  await session.login("admin@example.invalid", "synthetic password");
  assert.ok(session.authorized && session.expiresAt > Date.now() && session.expiresAt <= Date.now() + 1000);
  assert.deepEqual([globals.localStorage, globals.sessionStorage], before, "nothing is written to browser storage");
  await adminApi(session).patients({ q: "ab", status: "active", verified: false, limit: 10, cursor: "c1" });
  const list = calls.at(-1)!;
  assert.equal(list.url, "https://synthetic.invalid/api/v1/admin/patients?q=ab&status=active&verified=false&limit=10&cursor=c1");
  assert.equal((list.init!.headers as Record<string, string>).Authorization, "Bearer admin-secret");
  assert.equal(list.init!.credentials, "omit");
  // 403 means "your role may not do this": the session continues
  denyNext = true;
  await assert.rejects(adminApi(session).suspend("11111111-1111-4111-8111-111111111111"), (e: unknown) => e instanceof ApiError && e.status === 403 && e.code === "FORBIDDEN");
  assert.ok(session.authorized, "a permission denial does not end the session");
  assert.match(adminMessage(new ApiError(403, "FORBIDDEN")), /role is not allowed/);
  denyNext = false;
  // the token runs out after expires_in: no more requests are possible, and the reason is "expired"
  await new Promise((r) => setTimeout(r, 1150));
  assert.equal(session.authorized, false);
  assert.deepEqual(ended, ["expired"]);
  const used = calls.length;
  await assert.rejects(adminApi(session).processingSummary(), (e: unknown) => e instanceof ApiError && e.status === 401);
  assert.equal(calls.length, used, "an ended session sends nothing");
  // sign-out and server-side rejection give their own reasons
  await session.login("admin@example.invalid", "synthetic password");
  session.signOut();
  assert.equal(session.endReason, "signed_out");
  assert.equal(session.authorized, false);
  const rejecting = new AdminSession({ baseUrl: "https://synthetic.invalid", fetch: async (url) => String(url).endsWith("/login") ? json({ access_token: "t", token_type: "Bearer", expires_in: 900 }) : json({ error: { code: "UNAUTHORIZED" } }, 401) });
  await rejecting.login("a@example.invalid", "p");
  await assert.rejects(adminApi(rejecting).jobs());
  assert.equal(rejecting.endReason, "denied");
  assert.equal(rejecting.authorized, false);
});

test("admin client builds only reviewed admin paths, sends no body on actions, and turns failures into plain messages", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const session = new AdminSession({
    baseUrl: "",
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return String(url).endsWith("/login") ? json({ access_token: "t", token_type: "Bearer", expires_in: 900 }) : json({ success: true, patient: {}, job: {}, summary: {}, patients: [], jobs: [], next_cursor: "next" });
    },
  });
  await session.login("a@example.invalid", "p");
  const api = adminApi(session), id = "22222222-2222-4222-8222-222222222222";
  await api.patient(id); await api.suspend(id); await api.reactivate(id);
  await api.processingSummary(); await api.job(id); await api.retryJob(id);
  const page = await api.jobs({ state: "failed", error_code: "PROCESSOR_FAILED", patient_id: id, limit: 10 });
  assert.equal(page.nextCursor, "next");
  const paths = calls.slice(1).map((c) => (c.init?.method ?? "GET") + " " + c.url);
  assert.deepEqual(paths, [
    `GET /api/v1/admin/patients/${id}`, `POST /api/v1/admin/patients/${id}/suspend`, `POST /api/v1/admin/patients/${id}/reactivate`,
    "GET /api/v1/admin/processing/summary", `GET /api/v1/admin/processing/jobs/${id}`, `POST /api/v1/admin/processing/jobs/${id}/retry`,
    `GET /api/v1/admin/processing/jobs?state=failed&error_code=PROCESSOR_FAILED&patient_id=${id}&limit=10`,
  ]);
  for (const c of calls.slice(1).filter((x) => x.init?.method === "POST")) assert.equal(c.init!.body, undefined, "the backend rejects a request body on these actions");
  for (const c of calls.slice(1)) assert.ok(!/documents|records|download|summary-jobs|rag|doctor/.test(c.url.replace("/processing/summary", "")), "no medical path is reachable from the admin client");
  await assert.rejects(session.request("https://elsewhere.invalid/api/v1/admin/me"), /Invalid API path/);
  const message = (status: number, code: string) => adminMessage(new ApiError(status, code));
  assert.match(message(401, "INVALID_CREDENTIALS"), /email and password/);
  assert.match(message(429, "RATE_LIMITED"), /Too many attempts/);
  assert.match(message(409, "ACCOUNT_STATE_CONFLICT"), /not in a state/);
  assert.match(message(409, "JOB_NOT_RETRYABLE"), /cannot be retried/);
  assert.match(message(0, "NETWORK_ERROR"), /Connection problem/);
  assert.equal(adminMessage(new Error("postgres://user:secret@host/db")), "Something went wrong. Try again.");
  session.signOut(); // clears the expiry timer so the test process can exit
});

test("admin client builds only reviewed paths for status, settings, rules, health and audit; rule requests carry no approval field", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const session = new AdminSession({
    baseUrl: "",
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return String(url).endsWith("/login")
        ? json({ access_token: "t", token_type: "Bearer", expires_in: 900 })
        : json({ success: true, admin: {}, summary: {}, guardians: [], guardian: {}, shares: [], share: {}, deliveries: [], settings: [], setting: {}, rules: [], rule: {}, health: {}, events: [], chain: { status: "intact", events_checked: 3, first_invalid_seq: null }, next_cursor: "next" });
    },
  });
  await session.login("a@example.invalid", "p");
  const api = adminApi(session), id = "33333333-3333-4333-8333-333333333333";
  await api.me(); await api.guardianSummary(); await api.guardian(id); await api.shareSummary(); await api.share(id); await api.deliverySummary();
  await api.guardians({ status: "ACTIVE", patient_id: id, limit: 10, cursor: "c" });
  await api.shares({ status: "revoked", method: "qr_code", limit: 10 });
  await api.deliveries({ channel: "security_email", state: "delivered", purpose: "verify_email", limit: 10 });
  await api.settings(); await api.setting("documents.max_pdf_pages");
  await api.proposeSetting("documents.max_pdf_pages", 50);
  await api.decideSetting("sharing.otp_seconds", 2, "approved", "SEC-REVIEW-1");
  await api.rules({ rule_id: "LAB_X", limit: 10 }); await api.rule(id);
  await api.health();
  const page = await api.audit({ outcome: "denied", from: "2026-02-10T11:30:00Z", limit: 15 });
  assert.equal(page.chain?.status, "intact");
  assert.equal(page.nextCursor, "next");
  const rule = { rule_id: "LAB_X", definition: { field: "glucose", units: "mg/dL", operator: "gt" as const, bounds: [180], context: { fasting: "yes" } } };
  // a caller that tries to add an approval field (through a cast) still sends only the reviewed fields
  await api.createRule({ ...rule, clinical_approval: "approved", definition: { ...rule.definition, approved: true } } as never);
  const used = calls.slice(1).map((c) => (c.init?.method ?? "GET") + " " + c.url);
  assert.deepEqual(used, [
    "GET /api/v1/admin/me",
    "GET /api/v1/admin/status/guardians/summary", `GET /api/v1/admin/status/guardians/${id}`,
    "GET /api/v1/admin/status/shares/summary", `GET /api/v1/admin/status/shares/${id}`, "GET /api/v1/admin/status/deliveries/summary",
    `GET /api/v1/admin/status/guardians?status=ACTIVE&patient_id=${id}&limit=10&cursor=c`,
    "GET /api/v1/admin/status/shares?status=revoked&method=qr_code&limit=10",
    "GET /api/v1/admin/status/deliveries?channel=security_email&state=delivered&purpose=verify_email&limit=10",
    "GET /api/v1/admin/settings", "GET /api/v1/admin/settings/documents.max_pdf_pages",
    "POST /api/v1/admin/settings/documents.max_pdf_pages/versions",
    "POST /api/v1/admin/settings/sharing.otp_seconds/versions/2/decision",
    "GET /api/v1/admin/rules?rule_id=LAB_X&limit=10", `GET /api/v1/admin/rules/${id}`,
    "GET /api/v1/admin/health",
    "GET /api/v1/admin/audit?outcome=denied&from=2026-02-10T11%3A30%3A00Z&limit=15",
    "POST /api/v1/admin/rules",
  ]);
  const body = (n: number) => JSON.parse(calls.slice(1).filter((c) => c.init?.method === "POST")[n].init!.body as string);
  assert.deepEqual(body(0), { value: 50 });
  assert.deepEqual(body(1), { decision: "approved", reference: "SEC-REVIEW-1" });
  assert.deepEqual(Object.keys(body(2)).sort(), ["definition", "rule_id"]);
  assert.deepEqual(Object.keys(body(2).definition).sort(), ["bounds", "context", "field", "operator", "units"]);
  assert.ok(!/approv|clinical/i.test(JSON.stringify(body(2))), "no approval field is ever sent");
  for (const c of calls.slice(1).filter((x) => !x.init?.method || x.init.method === "GET")) assert.equal(c.init!.body, undefined, "reads send no body");
  for (const c of calls.slice(1)) assert.ok(!/documents\/|records|download|summary-jobs|rag|doctor|timeline/.test(c.url), "no medical path is reachable: " + c.url);
  session.signOut();
});

test("admin form checks explain problems in plain words before anything is sent, and backend refusals have their own messages", () => {
  const setting = { min: 1, max: 4, unit: "uploads", value: 2 };
  assert.equal(validateSettingInput(setting, " 3 "), 3);
  for (const [text, message] of [["", /whole number/], ["2.5", /whole number/], ["abc", /whole number/], ["0", /between 1 and 4 uploads/], ["5", /between 1 and 4 uploads/], ["2", /already the value in effect/]] as const)
    assert.throws(() => validateSettingInput(setting, text), (e: unknown) => e instanceof InputError && message.test(e.message), text);
  assert.equal(validateDecisionInput(" SEC-REVIEW-1 "), "SEC-REVIEW-1");
  for (const bad of ["", " ", "-starts-with-dash", "has;semicolon", "x".repeat(121)]) assert.throws(() => validateDecisionInput(bad), InputError, bad);
  const form = { ruleId: "LAB_X", field: "glucose", units: "mg/dL", operator: "between" as const, bounds: ["70", "99"] as [string, string], context: [{ key: "", value: "" }, { key: "fasting", value: "yes" }] };
  assert.deepEqual(validateRuleForm(form), { rule_id: "LAB_X", definition: { field: "glucose", units: "mg/dL", operator: "between", bounds: [70, 99], context: { fasting: "yes" } } });
  assert.deepEqual(validateRuleForm({ ...form, operator: "gt" }).definition.bounds, [70], "a one-sided rule uses one bound");
  for (const change of [{ ruleId: "lab" }, { ruleId: "LA" }, { field: "" }, { field: "bad;field" }, { units: "" }, { operator: "" as const }, { bounds: ["99", "70"] as [string, string] }, { bounds: ["x", "70"] as [string, string] },
    { bounds: ["2000000", "3000000"] as [string, string] }, { context: Array.from({ length: 6 }, (_, i) => ({ key: "k" + i, value: "v" })) }, { context: [{ key: "a", value: "1" }, { key: "a", value: "2" }] }, { context: [{ key: "only name", value: "" }] }])
    assert.throws(() => validateRuleForm({ ...form, ...change }), InputError, JSON.stringify(change));
  const message = (status: number, code: string) => adminMessage(new ApiError(status, code));
  assert.match(message(403, "CLINICAL_APPROVAL_FORBIDDEN"), /Clinical approval cannot be set from the Admin Dashboard/);
  assert.match(message(403, "SELF_APPROVAL_FORBIDDEN"), /different admin must approve/);
  assert.match(message(403, "SETTING_NOT_PERMITTED"), /cannot be changed from the Admin Dashboard/);
  assert.match(message(409, "DECISION_EXISTS"), /already recorded/);
  assert.match(message(409, "VERSION_SUPERSEDED"), /newer version/);
  assert.match(message(409, "SETTING_UNCHANGED"), /already the value in effect/);
  assert.match(message(400, "INVALID_SETTING_VALUE"), /not allowed/);
  assert.match(message(403, "FORBIDDEN"), /role is not allowed/);
});
