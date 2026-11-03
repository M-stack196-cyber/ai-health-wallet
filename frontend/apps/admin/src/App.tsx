import { useEffect, useState, type FormEvent } from "react";
import { AdminSession, adminMessage, type AdminSessionEnd } from "@health-wallet/api";
import { Field, Message, type Notice } from "./ui";
import { Patients } from "./Patients";
import { Processing } from "./Processing";

const endNotice = (reason?: AdminSessionEnd): Notice =>
  reason === "expired"
    ? { kind: "error", text: "Your session expired after 15 minutes. Sign in again to continue." }
    : reason === "signed_out"
      ? { kind: "info", text: "You signed out. Nothing is kept in this browser." }
      : { kind: "error", text: "Your session is no longer valid. Sign in again." };

type Screen = "patients" | "processing";

export function App({ client: provided }: { client?: AdminSession }) {
  const [client] = useState(
    () => provided ?? new AdminSession({ baseUrl: "" }),
  );
  const [signedIn, setSignedIn] = useState(false),
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
      setPassword("");
      setSignedIn(true);
    } catch (error) {
      setNotice({ kind: "error", text: adminMessage(error) });
    } finally {
      setBusy(false);
    }
  }
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
              <button
                className={"tab" + (screen === "patients" ? " current" : "")}
                aria-current={screen === "patients" ? "page" : undefined}
                onClick={() => setScreen("patients")}
              >
                Patient accounts
              </button>
              <button
                className={"tab" + (screen === "processing" ? " current" : "")}
                aria-current={screen === "processing" ? "page" : undefined}
                onClick={() => setScreen("processing")}
              >
                Processing
              </button>
            </nav>
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
      {signedIn ? (
        <main className="workspace">
          {screen === "patients" ? (
            <Patients client={client} />
          ) : (
            <Processing client={client} />
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
