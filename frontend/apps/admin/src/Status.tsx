import { useMemo, useState, type FormEvent } from "react";
import {
  adminApi,
  adminDeliveryChannels,
  adminDeliveryStates,
  adminEmailPurposes,
  adminGuardianStatuses,
  adminMessage,
  adminShareMethods,
  adminShareStatuses,
  adminUuid,
  type AdminDelivery,
  type AdminDeliveryChannel,
  type AdminDeliveryState,
  type AdminEmailPurpose,
  type AdminGuardian,
  type AdminGuardianStatus,
  type AdminSession,
  type AdminShare,
  type AdminShareMethod,
  type AdminShareStatus,
} from "@health-wallet/api";
import { Chip, Counts, Detail, Field, Message, Pager, Select, idProblem, short, when, words, type Notice } from "./ui";
import { useList, useLoaded } from "./useList";

const cleanId = (value: string, fail: (n: Notice) => void) => {
  const v = value.trim();
  if (v && !adminUuid.test(v)) {
    fail({ kind: "error", text: idProblem });
    return undefined;
  }
  return v;
};
const guardianTone = (s: AdminGuardianStatus) => (s === "ACTIVE" ? "good" : s === "PENDING" ? "warn" : s === "REVOKED" ? "bad" : "neutral");
const shareTone = (s: AdminShareStatus) => (s === "active" ? "good" : s === "revoked" ? "bad" : "neutral");
const deliveryTone = (s: AdminDeliveryState) =>
  s === "delivered" ? "good" : s === "permanent_failed" ? "bad" : s === "transient_failed" || s === "retry_wait" ? "warn" : "neutral";

/* ---------- Guardian relationships ---------- */
type GuardianFilters = { status: AdminGuardianStatus | ""; patient: string };
const noGuardian: GuardianFilters = { status: "", patient: "" };

