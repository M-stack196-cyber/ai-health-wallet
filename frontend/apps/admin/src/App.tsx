import { useEffect, useState, type FormEvent } from "react";
import { AdminSession, adminApi, adminMessage, type AdminMe, type AdminSessionEnd } from "@health-wallet/api";
import { Field, Message, type Notice } from "./ui";
import { Patients } from "./Patients";
import { Processing } from "./Processing";
import { Deliveries, Guardians, Shares } from "./Status";
import { Settings } from "./Settings";
import { Rules } from "./Rules";
import { Health } from "./Health";
import { Audit } from "./Audit";

const endNotice = (reason?: AdminSessionEnd): Notice =>
  reason === "expired"
    ? { kind: "error", text: "Your session expired after 15 minutes. Sign in again to continue." }
    : reason === "signed_out"
      ? { kind: "info", text: "You signed out. Nothing is kept in this browser." }
      : { kind: "error", text: "Your session is no longer valid. Sign in again." };

/** Each menu item needs one permission. This only decides what is shown; the backend checks every request itself. */
const sections = [
  { id: "patients", label: "Patient accounts", permission: "admin.patients.read" },
  { id: "processing", label: "Processing", permission: "admin.processing.read" },
  { id: "guardians", label: "Guardians", permission: "admin.guardians.read" },
  { id: "shares", label: "Share grants", permission: "admin.shares.read" },
  { id: "deliveries", label: "Deliveries", permission: "admin.deliveries.read" },
  { id: "settings", label: "Settings", permission: "admin.settings.read" },
  { id: "rules", label: "Serious rules", permission: "admin.rules.read" },
  { id: "health", label: "System health", permission: "admin.health.read" },
  { id: "audit", label: "Audit log", permission: "admin.audit.read" },
] as const;
type Screen = (typeof sections)[number]["id"];

export function App({ client: provided }: { client?: AdminSession }) {
  const [client] = useState(
    () => provided ?? new AdminSession({ baseUrl: "" }),
  );
  const [admin, setAdmin] = useState<AdminMe>(),
    [signedIn, setSignedIn] = useState(false),
    [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState<Notice>(),
    [screen, setScreen] = useState<Screen>("patients"),
    [now, setNow] = useState(Date.now());
  // The token lives only in the client object (memory). Ending the session unmounts every screen.
  useEffect(
    () =>
      client.onClear(() => {
        setSignedIn(false);
        setAdmin(undefined);
        setPassword("");
        setBusy(false);
        setNotice(endNotice(client.endReason));
      }),
    [client],
  );
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    const clear = () => client.clear();
    window.addEventListener("pagehide", clear);
    return () => {
      window.removeEventListener("pagehide", clear);
      client.clear();
    };
  }, [client]);

  async function signIn(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setNotice(undefined);
    try {
      await client.login(email.trim(), password);
      // The profile says which sections this role may open. If it cannot be read, the session is not kept.
      const me = (await adminApi(client).me()).admin;
      setPassword("");
      setAdmin(me);
      setSignedIn(true);
    } catch (error) {
      if (client.authorized) client.signOut();
      setNotice({ kind: "error", text: adminMessage(error) });
    } finally {
      setBusy(false);
    }
  }
  const visible = admin ? sections.filter((section) => admin.permissions.includes(section.permission)) : [],
    current = visible.find((section) => section.id === screen)?.id ?? visible[0]?.id;
  const remaining = Math.max(0, Math.ceil((client.expiresAt - now) / 1000));
  const clock = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`;

  return (
    <div className="shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Health Wallet admin home">
          <span className="brand-mark">✚</span> health<span>wallet</span>
          <span className="role">Admin</span>
        </a>
        <span className="environment">SYNTHETIC DEVELOPMENT</span>
        {signedIn && (
          <>
            <nav className="nav" aria-label="Sections">
              {visible.map((section) => (
                <button
                  key={section.id}
                  className={"tab" + (current === section.id ? " current" : "")}
                  aria-current={current === section.id ? "page" : undefined}
                  onClick={() => setScreen(section.id)}
                >
                  {section.label}
                </button>
              ))}
            </nav>
            <span className="who" aria-label="Signed in as">
              {admin?.full_name} · {admin?.role.replace(/_/g, " ")}
            </span>
            <span
              className={"timer" + (remaining <= 60 ? " soon" : "")}
              role="timer"
              aria-label="Time left in this session"
            >
              Session ends in {clock}
            </span>
            <button className="secondary" onClick={() => client.signOut()}>
              Sign out
            </button>
          </>
        )}
      </header>
      {signedIn && admin ? (
        <main className="workspace">
          {current === "patients" && <Patients client={client} />}
          {current === "processing" && <Processing client={client} />}
          {current === "guardians" && <Guardians client={client} />}
          {current === "shares" && <Shares client={client} />}
          {current === "deliveries" && <Deliveries client={client} />}
          {current === "settings" && <Settings client={client} admin={admin} />}
          {current === "rules" && <Rules client={client} admin={admin} />}
          {current === "health" && <Health client={client} />}
          {current === "audit" && <Audit client={client} />}
          {current === undefined && (
            <p className="empty">
              Your admin role has no screens in this dashboard. Ask the person who manages admin roles.
            </p>
          )}
        </main>
      ) : (
        <main className="login">
          <section className="login-card">
            <span className="eyebrow">ADMINISTRATION</span>
            <h1>Sign in</h1>
            <p className="muted">
              Administrators sign in here with their own account. Patient and
              doctor sign-ins do not work on this page.
            </p>
            <Message notice={notice} />
            <form onSubmit={signIn}>
              <Field
                label="Email"
                value={email}
                onChange={setEmail}
                type="email"
                autoComplete="username"
              />
              <Field
                label="Password"
                value={password}
                onChange={setPassword}
                type="password"
                autoComplete="current-password"
              />
              <button disabled={busy || !email.trim() || !password}>
                {busy ? "Signing in…" : "Sign in"}
              </button>
            </form>
            <p className="muted small">
              Sessions last 15 minutes. You will be asked to sign in again when
              one ends.
            </p>
          </section>
        </main>
      )}
    </div>
  );
}
