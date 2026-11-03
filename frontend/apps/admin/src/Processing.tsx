import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  adminApi,
  adminJobErrorCodes,
  adminJobStates,
  adminMessage,
  InputError,
  type AdminJob,
  type AdminJobErrorCode,
  type AdminJobState,
  type AdminJobSummary,
  type AdminSession,
} from "@health-wallet/api";
import { Chip, Confirm, Detail, Field, Message, Pager, Select, short, when, type Notice } from "./ui";

const label = (s: string) => s.replace(/_/g, " ").toLowerCase();
const tone = (s: AdminJobState) =>
  s === "completed" ? "good" : s === "failed" ? "bad" : s === "retry_wait" || s === "cancelled" ? "warn" : "neutral";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Filters = { state: AdminJobState | ""; error: AdminJobErrorCode | ""; patient: string };
const none: Filters = { state: "", error: "", patient: "" };

export function Processing({ client }: { client: AdminSession }) {
  const api = adminApi(client);
  const [summary, setSummary] = useState<AdminJobSummary>(),
    [summaryNotice, setSummaryNotice] = useState<Notice>(),
    [draft, setDraft] = useState<Filters>(none),
    [applied, setApplied] = useState<Filters>(none),
    [cursors, setCursors] = useState<(string | undefined)[]>([undefined]),
    [rows, setRows] = useState<AdminJob[]>([]),
    [next, setNext] = useState<string | null>(null),
    [loading, setLoading] = useState(true),
    [listNotice, setListNotice] = useState<Notice>(),
    [selected, setSelected] = useState<AdminJob>(),
    [confirming, setConfirming] = useState(false),
    [acting, setActing] = useState(false),
    [detailNotice, setDetailNotice] = useState<Notice>();
  const request = useRef(0);

  const loadSummary = useCallback(async () => {
    try {
      setSummary((await adminApi(client).processingSummary()).summary);
      setSummaryNotice(undefined);
    } catch (error) {
      setSummaryNotice({ kind: "error", text: adminMessage(error) });
    }
  }, [client]);
  const load = useCallback(
    async (filters: Filters, cursor: string | undefined) => {
      const mine = ++request.current;
      setLoading(true);
      setListNotice(undefined);
      try {
        const page = await adminApi(client).jobs({
          state: filters.state || undefined,
          error_code: filters.error || undefined,
          patient_id: filters.patient.trim() || undefined,
          limit: 10,
          cursor,
        });
        if (mine !== request.current) return;
        setRows(page.items);
        setNext(page.nextCursor);
      } catch (error) {
        if (mine === request.current) {
          setRows([]);
          setNext(null);
          setListNotice({ kind: "error", text: adminMessage(error) });
        }
      } finally {
        if (mine === request.current) setLoading(false);
      }
    },
    [client],
  );
  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);
  useEffect(() => {
    void load(applied, cursors[cursors.length - 1]);
  }, [load, applied, cursors]);

  function search(e: FormEvent) {
    e.preventDefault();
    const patient = draft.patient.trim();
    if (patient && !uuid.test(patient)) {
      setListNotice({ kind: "error", text: new InputError("The patient ID must be a full ID, like 3f2c1a9e-….").message });
      return;
    }
    setSelected(undefined);
    setConfirming(false);
    setDetailNotice(undefined);
    setApplied({ ...draft, patient });
    setCursors([undefined]);
  }
  function reset() {
    setDraft(none);
    setApplied(none);
    setCursors([undefined]);
    setListNotice(undefined);
  }
  async function choose(job: AdminJob) {
    setConfirming(false);
    setDetailNotice(undefined);
    setSelected(job);
    try {
      setSelected((await api.job(job.document_id)).job);
    } catch (error) {
      setDetailNotice({ kind: "error", text: adminMessage(error) });
    }
  }
  async function retry() {
    if (!selected || acting) return;
    setActing(true);
    setDetailNotice(undefined);
    try {
      const { job } = await api.retryJob(selected.document_id);
      setSelected(job);
      setRows((list) => list.map((j) => (j.document_id === job.document_id ? job : j)));
      setConfirming(false);
      setDetailNotice({ kind: "success", text: "Retry queued. The job is waiting for the processing worker; attempts were not reset." });
      void loadSummary();
    } catch (error) {
      setConfirming(false);
      setDetailNotice({ kind: "error", text: adminMessage(error) });
      try {
        setSelected((await api.job(selected.document_id)).job);
      } catch {
        /* the error above is already shown */
      }
    } finally {
      setActing(false);
    }
  }

  return (
    <div className="screen">
      <h1>Document processing</h1>
      <p className="muted">
        Job states and failure reasons only. File names, text and summaries are never shown. Jobs of suspended or deleted accounts are not listed.
      </p>
      <section aria-label="Processing summary">
        <div className="row spread">
          <h2>Summary</h2>
          <button type="button" className="secondary" onClick={() => void loadSummary()}>Refresh counts</button>
        </div>
        <Message notice={summaryNotice} />
        {summary && (
          <>
            <ul className="cards">
              <li><b>{summary.total}</b><span>All jobs</span></li>
              {adminJobStates.map((s) => (
                <li key={s}><b>{summary.by_state[s]}</b><span>{label(s)}</span></li>
              ))}
              <li className={summary.running_with_expired_lease ? "alert-card" : ""}>
                <b>{summary.running_with_expired_lease}</b><span>expired leases</span>
              </li>
            </ul>
            <p className="muted small" aria-label="Failures by reason">
              Failures by reason:{" "}
              {adminJobErrorCodes.map((c) => `${label(c)} ${summary.failures_by_error_code[c]}`).join(" · ")}
            </p>
          </>
        )}
      </section>
      <h2>Jobs</h2>
      <form className="filters" onSubmit={search} aria-label="Filter jobs">
        <Select
          label="State"
          value={draft.state}
          onChange={(state) => setDraft({ ...draft, state })}
          options={[{ value: "", label: "Any state" }, ...adminJobStates.map((s) => ({ value: s, label: label(s) }))]}
        />
        <Select
          label="Failure reason"
          value={draft.error}
          onChange={(error) => setDraft({ ...draft, error })}
          options={[{ value: "", label: "Any reason" }, ...adminJobErrorCodes.map((c) => ({ value: c, label: label(c) }))]}
        />
        <Field label="Patient ID" value={draft.patient} onChange={(patient) => setDraft({ ...draft, patient })} hint="Optional, full ID" />
        <div className="row end">
          <button disabled={loading}>Apply filters</button>
          <button type="button" className="secondary" onClick={reset}>Reset</button>
        </div>
      </form>
      <Message notice={listNotice} />
      <div className="split">
        <section aria-label="Job list">
          <table className={"grid" + (loading ? " busy" : "")} aria-busy={loading}>
            <caption className="sr-only">Processing jobs</caption>
            <thead>
              <tr>
                <th scope="col">Document</th>
                <th scope="col">State</th>
                <th scope="col">Attempts</th>
                <th scope="col">Reason</th>
                <th scope="col">Updated</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((j) => (
                <tr key={j.document_id} className={selected?.document_id === j.document_id ? "selected" : ""}>
                  <td>
                    <button className="link" onClick={() => void choose(j)} aria-label={`Open job ${short(j.document_id)}`}>
                      <code>{short(j.document_id)}…</code>
                    </button>
                  </td>
                  <td><Chip tone={tone(j.state)}>{label(j.state)}</Chip></td>
                  <td>{j.attempt_count} of {j.max_attempts}</td>
                  <td>{j.last_error_code ? label(j.last_error_code) : "—"}</td>
                  <td>{when(j.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && rows.length === 0 && !listNotice && <p className="empty">No jobs match.</p>}
          {loading && <p className="muted" role="status">Loading…</p>}
          <Pager
            page={cursors.length}
            hasNext={next !== null}
            busy={loading}
            onPrevious={() => setCursors((c) => c.slice(0, -1))}
            onNext={() => next && setCursors((c) => [...c, next])}
          />
        </section>
        <aside className="panel" aria-label="Job detail">
          {!selected ? (
            <p className="muted">Select a job to see its details.</p>
          ) : (
            <>
              <h2>Job <code>{short(selected.document_id)}…</code></h2>
              <Detail
                rows={[
                  ["State", <Chip key="s" tone={tone(selected.state)}>{label(selected.state)}</Chip>],
                  ["Attempts", `${selected.attempt_count} of ${selected.max_attempts}`],
                  ["Failure reason", selected.last_error_code ? label(selected.last_error_code) : "None"],
                  ["Lease", selected.lease_active ? "Active" : selected.lease_expired ? "Expired" : "None"],
                  ["Next attempt", when(selected.next_attempt_at)],
                  ["Started", when(selected.started_at)],
                  ["Finished", when(selected.finished_at)],
                  ["Created", when(selected.created_at)],
                  ["Updated", when(selected.updated_at)],
                  ["Document ID", <code key="d">{selected.document_id}</code>],
                  ["Patient ID", <code key="p">{selected.patient_id}</code>],
                ]}
              />
              <Message notice={detailNotice} />
              {confirming ? (
                <Confirm
                  title="Retry this job?"
                  confirmLabel="Confirm retry"
                  busy={acting}
                  onConfirm={() => void retry()}
                  onCancel={() => setConfirming(false)}
                >
                  The job goes back to the queue and the processing worker picks it up. Attempts are not reset, and the retry only works if the existing rules allow it. This is recorded in the audit log.
                </Confirm>
              ) : selected.state === "failed" ? (
                <button onClick={() => { setDetailNotice(undefined); setConfirming(true); }}>Retry job</button>
              ) : (
                <p className="muted">Only failed jobs can be retried.</p>
              )}
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
