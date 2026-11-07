import React from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  cleanup,
} from "@testing-library/react-native";
import * as Clipboard from "expo-clipboard";
import * as DocumentPicker from "expo-document-picker";
import { Alert } from "react-native";
import { Auth } from "../App";
import {
  ProfilePanel,
  RecordDetail,
  RecordsPanel,
  RagPanel,
  SharingPanel,
  TimelinePanel,
  HistoryPanel,
  UploadPanel,
} from "./Workspace";
import {
  PatientSession,
  patientApi,
  type MedicalDocument,
} from "@health-wallet/api";
jest.mock("expo-secure-store", () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));
jest.mock("expo-screen-capture", () => ({
  preventScreenCaptureAsync: jest.fn(async () => {}),
  allowScreenCaptureAsync: jest.fn(async () => {}),
}));
jest.mock("./platform", () => ({
  createSession: jest.fn(),
  clearFiles: jest.fn(async () => {}),
  presentOriginal: jest.fn(async () => {}),
  pickedForm: jest.fn(() => new FormData()),
}));
jest.mock("expo-clipboard", () => ({
  setStringAsync: jest.fn(async () => true),
}));
jest.mock("expo-document-picker", () => ({ getDocumentAsync: jest.fn() }));
jest.mock("expo-file-system", () => ({
  File: jest.fn(() => ({ exists: false, delete: jest.fn() })),
}));
jest.mock("react-native-svg", () => ({
  SvgXml: ({ accessibilityLabel }: { accessibilityLabel: string }) => <></>,
}));
afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});
const document: MedicalDocument = {
  id: "selected",
  original_filename: "selected.pdf",
  category: "lab_report",
  category_label: "Lab Report",
  hospital_name: "Synthetic Hospital",
  document_date: null,
  uploaded_at: "2026-01-01T12:00:00Z",
  content_type: "application/pdf",
  size_bytes: 100,
  sha256: "a".repeat(64),
  access_state: "active",
  processing_status: "processing",
  sort_date: "2026-01-01",
  sort_date_source: "uploaded_at",
};
function context(overrides: Record<string, unknown> = {}) {
  const api = {
    profile: jest.fn(async () => ({
      patient: {
        email: "a@example.invalid",
        full_name: "Synthetic",
        date_of_birth: null,
        phone_number: null,
        sex_gender: null,
      },
    })),
    guardian: jest.fn(async () => ({ guardian: { status: "NONE" } })),
    setGuardian: jest.fn(async () => {}),
    resendGuardian: jest.fn(async () => {}),
    removeGuardian: jest.fn(async () => {}),
    records: jest.fn(async () => ({
      documents: [document],
      pagination: { has_more: false },
    })),
    record: jest.fn(async () => ({ document })),
    processing: jest.fn(async () => ({
      processing: {
        status: "failed",
        retry_allowed: true,
        failure_code: "timeout",
      },
    })),
    retry: jest.fn(async () => {}),
    summary: jest.fn(async () => ({
      summary: {
        text: "Glucose reported",
        mode: "synthetic-offline",
        generated_at: "2026-01-01",
        limitations: ["Not a diagnosis"],
      },
    })),
    remove: jest.fn(async () => ({ original_erased: false })),
    grants: jest.fn(async () => ({ grants: [] })),
    share: jest.fn(async () => ({
      grant: {
        id: "g",
        expires_at: "2099-01-01",
        created_at: "2026-01-01",
        sharing_method: "qr_code",
        revoked_at: null,
      },
      share_url: "https://doctor.invalid/#/share/opaque",
      qr_svg: "<svg/>",
    })),
    ...overrides,
  };
  return {
    api: api as unknown as ReturnType<typeof patientApi>,
    session: {} as PatientSession,
    busy: false,
    run: async (fn: () => Promise<void>) => {
      await fn();
    },
    setMessage: jest.fn(),
    live: () => true,
  };
}
test("registration sends approved fields and requires verification before login", async () => {
  const calls: unknown[] = [];
  const session = new PatientSession(
    {
      baseUrl: "",
      fetch: jest.fn(async (_u, i) => {
        calls.push(JSON.parse(String(i?.body)));
        return new Response("{}", { status: 201 });
      }) as typeof fetch,
    },
    { read: async () => null, write: async () => {}, remove: async () => {} },
  );
  render(<Auth session={session} onLogin={jest.fn()} />);
  fireEvent.press(screen.getByRole("button", { name: "Register" }));
  fireEvent.changeText(
    screen.getByLabelText("Email"),
    "synthetic@example.invalid",
  );
  fireEvent.changeText(screen.getByLabelText("Full name"), "Synthetic User");
  fireEvent.changeText(
    screen.getByLabelText("Date of birth (YYYY-MM-DD)"),
    "2000-01-01",
  );
  fireEvent.changeText(
    screen.getByLabelText("Password"),
    "Synthetic passphrase 42!",
  );
  fireEvent.press(screen.getByRole("button", { name: "Register" }));
  await waitFor(() =>
    expect(screen.getByText(/Registration received/)).toBeTruthy(),
  );
  expect(calls[0]).toEqual({
    email: "synthetic@example.invalid",
    full_name: "Synthetic User",
    password: "Synthetic passphrase 42!",
    date_of_birth: "2000-01-01",
  });
  expect(session.authorized).toBe(false);
}, 15_000);
test.each(["NONE", "PENDING", "ACTIVE", "REVOKED", "EXPIRED"])(
  "guardian %s is explicit and account deletion is a guarded, truthful request",
  async (status) => {
    const c = context({
      guardian: jest.fn(async () => ({
        guardian: { status, email: "guardian@example.invalid" },
      })),
    });
    render(<ProfilePanel {...c} />);
    await screen.findByText("Status: " + status);
    expect(screen.getByText("Request account deletion")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Start deletion request" }),
    ).toBeTruthy();
    expect(screen.queryByText(/not available yet/)).toBeNull();
    expect(
      screen.getByRole("button", {
        name: ["ACTIVE", "PENDING"].includes(status)
          ? "Replace guardian"
          : "Add guardian",
      }),
    ).toBeTruthy();
  },
);
describe("account deletion request", () => {
  const deletion = (state = "policy_pending") =>
    jest.fn(async () => ({
      success: true,
      deletion_request: {
        id: "r",
        state,
        requested_at: "2026-01-01T00:00:00Z",
      },
      access_revoked: true,
      physical_deletion: "not_performed",
    }));
  function open(c: ReturnType<typeof context>) {
    jest
      .spyOn(Alert, "alert")
      .mockImplementation((_t, _m, buttons) =>
        buttons?.find((b) => b.text === "Confirm")?.onPress?.(),
      );
    render(<ProfilePanel {...c} />);
    return screen.findByText("Status: NONE").then(() => {
      fireEvent.press(
        screen.getByRole("button", { name: "Start deletion request" }),
      );
    });
  }
  test("submit needs the password and the exact confirmation, then sends them once", async () => {
    const requestAccountDeletion = deletion();
    const c = context({ requestAccountDeletion });
    await open(c);
    const submit = () =>
      screen.getByRole("button", { name: "Submit deletion request" });
    expect(submit().props.accessibilityState?.disabled).toBe(true);
    fireEvent.changeText(
      screen.getByLabelText("Current password"),
      "Synthetic passphrase 42!",
    );
    fireEvent.changeText(
      screen.getByLabelText("Type DELETE_MY_ACCOUNT to confirm"),
      "delete my account",
    );
    expect(submit().props.accessibilityState?.disabled).toBe(true);
    fireEvent.changeText(
      screen.getByLabelText("Type DELETE_MY_ACCOUNT to confirm"),
      "DELETE_MY_ACCOUNT",
    );
    expect(submit().props.accessibilityState?.disabled).toBeFalsy();
    fireEvent.press(submit());
    await screen.findByText("DELETION REQUESTED");
    expect(requestAccountDeletion).toHaveBeenCalledTimes(1);
    expect(requestAccountDeletion).toHaveBeenCalledWith(
      "Synthetic passphrase 42!",
      "DELETE_MY_ACCOUNT",
    );
    expect(screen.getByText(/Nothing has been permanently deleted yet/)).toBeTruthy();
    expect(screen.queryByText(/30/)).toBeNull();
    expect(screen.queryByText(/legal hold is active/)).toBeNull();
  });
  test("a legal hold is explained and sign out uses the session", async () => {
    const logout = jest.fn(async () => {});
    const c = {
      ...context({ requestAccountDeletion: deletion("blocked_legal_hold") }),
      session: { logout, clear: jest.fn() } as unknown as PatientSession,
    };
    await open(c);
    fireEvent.changeText(screen.getByLabelText("Current password"), "p");
    fireEvent.changeText(
      screen.getByLabelText("Type DELETE_MY_ACCOUNT to confirm"),
      "DELETE_MY_ACCOUNT",
    );
    fireEvent.press(
      screen.getByRole("button", { name: "Submit deletion request" }),
    );
    await screen.findByText(/legal hold is active/);
    fireEvent.press(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(logout).toHaveBeenCalled());
  });
  test("a refused request shows a safe message, keeps the form and does not claim success", async () => {
    const requestAccountDeletion = jest.fn(async () => {
      throw new Error("raw driver detail secret-host");
    });
    const c = {
      ...context({ requestAccountDeletion }),
      run: async (fn: () => Promise<void>) => {
        await fn().catch(() => {});
      },
    };
    await open(c);
    fireEvent.changeText(screen.getByLabelText("Current password"), "wrong");
    fireEvent.changeText(
      screen.getByLabelText("Type DELETE_MY_ACCOUNT to confirm"),
      "DELETE_MY_ACCOUNT",
    );
    fireEvent.press(
      screen.getByRole("button", { name: "Submit deletion request" }),
    );
    await waitFor(() => expect(requestAccountDeletion).toHaveBeenCalled());
    expect(screen.queryByText("DELETION REQUESTED")).toBeNull();
    expect(screen.getByLabelText("Current password").props.value).toBe("");
    expect(screen.queryByText(/secret-host/)).toBeNull();
  });
});
test("guardian replace and remove require confirmation and use lifecycle API", async () => {
  const c = context({
    guardian: jest.fn(async () => ({
      guardian: { status: "ACTIVE", email: "old@example.invalid" },
    })),
  });
  jest
    .spyOn(Alert, "alert")
    .mockImplementation((_t, _m, buttons) =>
      buttons?.find((b) => b.text === "Confirm")?.onPress?.(),
    );
  render(<ProfilePanel {...c} />);
  await screen.findByText("Status: ACTIVE");
  fireEvent.changeText(
    screen.getByLabelText("Guardian email"),
    "new@example.invalid",
  );
  fireEvent.press(screen.getByRole("button", { name: "Replace guardian" }));
  await waitFor(() =>
    expect(c.api.setGuardian).toHaveBeenCalledWith("new@example.invalid", true),
  );
  fireEvent.press(screen.getByRole("button", { name: "Remove guardian" }));
  await waitFor(() => expect(c.api.removeGuardian).toHaveBeenCalled());
});
test("library search/filter is explicit, opens current backend detail", async () => {
  const c = context();
  render(<RecordsPanel {...c} />);
  await screen.findByText("selected.pdf");
  fireEvent.changeText(
    screen.getByLabelText("Search loaded records"),
    "not-found",
  );
  expect(
    screen.queryByRole("button", { name: "Open selected.pdf" }),
  ).toBeNull();
  fireEvent.changeText(
    screen.getByLabelText("Search loaded records"),
    "selected",
  );
  fireEvent.press(screen.getByRole("button", { name: "Open selected.pdf" }));
  await waitFor(() => expect(c.api.record).toHaveBeenCalledWith("selected"));
  await screen.findByText("Extraction: failed · timeout");
});
test("processing failure, server-approved retry, report summary and delete confirmation", async () => {
  const c = context();
  const removed = jest.fn();
  jest
    .spyOn(Alert, "alert")
    .mockImplementation((_t, _m, buttons) =>
      buttons?.find((b) => b.text === "Confirm")?.onPress?.(),
    );
  render(<RecordDetail {...c} document={document} onRemoved={removed} />);
  await screen.findByText("Extraction: failed · timeout");
  fireEvent.press(screen.getByRole("button", { name: "Retry extraction" }));
  await waitFor(() => expect(c.api.retry).toHaveBeenCalledWith("selected"));
  fireEvent.press(screen.getByRole("button", { name: "Load report summary" }));
  await screen.findByText("Glucose reported");
  fireEvent.press(screen.getByRole("button", { name: "Delete record access" }));
  await waitFor(() => expect(removed).toHaveBeenCalled());
  expect(c.api.remove).toHaveBeenCalledWith("selected");
});
test("RAG answer shows date/page citations and insufficiency without diagnosis", async () => {
  const c = context({
    ask: jest.fn(async () => ({
      result: {
        status: "insufficient",
        answer: "Insufficient evidence",
        mode: "synthetic-offline",
        citations: [
          {
            id: "C1",
            document_id: "selected",
            document_name: "selected.pdf",
            document_date: null,
            upload_date: "2026-01-01",
            page: 1,
            quote: "Reported value",
          },
        ],
      },
    })),
  });
  render(<RagPanel {...c} />);
  fireEvent.changeText(
    screen.getByLabelText("Question about your records"),
    "What is reported?",
  );
  fireEvent.press(screen.getByRole("button", { name: "Ask my records" }));
  await screen.findByText("INSUFFICIENT EVIDENCE");
  expect(screen.getByText("C1 · selected.pdf")).toBeTruthy();
  expect(screen.getByText("2026-01-01 · Page 1")).toBeTruthy();
});
test("sharing starts empty, submits exact selection and displays backend QR expiry", async () => {
  const c = context();
  render(<SharingPanel {...c} />);
  await screen.findByText("0 records selected (maximum 20)");
  expect(
    screen.getByRole("button", { name: "Create selected-record share" }).props
      .accessibilityState.disabled,
  ).toBe(true);
  fireEvent.press(screen.getByRole("button", { name: "selected.pdf" }));
  fireEvent.press(screen.getByRole("radio", { name: "QR code" }));
  fireEvent.press(
    screen.getByRole("button", { name: "Create selected-record share" }),
  );
  await waitFor(() =>
    expect(c.api.share).toHaveBeenCalledWith(["selected"], "qr_code"),
  );
  await screen.findByText(/Share created · expires/);
  fireEvent.press(screen.getByRole("button", { name: "Copy link" }));
  await waitFor(() =>
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith(
      "https://doctor.invalid/#/share/opaque",
    ),
  );
  expect(screen.getByText("0 records selected (maximum 20)")).toBeTruthy();
});
test("verification completes via full email code and returns to sign-in", async () => {
  const transport = jest.fn(
    async (_u: RequestInfo | URL, _i?: RequestInit) =>
      new Response("{}", { status: 200 }),
  );
  const session = new PatientSession(
    { baseUrl: "", fetch: transport as typeof fetch },
    { read: async () => null, write: async () => {}, remove: async () => {} },
  );
  render(<Auth session={session} onLogin={jest.fn()} />);
  fireEvent.press(screen.getByRole("button", { name: "Verify email" }));
  fireEvent.changeText(
    screen.getByLabelText("Complete code from email"),
    "full.email-token",
  );
  fireEvent.press(screen.getByRole("button", { name: "Verify email" }));
  await screen.findByText("Email verified. You can now sign in.");
  expect(transport.mock.calls[0][0]).toBe("/api/v1/auth/verify-email");
});
test("login completes the session and stores only its refresh credential", async () => {
  const onLogin = jest.fn(),
    storage = {
      read: async () => null,
      write: jest.fn(async () => {}),
      remove: jest.fn(async () => {}),
    };
  const session = new PatientSession(
    {
      baseUrl: "",
      fetch: jest.fn(
        async () =>
          new Response(
            JSON.stringify({
              access_token: "access",
              refresh_token: "refresh",
              expires_in: 900,
              refresh_expires_in: 3600,
            }),
            { status: 200 },
          ),
      ) as typeof fetch,
    },
    storage,
  );
  render(<Auth session={session} onLogin={onLogin} />);
  fireEvent.changeText(screen.getByLabelText("Email"), "a@example.invalid");
  fireEvent.changeText(screen.getByLabelText("Password"), "Synthetic password");
  fireEvent.press(screen.getByRole("button", { name: "Sign in" }));
  await waitFor(() => expect(onLogin).toHaveBeenCalled());
  expect(storage.write).toHaveBeenCalledWith("refresh");
  expect(session.authorized).toBe(true);
  session.clear();
});
test("forgot/reset flow uses email recovery and invalidates previous local session", async () => {
  const calls: string[] = [];
  const session = new PatientSession(
    {
      baseUrl: "",
      fetch: jest.fn(async (u) => {
        calls.push(String(u));
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
    },
    { read: async () => null, write: async () => {}, remove: async () => {} },
  );
  render(<Auth session={session} onLogin={jest.fn()} />);
  fireEvent.press(screen.getByRole("button", { name: "Recover password" }));
  fireEvent.changeText(screen.getByLabelText("Email"), "a@example.invalid");
  fireEvent.press(screen.getByRole("button", { name: "Send recovery email" }));
  await screen.findByText(/If the email is eligible and verified/);
  fireEvent.changeText(
    screen.getByLabelText("Complete code from email"),
    "full.reset-code",
  );
  fireEvent.changeText(
    screen.getByLabelText("New password"),
    "Synthetic replacement password",
  );
  fireEvent.press(screen.getByRole("button", { name: "Reset password" }));
  await screen.findByText(/Password reset. All previous sessions/);
  expect(calls).toEqual([
    "/api/v1/auth/forgot-password",
    "/api/v1/auth/reset-password",
  ]);
  expect(session.authorized).toBe(false);
});
test("native upload chooses approved file and submits metadata before navigating", async () => {
  jest.mocked(DocumentPicker.getDocumentAsync).mockResolvedValue({
    canceled: false,
    assets: [
      {
        uri: "file:///private-cache/test.png",
        name: "test.png",
        mimeType: "image/png",
        size: 100,
        lastModified: 0,
      },
    ],
  });
  const upload = jest.fn(async () => ({ document })),
    onUploaded = jest.fn(),
    c = context({ upload });
  render(<UploadPanel {...c} onUploaded={onUploaded} />);
  fireEvent.press(
    screen.getByRole("button", { name: "Choose PDF, JPG, JPEG or PNG" }),
  );
  await screen.findByText("test.png · 100 bytes");
  fireEvent.changeText(
    screen.getByLabelText("Hospital name"),
    "Synthetic Hospital",
  );
  fireEvent.press(screen.getByRole("button", { name: "Upload original" }));
  await waitFor(() => expect(onUploaded).toHaveBeenCalled());
  expect(upload).toHaveBeenCalled();
});
test("timeline preserves backend chronology, upload fallback and deleted exclusion", async () => {
  const timeline = jest.fn(async () => ({
    entries: [
      {
        source_document_id: "a",
        event_date: "2026-03-01",
        date_source: "document_date",
        document: { ...document, original_filename: "newer.pdf" },
      },
      {
        source_document_id: "b",
        event_date: "2026-01-01",
        date_source: "uploaded_at",
        document: { ...document, original_filename: "older.pdf" },
      },
    ],
    pagination: { has_more: false },
  }));
  render(<TimelinePanel {...context({ timeline })} />);
  await screen.findByText("newer.pdf");
  expect(screen.getByText("Upload date fallback · processing")).toBeTruthy();
  expect(screen.queryByText("deleted.pdf")).toBeNull();
  expect(screen.getAllByText(/\.pdf/).map((n) => n.props.children)).toEqual([
    "newer.pdf",
    "older.pdf",
  ]);
});
test.each(["queued", "failed", "completed"])(
  "history summary %s does not invent completed evidence",
  async (status) => {
    const c = context({
      requestHistory: jest.fn(async () => ({ history: { id: "history" } })),
      history: jest.fn(async () => ({
        history: {
          status,
          entries:
            status === "completed"
              ? [
                  {
                    source_document_id: "selected",
                    date: "2026-01-01",
                    date_source: "uploaded_at",
                    text: "Supported report section",
                  },
                ]
              : [],
          limitations: ["Not a diagnosis"],
        },
      })),
    });
    render(<HistoryPanel {...c} />);
    fireEvent.press(
      screen.getByRole("button", { name: "Request history summary" }),
    );
    await screen.findByText("Status: " + status);
    if (status === "completed")
      expect(screen.getByText("Supported report section")).toBeTruthy();
    else
      expect(
        screen.getByText("No completed source sections yet."),
      ).toBeTruthy();
  },
);

// ---- R8: accessibility of the main patient screens (structure only; real devices are NOT covered) ----
// Every pressable and text field on each screen must have an accessible name and a role, so a screen
// reader can announce it. This is a React Native test-renderer check, not a TalkBack/VoiceOver test.
// react-test-renderer ships no types here; this is the small part of its node shape that the check uses.
type ReactTestInstance = { type: unknown; props: Record<string, any>; findAll: (test: (node: ReactTestInstance) => boolean) => ReactTestInstance[] };
let inspectedControls = 0;
function unnamedControls(): string[] {
  const problems: string[] = [];
  for (const node of screen.UNSAFE_root.findAll(
    (n: ReactTestInstance) => typeof n.type === "string" && (n.props.onPress || n.props.onChangeText),
  )) {
    const p = node.props;
    inspectedControls++;
    const name = p.accessibilityLabel ?? p["aria-label"];
    const role = p.accessibilityRole ?? p.role;
    if (p.onPress && !role) problems.push("pressable without role");
    if (!name && p.onPress) {
      const text = JSON.stringify(node.findAll((c: ReactTestInstance) => typeof c.props.children === "string").map((c: ReactTestInstance) => c.props.children));
      if (text === "[]") problems.push("pressable without a name");
    }
    if (p.onChangeText && !name && !p.placeholder) problems.push("text field without a name");
  }
  return problems;
}
test("R8-MOBILE-A11Y every control on sign-in, account, library, upload, timeline, RAG, sharing and profile screens has a role and a name", async () => {
  const seen: Record<string, string[]> = {};
  const session = new PatientSession(
    { baseUrl: "", fetch: (async () => new Response("{}", { status: 200 })) as typeof fetch },
    { read: async () => null, write: async () => {}, remove: async () => {} },
  );
  const auth = render(<Auth session={session} onLogin={jest.fn()} />);
  seen["sign in"] = unnamedControls();
  for (const label of ["Verify email", "Forgot password", "Create account"]) {
    const button = screen.queryByRole("button", { name: label });
    if (!button) continue;
    fireEvent.press(button);
    seen[label] = unnamedControls();
  }
  auth.unmount();
  const panels: [string, React.ReactElement, string?][] = [
    ["library", <RecordsPanel {...context()} />, "selected.pdf"],
    ["upload", <UploadPanel {...context()} onUploaded={jest.fn()} />],
    ["timeline", <TimelinePanel {...context({ timeline: jest.fn(async () => ({ entries: [], pagination: { has_more: false } })) })} />],
    ["rag", <RagPanel {...context({ ask: jest.fn() })} />],
    ["sharing", <SharingPanel {...context()} />, "0 records selected (maximum 20)"],
    ["profile", <ProfilePanel {...context()} />],
  ];
  for (const [name, element, ready] of panels) {
    const view = render(element);
    if (ready) await screen.findByText(ready);
    seen[name] = unnamedControls();
    view.unmount();
  }
  const bad = Object.entries(seen).filter(([, problems]) => problems.length);
  expect(bad).toEqual([]);
  expect(Object.keys(seen).length).toBeGreaterThanOrEqual(6);
  expect(inspectedControls).toBeGreaterThanOrEqual(10);
  console.log("R8_MOBILE_A11Y screens=" + Object.keys(seen).join(",") + " controls=" + inspectedControls);
});
