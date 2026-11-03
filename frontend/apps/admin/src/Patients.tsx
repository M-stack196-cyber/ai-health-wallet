import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  adminApi,
  adminMessage,
  adminPatientStatuses,
  type AdminPatient,
  type AdminPatientStatus,
  type AdminSession,
} from "@health-wallet/api";
import { Chip, Confirm, Detail, Field, Message, Pager, Select, short, when, type Notice } from "./ui";

const label = (s: string) => s.replace(/_/g, " ");
const tone = (s: AdminPatientStatus) =>
  s === "active" ? "good" : s === "suspended" ? "warn" : s === "unverified" ? "neutral" : "bad";
type Filters = { q: string; status: AdminPatientStatus | ""; verified: "" | "true" | "false" };
const none: Filters = { q: "", status: "", verified: "" };

export function Patients({ client }: { client: AdminSession }) {
  const api = adminApi(client);
  const [draft, setDraft] = useState<Filters>(none),
    [applied, setApplied] = useState<Filters>(none),
    [cursors, setCursors] = useState<(string | undefined)[]>([undefined]),
    [rows, setRows] = useState<AdminPatient[]>([]),
    [next, setNext] = useState<string | null>(null),
    [loading, setLoading] = useState(true),
    [listNotice, setListNotice] = useState<Notice>(),
    [selected, setSelected] = useState<AdminPatient>(),
    [confirm, setConfirm] = useState<"suspend" | "reactivate">(),
    [acting, setActing] = useState(false),
    [detailNotice, setDetailNotice] = useState<Notice>();
  const request = useRef(0);

  const load = useCallback(
    async (filters: Filters, cursor: string | undefined) => {
      const mine = ++request.current;
      setLoading(true);
      setListNotice(undefined);
      try {
        const page = await adminApi(client).patients({
          q: filters.q.trim() || undefined,
          status: filters.status || undefined,
          verified: filters.verified === "" ? undefined : filters.verified === "true",
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
    void load(applied, cursors[cursors.length - 1]);
  }, [load, applied, cursors]);

  function search(e: FormEvent) {
    e.preventDefault();
    const q = draft.q.trim();
    if (q.length === 1) {
      setListNotice({ kind: "error", text: "Enter at least 2 characters to search, or leave the box empty." });
      return;
    }
    setSelected(undefined);
    setConfirm(undefined);
    setDetailNotice(undefined);
    setApplied({ ...draft, q });
    setCursors([undefined]);
  }
  function reset() {
    setDraft(none);
    setApplied(none);
    setCursors([undefined]);
    setListNotice(undefined);
  }
  async function choose(patient: AdminPatient) {
    setConfirm(undefined);
    setDetailNotice(undefined);
    setSelected(patient);
    try {
      setSelected((await api.patient(patient.id)).patient);
    } catch (error) {
      setDetailNotice({ kind: "error", text: adminMessage(error) });
    }
  }
  async function act(kind: "suspend" | "reactivate") {
    if (!selected || acting) return;
    setActing(true);
    setDetailNotice(undefined);
    try {
      const { patient } = await (kind === "suspend" ? api.suspend(selected.id) : api.reactivate(selected.id));
      setSelected(patient);
      setRows((list) => list.map((p) => (p.id === patient.id ? patient : p)));
      setConfirm(undefined);
      setDetailNotice({
        kind: "success",
        text:
          kind === "suspend"
            ? `${patient.full_name} was suspended. Their sessions, doctor shares and report links were ended.`
            : `${patient.full_name} was reactivated. They must sign in again; earlier sessions and shares stay ended.`,
      });
    } catch (error) {
      setConfirm(undefined);
      setDetailNotice({ kind: "error", text: adminMessage(error) });
      // Reload the account so the screen shows its real, current status.
      try {
        setSelected((await api.patient(selected.id)).patient);
      } catch {
        /* the error above is already shown */
      }
    } finally {
      setActing(false);
    }
  }

  return (
    <div className="screen">
      <h1>Patient accounts</h1>
      <p className="muted">
        Account status and email verification only. Medical records are never shown here.
      </p>
      <form className="filters" onSubmit={search} aria-label="Search patient accounts">
        <Field label="Search name or email" value={draft.q} onChange={(q) => setDraft({ ...draft, q })} hint="At least 2 characters" />
        <Select
          label="Status"
          value={draft.status}
          onChange={(status) => setDraft({ ...draft, status })}
          options={[{ value: "", label: "Any status" }, ...adminPatientStatuses.map((s) => ({ value: s, label: label(s) }))]}
        />
        <Select
          label="Email verified"
          value={draft.verified}
          onChange={(verified) => setDraft({ ...draft, verified: verified as Filters["verified"] })}
          options={[{ value: "", label: "Any" }, { value: "true", label: "Verified" }, { value: "false", label: "Not verified" }]}
        />
        <div className="row end">
          <button disabled={loading}>Search</button>
          <button type="button" className="secondary" onClick={reset}>Reset</button>
        </div>
      </form>
      <Message notice={listNotice} />
      <div className="split">
        <section aria-label="Patient accounts list">
          <table className={"grid" + (loading ? " busy" : "")} aria-busy={loading}>
            <caption className="sr-only">Patient accounts</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Email</th>
                <th scope="col">Status</th>
                <th scope="col">Verified</th>
                <th scope="col">Created</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} className={selected?.id === p.id ? "selected" : ""}>
                  <td>
                    <button className="link" onClick={() => void choose(p)} aria-label={`Open ${p.full_name}`}>
                      {p.full_name}
                    </button>
                  </td>
                  <td>{p.email}</td>
                  <td><Chip tone={tone(p.account_status)}>{label(p.account_status)}</Chip></td>
                  <td>{p.email_verified ? "Yes" : "No"}</td>
                  <td>{when(p.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && rows.length === 0 && !listNotice && <p className="empty">No patient accounts match.</p>}
          {loading && <p className="muted" role="status">Loading…</p>}
          <Pager
            page={cursors.length}
            hasNext={next !== null}
            busy={loading}
            onPrevious={() => setCursors((c) => c.slice(0, -1))}
            onNext={() => next && setCursors((c) => [...c, next])}
          />
        </section>
        <aside className="panel" aria-label="Account detail">
          {!selected ? (
            <p className="muted">Select an account to see its status and available actions.</p>
          ) : (
            <>
              <h2>{selected.full_name}</h2>
              <Detail
                rows={[
                  ["Email", selected.email],
                  ["Status", <Chip key="s" tone={tone(selected.account_status)}>{label(selected.account_status)}</Chip>],
                  ["Email verified", selected.email_verified ? `Yes (${when(selected.email_verified_at)})` : "No"],
                  ["Created", when(selected.created_at)],
                  ["Last changed", when(selected.updated_at)],
                  ["Account ID", <code key="i">{selected.id}</code>],
                ]}
              />
              <Message notice={detailNotice} />
              {confirm === "suspend" ? (
                <Confirm
                  title={`Suspend ${selected.full_name}?`}
                  confirmLabel="Confirm suspend"
                  danger
                  busy={acting}
                  onConfirm={() => void act("suspend")}
                  onCancel={() => setConfirm(undefined)}
                >
                  They are signed out everywhere, and any doctor shares and guardian report links stop working at once. This is recorded in the audit log.
                </Confirm>
              ) : confirm === "reactivate" ? (
                <Confirm
                  title={`Reactivate ${selected.full_name}?`}
                  confirmLabel="Confirm reactivate"
                  busy={acting}
                  onConfirm={() => void act("reactivate")}
                  onCancel={() => setConfirm(undefined)}
                >
                  They can sign in again. Earlier sessions, doctor shares and report links do not come back. This is recorded in the audit log.
                </Confirm>
              ) : selected.account_status === "active" ? (
                <button className="danger" onClick={() => { setDetailNotice(undefined); setConfirm("suspend"); }}>Suspend account</button>
              ) : selected.account_status === "suspended" ? (
                <button onClick={() => { setDetailNotice(undefined); setConfirm("reactivate"); }}>Reactivate account</button>
              ) : (
                <p className="muted">No admin action is available for a {label(selected.account_status)} account.</p>
              )}
              <p className="muted small">Account {short(selected.id)}…</p>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
