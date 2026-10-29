import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  DoctorSession,
  doctorApi,
  shareReference,
  searchLoaded,
  categories,
  medicalNotice,
  safeMessage,
  InputError,
  ApiError,
  type MedicalDocument,
  type Summary,
  type RagResult,
  type Timeline,
  type History,
  type Category,
} from "@health-wallet/api";
export function App({
  initialEntry = "",
  client: provided,
}: {
  initialEntry?: string;
  client?: DoctorSession;
}) {
  const [client] = useState(
    () => provided ?? new DoctorSession({ baseUrl: "" }),
  );
  const api = doctorApi(client);
  const [authorized, setAuthorized] = useState(false),
    [reference, setReference] = useState(initialEntry),
    [opened, setOpened] = useState(false),
    [email, setEmail] = useState(""),
    [name, setName] = useState(""),
    [organization, setOrganization] = useState(""),
    [challenge, setChallenge] = useState(""),
    [otp, setOtp] = useState(""),
    [challengeExpiry, setChallengeExpiry] = useState(0),
    [grantExpiry, setGrantExpiry] = useState(""),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [now, setNow] = useState(Date.now());
  const current = useRef(0);
  useEffect(
    () =>
      client.onClear(() => {
        current.current++;
        setAuthorized(false);
        setReference("");
        setOpened(false);
        setChallenge("");
        setOtp("");
        setName("");
        setEmail("");
        setOrganization("");
        setGrantExpiry("");
        setMessage("Access ended. Request a new patient share to continue.");
        setBusy(false);
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
  async function action(fn: () => Promise<void>) {
    if (busy) return;
    const version = current.current;
    setBusy(true);
    setMessage("");
    try {
      await fn();
    } catch (e) {
      if (version === current.current) setMessage(safeMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function open(e: FormEvent) {
    e.preventDefault();
    await action(async () => {
      const result = await api.open(shareReference(reference));
      setGrantExpiry(result.expires_at);
      setOpened(true);
      setMessage(
        "Share found. Verify your email to open the selected records.",
      );
    });
  }
  async function requestOtp(e?: FormEvent) {
    e?.preventDefault();
    await action(async () => {
      const result = await api.otp({
        share_token: shareReference(reference),
        name: name.trim(),
        email: email.trim(),
        ...(organization.trim() ? { organization: organization.trim() } : {}),
      });
      setChallenge(result.challenge_id);
      setChallengeExpiry(Date.now() + result.expires_in * 1000);
      setOtp("");
      setMessage("A verification code was requested. Check your email.");
    });
  }
  async function verify(e: FormEvent) {
    e.preventDefault();
    await action(async () => {
      const result = await api.verify({
        share_token: shareReference(reference),
        email: email.trim(),
        challenge_id: challenge,
        otp: otp.trim(),
      });
      const expiry = new Date(
        Math.min(Date.parse(grantExpiry), Date.parse(result.expires_at)),
      ).toISOString();
      client.authorize(result.access_token, expiry);
      setGrantExpiry(expiry);
      setAuthorized(true);
      setMessage("");
    });
  }
  return (
    <div className="shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Health Wallet home">
          <span className="brand-mark">✚</span> health<span>wallet</span>
        </a>
        <span className="environment">SYNTHETIC DEVELOPMENT</span>
        {authorized && (
          <button className="quiet" onClick={() => client.clear()}>
            End session
          </button>
        )}
      </header>
      {authorized ? (
        <Workspace client={client} expires={grantExpiry} />
      ) : (
        <main className="entry">
          <section className="intro">
            <span className="eyebrow">PATIENT-APPROVED ACCESS</span>
            <h1>
              A clearer picture.
              <br />
              <em>Shared with care.</em>
            </h1>
            <p>
              Review the records a patient has chosen to share with you, in one
              secure, temporary workspace.
            </p>
            <div className="principles">
              <p>
                <b>01</b> Only selected records
              </p>
              <p>
                <b>02</b> Email verification before access
              </p>
              <p>
                <b>03</b> Access ends when the share expires
              </p>
            </div>
            <p className="muted">No permanent doctor account required.</p>
          </section>
          <section className="entry-card">
            <span className="eyebrow">
              {!opened
                ? "01 / OPEN SHARE"
                : !challenge
                  ? "02 / IDENTIFY YOURSELF"
                  : "03 / VERIFY EMAIL"}
            </span>
            <h2>
              {!opened
                ? "Open a patient share"
                : !challenge
                  ? "Your details"
                  : "Check your inbox"}
            </h2>
            <p className="muted">
              {!opened
                ? "Use the link or reference from a patient’s QR code."
                : !challenge
                  ? "Your email will be verified for this share only."
                  : "Paste the complete code from the email. Codes may include letters and punctuation."}
            </p>
            {!opened ? (
              <form onSubmit={open}>
                <Field
                  label="Patient share link or QR reference"
                  value={reference}
                  onChange={setReference}
                  type="password"
                  autoComplete="off"
                />
                <button disabled={busy || !reference}>
                  Continue securely <span>→</span>
                </button>
              </form>
            ) : (
              <>
                {!challenge ? (
                  <form onSubmit={requestOtp}>
                    <Field
                      label="Doctor name"
                      value={name}
                      onChange={setName}
                      autoComplete="name"
                    />
                    <Field
                      label="Email"
                      value={email}
                      onChange={setEmail}
                      type="email"
                      autoComplete="email"
                    />
                    <Field
                      label="Organization (optional)"
                      value={organization}
                      onChange={setOrganization}
                      optional
                    />
                    <button disabled={busy || !name.trim() || !email}>
                      Send verification code →
                    </button>
                  </form>
                ) : (
                  <form onSubmit={verify}>
                    <Field
                      label="Complete email verification code"
                      value={otp}
                      onChange={setOtp}
                      type="password"
                      autoComplete="one-time-code"
                    />
                    <p className="muted">
                      {now >= challengeExpiry
                        ? "Code expired. Request a new code."
                        : `Code expires in ${Math.ceil((challengeExpiry - now) / 1000)} seconds.`}
                    </p>
                    <button disabled={busy || !otp || now >= challengeExpiry}>
                      Verify & open records →
                    </button>
                    <button
                      className="quiet"
                      type="button"
                      disabled={busy}
                      onClick={() => void requestOtp()}
                    >
                      Resend code
                    </button>
                  </form>
                )}
                <button
                  className="quiet"
                  disabled={busy}
                  onClick={() => client.clear()}
                >
                  Use another share
                </button>
              </>
            )}
            {busy && <p role="status">Working securely…</p>}
            {message && (
              <p role="status" className="notice">
                {message}
              </p>
            )}
            <div className="privacy-note">
              ◈ Medical content appears only after backend authorization.
            </div>
          </section>
        </main>
      )}
      <footer>{medicalNotice}</footer>
    </div>
  );
}
function Field({
  label,
  value,
  onChange,
  type = "text",
  optional = false,
  autoComplete = "off",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  optional?: boolean;
  autoComplete?: string;
}) {
  return (
    <label>
      {label}
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        type={type}
        required={!optional}
        maxLength={1000}
        autoComplete={autoComplete}
      />
    </label>
  );
}
function Workspace({
  client,
  expires,
}: {
  client: DoctorSession;
  expires: string;
}) {
  const api = doctorApi(client);
  const [tab, setTab] = useState("Records"),
    [records, setRecords] = useState<MedicalDocument[]>([]),
    [more, setMore] = useState(false),
    [search, setSearch] = useState(""),
    [category, setCategory] = useState<Category | "">(""),
    [hospital, setHospital] = useState(""),
    [from, setFrom] = useState(""),
    [to, setTo] = useState(""),
    [detail, setDetail] = useState<MedicalDocument>(),
    [summary, setSummary] = useState<Summary>(),
    [timeline, setTimeline] = useState<Timeline>(),
    [history, setHistory] = useState<History>(),
    [question, setQuestion] = useState(""),
    [answer, setAnswer] = useState<RagResult>(),
    [file, setFile] = useState<{ url: string; type: string }>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const urls = useRef(new Set<string>()),
    alive = useRef(true),
    lock = useRef(false),
    version = useRef(0);
  const dispose = () => {
    for (const url of urls.current) URL.revokeObjectURL(url);
    urls.current.clear();
    setFile(undefined);
  };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      version.current++;
      for (const url of urls.current) URL.revokeObjectURL(url);
      urls.current.clear();
    };
  }, []);
  async function run(fn: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    const v = version.current;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      if (alive.current && client.authorized && v === version.current) {
        setError(safeMessage(e));
        if (e instanceof ApiError && e.status === 404) {
          dispose();
          setDetail(undefined);
          setSummary(undefined);
          setAnswer(undefined);
          setTimeline(undefined);
          setHistory(undefined);
          setRecords([]);
          setMore(false);
        }
      }
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  }
  const filters = {
    category: category || undefined,
    hospital: hospital.trim() || undefined,
    uploaded_from: from || undefined,
    uploaded_to: to || undefined,
    limit: 20,
  };
  async function load(append = false) {
    const result = await api.records({
      ...filters,
      offset: append ? records.length : 0,
    });
    if (!alive.current || !client.authorized) return;
    setRecords(append ? [...records, ...result.documents] : result.documents);
    setMore(result.pagination.has_more);
  }
  useEffect(() => {
    void run(() => load());
    const refresh = () => {
      if (document.visibilityState === "visible") {
        dispose();
        setRecords([]);
        setDetail(undefined);
        setSummary(undefined);
        setHistory(undefined);
        setTimeline(undefined);
        setAnswer(undefined);
        void run(() => load());
      }
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);
  async function chooseTab(next: string) {
    dispose();
    setDetail(undefined);
    setSummary(undefined);
    setHistory(undefined);
    setTimeline(undefined);
    setAnswer(undefined);
    setTab(next);
    await run(async () => {
      if (next === "Records") await load();
      if (next === "Timeline") setTimeline(await api.timeline({ limit: 100 }));
      if (next === "Summary") setHistory(await api.history());
    });
  }
  async function openRecord(record: MedicalDocument) {
    dispose();
    setSummary(undefined);
    await run(async () => setDetail((await api.record(record.id)).document));
  }
  async function original(download: boolean) {
    if (!detail) return;
    await run(async () => {
      dispose();
      const blob = await api.file(detail.id, download);
      if (!alive.current || !client.authorized) return;
      const url = URL.createObjectURL(blob);
      urls.current.add(url);
      if (download) {
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = detail.original_filename;
        anchor.click();
        setTimeout(() => {
          URL.revokeObjectURL(url);
          urls.current.delete(url);
        }, 1000);
      } else setFile({ url, type: detail.content_type });
    });
  }
  const visible = searchLoaded(records, search);
  return (
    <main className="workspace">
      <aside>
        <span className="eyebrow">SHARED WORKSPACE</span>
        <h2>Record review</h2>
        <p className="muted">A patient-selected view</p>
        <nav>
          {["Records", "Timeline", "Summary", "Ask records"].map((t, i) => (
            <button
              key={t}
              disabled={busy}
              className={tab === t ? "nav-active" : "quiet"}
              onClick={() => void chooseTab(t)}
            >
              <span>{["▤", "◷", "≋", "◇"][i]}</span>
              {t}
            </button>
          ))}
        </nav>
        <div className="access-card">
          <span className="dot" /> Temporary access
          <p>Ends {new Date(expires).toLocaleString()}</p>
          <small>Each request checks current authorization.</small>
        </div>
      </aside>
      <section className="content">
        <div className="section-head">
          <div>
            <span className="eyebrow">SHARED CARE / {tab.toUpperCase()}</span>
            <h1>
              {tab === "Records"
                ? "The records you can review"
                : tab === "Timeline"
                  ? "A history, in context"
                  : tab === "Summary"
                    ? "Source-linked summaries"
                    : "Ask the shared evidence"}
            </h1>
          </div>
          <span className="scope-tag">Selected records only</span>
        </div>
        {busy && <p role="status">Loading authorized content…</p>}
        {error && (
          <p className="notice" role="alert">
            {error}
          </p>
        )}
        {tab === "Records" && (
          <>
            <form
              className="filters"
              onSubmit={(e) => {
                e.preventDefault();
                dispose();
                setDetail(undefined);
                setSummary(undefined);
                setRecords([]);
                void run(() => load());
              }}
            >
              <Field
                label="Search loaded records"
                value={search}
                onChange={setSearch}
                optional
              />
              <label>
                Category
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value as Category | "")}
                >
                  <option value="">All shared categories</option>
                  {Object.entries(categories).map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
              <Field
                label="Hospital"
                value={hospital}
                onChange={setHospital}
                optional
              />
              <Field
                label="Uploaded from"
                type="date"
                value={from}
                onChange={setFrom}
                optional
              />
              <Field
                label="Uploaded to"
                type="date"
                value={to}
                onChange={setTo}
                optional
              />
              <button disabled={busy}>Apply filters</button>
            </form>
            <div className="list-heading">
              <h3>
                Shared documents <span>{records.length}</span>
              </h3>
              <p className="muted">Search applies to loaded results.</p>
            </div>
            <div className="record-list">
              {visible.map((d) => (
                <button
                  className="record"
                  key={d.id}
                  onClick={() => void openRecord(d)}
                  disabled={busy}
                >
                  <span className="file-icon">
                    {d.content_type === "application/pdf" ? "PDF" : "IMG"}
                  </span>
                  <span className="record-name">
                    <strong>{d.original_filename}</strong>
                    <small>
                      {d.hospital_name} · {d.category_label}
                    </small>
                  </span>
                  <span className="record-date">
                    {d.document_date ?? d.uploaded_at.slice(0, 10)}
                    <small>
                      {d.document_date
                        ? "Document date"
                        : "Upload date fallback"}
                    </small>
                  </span>
                  <span>↗</span>
                </button>
              ))}
              {!visible.length && !busy && (
                <Empty>No shared documents match these filters.</Empty>
              )}
            </div>
            {more && (
              <button
                disabled={busy}
                onClick={() => void run(() => load(true))}
              >
                Load more records
              </button>
            )}
            {detail && (
              <article className="detail">
                <div className="section-head">
                  <h2>{detail.original_filename}</h2>
                  <button
                    className="quiet"
                    onClick={() => {
                      dispose();
                      setDetail(undefined);
                      setSummary(undefined);
                    }}
                  >
                    Close record
                  </button>
                </div>
                <dl>
                  <dt>Category</dt>
                  <dd>{detail.category_label}</dd>
                  <dt>Hospital</dt>
                  <dd>{detail.hospital_name}</dd>
                  <dt>Document date</dt>
                  <dd>{detail.document_date ?? "Not provided"}</dd>
                  <dt>Uploaded</dt>
                  <dd>{new Date(detail.uploaded_at).toLocaleString()}</dd>
                  <dt>File</dt>
                  <dd>
                    {detail.content_type} · {detail.size_bytes.toLocaleString()}{" "}
                    bytes
                  </dd>
                  <dt>Processing</dt>
                  <dd>
                    {detail.processing_status} · does not imply AI completion
                  </dd>
                </dl>
                <div className="actions">
                  <button disabled={busy} onClick={() => void original(false)}>
                    View original
                  </button>
                  <button
                    disabled={busy}
                    className="secondary"
                    onClick={() => void original(true)}
                  >
                    Download original
                  </button>
                  <button
                    disabled={busy}
                    className="secondary"
                    onClick={() =>
                      void run(async () =>
                        setSummary((await api.summary(detail.id)).summary),
                      )
                    }
                  >
                    Load report summary
                  </button>
                </div>
                {summary && <SummaryView summary={summary} />}
                {file && (
                  <section>
                    <button className="quiet" onClick={dispose}>
                      Close original
                    </button>
                    {file.type === "application/pdf" ? (
                      <iframe
                        title="Authorized original document"
                        src={file.url}
                      />
                    ) : (
                      <img
                        className="original-image"
                        src={file.url}
                        alt="Authorized original document"
                      />
                    )}
                  </section>
                )}
              </article>
            )}
          </>
        )}
        {tab === "Timeline" && (
          <>
            <p className="muted">
              Newest first · document date, otherwise UTC upload date. Deleted
              or restricted sources are excluded by the backend.
            </p>
            {timeline?.entries.map((e) => (
              <article className="timeline-event" key={e.source_document_id}>
                <time>{e.event_date}</time>
                <div>
                  <h3>{e.document.original_filename}</h3>
                  <p>
                    {e.document.hospital_name} ·{" "}
                    {e.date_source === "document_date"
                      ? "Document date"
                      : "Upload date fallback"}
                  </p>
                  <p className="muted">
                    Processing: {e.document.processing_status}
                  </p>
                  <button
                    className="quiet"
                    onClick={() => {
                      setTab("Records");
                      void openRecord(e.document);
                    }}
                  >
                    Open source record →
                  </button>
                </div>
              </article>
            ))}
            {timeline && !timeline.entries.length && (
              <Empty>No shared timeline entries.</Empty>
            )}
            {timeline?.pagination.has_more && (
              <p>
                Showing the first 100 entries. Use the record filters to narrow
                your review.
              </p>
            )}
          </>
        )}
        {tab === "Summary" && (
          <>
            <p className="muted">
              Only current summaries from shared sources appear. Missing
              evidence is not inferred.
            </p>
            {history?.entries.map((e) => (
              <article className="detail" key={e.source_document_id}>
                <span className="eyebrow">
                  {e.date} · {e.date_source}
                </span>
                {e.summary ? (
                  <SummaryView summary={e.summary} />
                ) : (
                  <p>Summary unavailable or insufficient source evidence.</p>
                )}
                <button
                  className="quiet"
                  onClick={() => {
                    setTab("Records");
                    void run(async () =>
                      setDetail(
                        (await api.record(e.source_document_id)).document,
                      ),
                    );
                  }}
                >
                  Open source record →
                </button>
              </article>
            ))}
            {history && !history.entries.length && (
              <Empty>No summaries available for this share.</Empty>
            )}
            {history?.limitations?.map((l) => (
              <p key={l} className="muted">
                {l}
              </p>
            ))}
          </>
        )}
        {tab === "Ask records" && (
          <>
            <p className="muted">
              Ask a factual question about the selected records. This tool does
              not diagnose, prescribe or fill gaps in evidence.
            </p>
            <form
              className="question-form"
              onSubmit={(e) => {
                e.preventDefault();
                setAnswer(undefined);
                void run(async () =>
                  setAnswer((await api.ask(question)).result),
                );
              }}
            >
              <label>
                Your question
                <textarea
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  maxLength={1000}
                  required
                  placeholder="What measurements are reported in these records?"
                />
              </label>
              <button disabled={busy || !question.trim()}>
                Ask shared records →
              </button>
            </form>
            {answer && (
              <article className="detail">
                <span className="eyebrow">
                  {answer.status === "insufficient"
                    ? "INSUFFICIENT EVIDENCE"
                    : "GROUNDED RESPONSE"}
                </span>
                <p className="answer">{answer.answer}</p>
                <p className="muted">Mode: {answer.mode}</p>
                <h3>Sources</h3>
                {answer.citations.map((c) => (
                  <blockquote key={c.id}>
                    <b>
                      {c.id} · {c.document_name}
                    </b>
                    <p>
                      {c.document_date ?? c.upload_date?.slice(0, 10)} ·{" "}
                      {c.page === null
                        ? "Page not available"
                        : `Page ${c.page}`}
                    </p>
                    <p>“{c.quote}”</p>
                    <button
                      className="quiet"
                      onClick={() => {
                        setTab("Records");
                        void run(async () =>
                          setDetail((await api.record(c.document_id)).document),
                        );
                      }}
                    >
                      Open cited record →
                    </button>
                  </blockquote>
                ))}
                {!answer.citations.length && (
                  <p>No supporting source citations available.</p>
                )}
              </article>
            )}
          </>
        )}
      </section>
    </main>
  );
}
function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="empty">
      <span>▤</span>
      <h3>{children}</h3>
      <p>Only records authorized by the patient can appear here.</p>
    </div>
  );
}
function SummaryView({ summary }: { summary: Summary }) {
  return (
    <section className="summary">
      <span className="eyebrow">INFORMATIONAL · {summary.mode}</span>
      <p className="answer">{summary.text}</p>
      <p className="muted">
        Generated {new Date(summary.generated_at).toLocaleString()} ·{" "}
        {summary.provider ?? "Provider unspecified"} ·{" "}
        {summary.model ?? "Model unspecified"}
      </p>
      {summary.limitations.map((l) => (
        <p key={l} className="muted">
          {l}
        </p>
      ))}
    </section>
  );
}