export function Guardians({ client }: { client: AdminSession }) {
  const api = useMemo(() => adminApi(client), [client]);
  const summary = useLoaded(async () => (await api.guardianSummary()).summary);
  const list = useList<GuardianFilters, AdminGuardian>(
    (f, cursor) => api.guardians({ status: f.status || undefined, patient_id: f.patient || undefined, limit: 10, cursor }),
    noGuardian,
  );
  const [selected, setSelected] = useState<AdminGuardian>(),
    [detailNotice, setDetailNotice] = useState<Notice>();
  function search(e: FormEvent) {
    e.preventDefault();
    const patient = cleanId(list.draft.patient, list.setNotice);
    if (patient === undefined) return;
    setSelected(undefined);
    setDetailNotice(undefined);
    list.apply({ ...list.draft, patient });
  }
  async function choose(row: AdminGuardian) {
    setDetailNotice(undefined);
    setSelected(row);
    try {
      setSelected((await api.guardian(row.id)).guardian);
    } catch (error) {
      setDetailNotice({ kind: "error", text: adminMessage(error) });
    }
  }
  const s = summary.value;
  return (
    <div className="screen">
      <h1>Guardian relationships</h1>
      <p className="muted">
        Status and dates only. Guardian email addresses, invitation links and notification text are never shown.
      </p>
      <section aria-label="Guardian summary">
        <div className="row spread">
          <h2>Summary</h2>
          <button type="button" className="secondary" onClick={() => void summary.refresh()}>Refresh counts</button>
        </div>
        <Message notice={summary.notice} />
        {s && (
          <Counts
            label="Guardian counts"
            items={[{ name: "All relationships", count: s.total }, ...adminGuardianStatuses.map((k) => ({ name: words(k), count: s.by_status[k] }))]}
          />
        )}
      </section>
      <h2>Relationships</h2>
      <form className="filters" onSubmit={search} aria-label="Filter relationships">
        <Select label="Status" value={list.draft.status} onChange={(status) => list.setDraft({ ...list.draft, status })}
          options={[{ value: "", label: "Any status" }, ...adminGuardianStatuses.map((k) => ({ value: k, label: words(k) }))]} />
        <Field label="Patient ID" value={list.draft.patient} onChange={(patient) => list.setDraft({ ...list.draft, patient })} hint="Optional, full ID" />
        <span />
        <div className="row end">
          <button disabled={list.loading}>Apply filters</button>
          <button type="button" className="secondary" onClick={() => { setSelected(undefined); list.reset(); }}>Reset</button>
        </div>
      </form>
      <Message notice={list.notice} />
      <div className="split">
        <section aria-label="Relationship list">
          <table className={"grid" + (list.loading ? " busy" : "")} aria-busy={list.loading}>
            <caption className="sr-only">Guardian relationships</caption>
            <thead>
              <tr><th scope="col">Relationship</th><th scope="col">Patient</th><th scope="col">Status</th><th scope="col">Created</th></tr>
            </thead>
            <tbody>
              {list.rows.map((g) => (
                <tr key={g.id} className={selected?.id === g.id ? "selected" : ""}>
                  <td><button className="link" onClick={() => void choose(g)} aria-label={`Open relationship ${short(g.id)}`}><code>{short(g.id)}…</code></button></td>
                  <td><code>{short(g.patient_id)}…</code></td>
                  <td><Chip tone={guardianTone(g.status)}>{words(g.status)}</Chip></td>
                  <td>{when(g.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!list.loading && list.rows.length === 0 && !list.notice && <p className="empty">No relationships match.</p>}
          {list.loading && <p className="muted" role="status">Loading…</p>}
          <Pager page={list.page} hasNext={list.next !== null} busy={list.loading} onPrevious={list.previous} onNext={list.forward} />
        </section>
        <aside className="panel" aria-label="Relationship detail">
          {!selected ? (
            <p className="muted">Select a relationship to see its details.</p>
          ) : (
            <>
              <h2>Relationship <code>{short(selected.id)}…</code></h2>
              <Detail rows={[
                ["Status", <Chip key="s" tone={guardianTone(selected.status)}>{words(selected.status)}</Chip>],
                ["Accepted", when(selected.accepted_at)],
                ["Revoked", when(selected.revoked_at)],
                ["Created", when(selected.created_at)],
                ["Updated", when(selected.updated_at)],
                ["Relationship ID", <code key="i">{selected.id}</code>],
                ["Patient ID", <code key="p">{selected.patient_id}</code>],
              ]} />
              <Message notice={detailNotice} />
              <h3>History</h3>
              {selected.events === undefined ? (
                <p className="muted">Loading…</p>
              ) : selected.events.length === 0 ? (
                <p className="muted">No events recorded.</p>
              ) : (
                <table className="grid" aria-label="Relationship history">
                  <thead><tr><th scope="col">Event</th><th scope="col">When</th></tr></thead>
                  <tbody>{selected.events.map((e, i) => <tr key={i}><td>{words(e.event)}</td><td>{when(e.occurred_at)}</td></tr>)}</tbody>
                </table>
              )}
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

/* ---------- Doctor share grants ---------- */
type ShareFilters = { status: AdminShareStatus | ""; method: AdminShareMethod | ""; patient: string };
const noShare: ShareFilters = { status: "", method: "", patient: "" };

export function Shares({ client }: { client: AdminSession }) {
  const api = useMemo(() => adminApi(client), [client]);
  const summary = useLoaded(async () => (await api.shareSummary()).summary);
  const list = useList<ShareFilters, AdminShare>(
    (f, cursor) => api.shares({ status: f.status || undefined, method: f.method || undefined, patient_id: f.patient || undefined, limit: 10, cursor }),
    noShare,
  );
  const [selected, setSelected] = useState<AdminShare>(),
    [detailNotice, setDetailNotice] = useState<Notice>();
  function search(e: FormEvent) {
    e.preventDefault();
    const patient = cleanId(list.draft.patient, list.setNotice);
    if (patient === undefined) return;
    setSelected(undefined);
    setDetailNotice(undefined);
    list.apply({ ...list.draft, patient });
  }
  async function choose(row: AdminShare) {
    setDetailNotice(undefined);
    setSelected(row);
    try {
      setSelected((await api.share(row.id)).share);
    } catch (error) {
      setDetailNotice({ kind: "error", text: adminMessage(error) });
    }
  }
  const s = summary.value;
  return (
    <div className="screen">
      <h1>Doctor share grants</h1>
      <p className="muted">
        Whether a grant is active, expired or revoked, and how it was shared. Share links, QR codes, one-time codes, doctor emails and record names are never shown. Admins cannot open or extend a grant.
      </p>
      <section aria-label="Share summary">
        <div className="row spread">
          <h2>Summary</h2>
          <button type="button" className="secondary" onClick={() => void summary.refresh()}>Refresh counts</button>
        </div>
        <Message notice={summary.notice} />
        {s && (
          <>
            <Counts label="Grant counts" items={[{ name: "All grants", count: s.total }, ...adminShareStatuses.map((k) => ({ name: k, count: s.by_status[k] }))]} />
            <p className="muted small" aria-label="Grants by method">
              By method: {adminShareMethods.map((m) => `${words(m)} ${s.by_method[m]}`).join(" · ")}
            </p>
          </>
        )}
      </section>
      <h2>Grants</h2>
      <form className="filters" onSubmit={search} aria-label="Filter grants">
        <Select label="Status" value={list.draft.status} onChange={(status) => list.setDraft({ ...list.draft, status })}
          options={[{ value: "", label: "Any status" }, ...adminShareStatuses.map((k) => ({ value: k, label: k }))]} />
        <Select label="Method" value={list.draft.method} onChange={(method) => list.setDraft({ ...list.draft, method })}
          options={[{ value: "", label: "Any method" }, ...adminShareMethods.map((k) => ({ value: k, label: words(k) }))]} />
        <Field label="Patient ID" value={list.draft.patient} onChange={(patient) => list.setDraft({ ...list.draft, patient })} hint="Optional, full ID" />
        <div className="row end">
          <button disabled={list.loading}>Apply filters</button>
          <button type="button" className="secondary" onClick={() => { setSelected(undefined); list.reset(); }}>Reset</button>
        </div>
      </form>
      <Message notice={list.notice} />
      <div className="split">
        <section aria-label="Grant list">
          <table className={"grid" + (list.loading ? " busy" : "")} aria-busy={list.loading}>
            <caption className="sr-only">Doctor share grants</caption>
            <thead>
              <tr><th scope="col">Grant</th><th scope="col">Method</th><th scope="col">Status</th><th scope="col">Open sessions</th><th scope="col">Expires</th></tr>
            </thead>
            <tbody>
              {list.rows.map((g) => (
                <tr key={g.id} className={selected?.id === g.id ? "selected" : ""}>
                  <td><button className="link" onClick={() => void choose(g)} aria-label={`Open grant ${short(g.id)}`}><code>{short(g.id)}…</code></button></td>
                  <td>{words(g.sharing_method)}</td>
                  <td><Chip tone={shareTone(g.status)}>{g.status}</Chip></td>
                  <td>{g.active_session_count}</td>
                  <td>{when(g.expires_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!list.loading && list.rows.length === 0 && !list.notice && <p className="empty">No grants match.</p>}
          {list.loading && <p className="muted" role="status">Loading…</p>}
          <Pager page={list.page} hasNext={list.next !== null} busy={list.loading} onPrevious={list.previous} onNext={list.forward} />
        </section>
        <aside className="panel" aria-label="Grant detail">
          {!selected ? (
            <p className="muted">Select a grant to see its details.</p>
          ) : (
            <>
              <h2>Grant <code>{short(selected.id)}…</code></h2>
              <Detail rows={[
                ["Status", <Chip key="s" tone={shareTone(selected.status)}>{selected.status}</Chip>],
                ["Method", words(selected.sharing_method)],
                ["Bound to one doctor", selected.recipient_bound ? "Yes" : "No"],
                ["Open doctor sessions", String(selected.active_session_count)],
                ["Created", when(selected.created_at)],
                ["Expires", when(selected.expires_at)],
                ["Revoked", when(selected.revoked_at)],
                ["Last activity", selected.last_event_at === undefined ? "Loading…" : when(selected.last_event_at)],
                ["Grant ID", <code key="i">{selected.id}</code>],
                ["Patient ID", <code key="p">{selected.patient_id}</code>],
              ]} />
              <Message notice={detailNotice} />
              <h3>Activity counts</h3>
              {selected.event_counts === undefined ? (
                <p className="muted">Loading…</p>
              ) : Object.keys(selected.event_counts).length === 0 ? (
                <p className="muted">No activity recorded.</p>
              ) : (
                <ul aria-label="Grant activity">
                  {Object.entries(selected.event_counts).map(([name, n]) => <li key={name}>{words(name)}: {n}</li>)}
                </ul>
              )}
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

/* ---------- Email and notification deliveries ---------- */
type DeliveryFilters = { channel: AdminDeliveryChannel | ""; state: AdminDeliveryState | ""; purpose: AdminEmailPurpose | ""; patient: string };
const noDelivery: DeliveryFilters = { channel: "", state: "", purpose: "", patient: "" };
const channelName: Record<AdminDeliveryChannel, string> = { security_email: "Security emails", guardian_notification: "Guardian notifications" };

export function Deliveries({ client }: { client: AdminSession }) {
  const api = useMemo(() => adminApi(client), [client]);
  const summary = useLoaded(async () => (await api.deliverySummary()).summary);
  const list = useList<DeliveryFilters, AdminDelivery>(
    (f, cursor) => api.deliveries({ channel: f.channel || undefined, state: f.state || undefined, purpose: f.purpose || undefined, patient_id: f.patient || undefined, limit: 10, cursor }),
    noDelivery,
  );
  function search(e: FormEvent) {
    e.preventDefault();
    const patient = cleanId(list.draft.patient, list.setNotice);
    if (patient === undefined) return;
    list.apply({ ...list.draft, patient });
  }
  const s = summary.value;
  return (
    <div className="screen">
      <h1>Email and notification delivery</h1>
      <p className="muted">
        Whether messages were sent, are waiting or failed. Addresses, message text, codes and links are never shown. The backend offers no single-delivery view, so every available field is in the table.
      </p>
      <section aria-label="Delivery summary">
        <div className="row spread">
          <h2>Summary</h2>
          <button type="button" className="secondary" onClick={() => void summary.refresh()}>Refresh counts</button>
        </div>
        <Message notice={summary.notice} />
        {s && (
          <>
            <p className="muted small">All deliveries: {s.total}</p>
            {adminDeliveryChannels.map((c) => (
              <section key={c} aria-label={channelName[c]}>
                <h3>{channelName[c]}</h3>
                <Counts
                  label={channelName[c] + " counts"}
                  items={adminDeliveryStates.map((k) => ({ name: words(k), count: s.by_channel[c][k], alert: k === "permanent_failed" && s.by_channel[c][k] > 0 }))}
                />
              </section>
            ))}
          </>
        )}
      </section>
      <h2>Deliveries</h2>
      <form className="filters" onSubmit={search} aria-label="Filter deliveries">
        <Select label="Channel" value={list.draft.channel} onChange={(channel) => list.setDraft({ ...list.draft, channel })}
          options={[{ value: "", label: "Any channel" }, ...adminDeliveryChannels.map((k) => ({ value: k, label: channelName[k] }))]} />
        <Select label="State" value={list.draft.state} onChange={(state) => list.setDraft({ ...list.draft, state })}
          options={[{ value: "", label: "Any state" }, ...adminDeliveryStates.map((k) => ({ value: k, label: words(k) }))]} />
        <Select label="Email purpose" value={list.draft.purpose} onChange={(purpose) => list.setDraft({ ...list.draft, purpose })}
          options={[{ value: "", label: "Any purpose" }, ...adminEmailPurposes.map((k) => ({ value: k, label: words(k) }))]} />
        <Field label="Patient ID" value={list.draft.patient} onChange={(patient) => list.setDraft({ ...list.draft, patient })} hint="Optional, full ID" />
        <div className="row end">
          <button disabled={list.loading}>Apply filters</button>
          <button type="button" className="secondary" onClick={list.reset}>Reset</button>
        </div>
      </form>
      <Message notice={list.notice} />
      <section aria-label="Delivery list">
        <table className={"grid" + (list.loading ? " busy" : "")} aria-busy={list.loading}>
          <caption className="sr-only">Deliveries</caption>
          <thead>
            <tr>
              <th scope="col">Delivery</th><th scope="col">Channel</th><th scope="col">Purpose</th><th scope="col">State</th>
              <th scope="col">Attempts</th><th scope="col">Failure reason</th><th scope="col">Created</th><th scope="col">Delivered</th>
            </tr>
          </thead>
          <tbody>
            {list.rows.map((d) => (
              <tr key={d.channel + d.id}>
                <td><code>{short(d.id)}…</code></td>
                <td>{channelName[d.channel] ?? words(d.channel)}</td>
                <td>{d.purpose ? words(d.purpose) : "—"}</td>
                <td><Chip tone={deliveryTone(d.state)}>{words(d.state)}</Chip></td>
                <td>{d.max_attempts === null ? d.attempts : `${d.attempts} of ${d.max_attempts}`}</td>
                <td>{d.failure_reason ? words(d.failure_reason) : "—"}</td>
                <td>{when(d.created_at)}</td>
                <td>{when(d.delivered_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!list.loading && list.rows.length === 0 && !list.notice && <p className="empty">No deliveries match.</p>}
        {list.loading && <p className="muted" role="status">Loading…</p>}
        <Pager page={list.page} hasNext={list.next !== null} busy={list.loading} onPrevious={list.previous} onNext={list.forward} />
      </section>
    </div>
  );
}
