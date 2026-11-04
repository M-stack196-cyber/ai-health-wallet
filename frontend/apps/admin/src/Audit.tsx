import { useMemo, useState, type FormEvent } from "react";
import {
  adminApi,
  adminAuditOutcomes,
  adminUuid,
  type AdminAuditChain,
  type AdminAuditEvent,
  type AdminAuditOutcome,
  type AdminSession,
} from "@health-wallet/api";
import { Chip, Detail, Field, Message, Pager, Select, short, when, words } from "./ui";
import { useList } from "./useList";

type Filters = { actor: string; action: string; target: string; outcome: AdminAuditOutcome | ""; from: string; to: string };
const none: Filters = { actor: "", action: "", target: "", outcome: "", from: "", to: "" };
const tone = (o: AdminAuditOutcome) => (o === "success" ? "good" : o === "denied" ? "warn" : "bad");
/** The date boxes are in UTC. "2026-02-01T10:30" becomes "2026-02-01T10:30:00Z" for the backend. */
const instant = (v: string) => (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v) ? v + ":00Z" : undefined);

function problem(f: Filters): string | undefined {
  if (f.actor && !adminUuid.test(f.actor)) return "The admin ID must be a full ID, like 3f2c1a9e-….";
  if (f.action && !/^[a-z]+(\.[a-z_]+){1,3}$/.test(f.action)) return "The action must look like admin.patients.read (lower case, dots between parts).";
  if (f.target && !/^[a-z_]{1,40}$/.test(f.target)) return "The target type uses lower-case letters and underscores, for example patient_account.";
  if ((f.from && !instant(f.from)) || (f.to && !instant(f.to))) return "Enter the time as date and time (UTC).";
  if (f.from && f.to && Date.parse(instant(f.from)!) > Date.parse(instant(f.to)!)) return "“From” cannot be later than “To”.";
  return undefined;
}

export function Audit({ client }: { client: AdminSession }) {
  const api = useMemo(() => adminApi(client), [client]);
  const [chain, setChain] = useState<AdminAuditChain | null>(),
    [selected, setSelected] = useState<AdminAuditEvent>();
  const list = useList<Filters, AdminAuditEvent>(async (f, cursor) => {
    const page = await api.audit({
      actor_admin_id: f.actor || undefined,
      action: f.action || undefined,
      target_type: f.target || undefined,
      outcome: f.outcome || undefined,
      from: f.from ? instant(f.from) : undefined,
      to: f.to ? instant(f.to) : undefined,
      limit: 15,
      cursor,
    });
    // The whole-log check is sent with the first page only; later pages keep the last result.
    if (page.chain) setChain(page.chain);
    return page;
  }, none);

  function search(e: FormEvent) {
    e.preventDefault();
    const text = problem(list.draft);
    if (text) {
      list.setNotice({ kind: "error", text });
      return;
    }
    setSelected(undefined);
    list.apply({ ...list.draft, actor: list.draft.actor.trim(), action: list.draft.action.trim(), target: list.draft.target.trim() });
  }
  return (
    <div className="screen">
      <h1>Audit log</h1>
      <p className="muted">
        A read-only record of admin actions: who, what, on which kind of item, when and with what outcome. Medical content and secrets are never in it. Viewing the log is itself recorded.
      </p>
      <section aria-label="Audit chain check">
        {chain === undefined ? (
          <p className="muted" role="status">Checking the audit chain…</p>
        ) : chain === null ? (
          <p className="notice info" role="status">The chain check was not returned for this view. Go to page 1 to run it.</p>
        ) : chain.status === "intact" ? (
          <p className="chain intact" role="status">
            <strong>Audit chain: INTACT.</strong> All {chain.events_checked} events passed the check: no stored event has been changed since it was written.
          </p>
        ) : (
          <p className="chain broken" role="alert">
            <strong>Audit chain: BROKEN.</strong> The first event that fails the check is number {chain.first_invalid_seq} ({chain.events_checked} events checked). The log may have been altered. Tell the person responsible for security now and do not rely on the events from that number on.
          </p>
        )}
        <p className="muted small">The check runs over the whole log each time page 1 is loaded. It finds changed events; it cannot show that the very newest events were not removed by a database administrator.</p>
      </section>
      <h2>Events</h2>
      <form className="filters audit-filters" onSubmit={search} aria-label="Filter audit events">
        <Field label="Admin ID" value={list.draft.actor} onChange={(actor) => list.setDraft({ ...list.draft, actor })} hint="Optional, full ID" />
        <Field label="Action" value={list.draft.action} onChange={(action) => list.setDraft({ ...list.draft, action })} hint="Exact, like admin.patients.read" />
        <Field label="Target type" value={list.draft.target} onChange={(target) => list.setDraft({ ...list.draft, target })} hint="Exact, like patient_account" />
        <Select label="Outcome" value={list.draft.outcome} onChange={(outcome) => list.setDraft({ ...list.draft, outcome })}
          options={[{ value: "", label: "Any outcome" }, ...adminAuditOutcomes.map((o) => ({ value: o, label: o }))]} />
        <Field label="From (UTC)" type="datetime-local" value={list.draft.from} onChange={(from) => list.setDraft({ ...list.draft, from })} />
        <Field label="To (UTC)" type="datetime-local" value={list.draft.to} onChange={(to) => list.setDraft({ ...list.draft, to })} />
        <div className="row end">
          <button disabled={list.loading}>Apply filters</button>
          <button type="button" className="secondary" onClick={() => { setSelected(undefined); list.reset(); }}>Reset</button>
        </div>
      </form>
      <Message notice={list.notice} />
      <div className="split">
        <section aria-label="Event list">
          <table className={"grid" + (list.loading ? " busy" : "")} aria-busy={list.loading}>
            <caption className="sr-only">Audit events, newest first</caption>
            <thead>
              <tr><th scope="col">No.</th><th scope="col">Time</th><th scope="col">Action</th><th scope="col">Outcome</th><th scope="col">Admin</th></tr>
            </thead>
            <tbody>
              {list.rows.map((ev) => (
                <tr key={ev.seq} className={selected?.seq === ev.seq ? "selected" : ""}>
                  <td><button className="link" onClick={() => setSelected(ev)} aria-label={`Open event ${ev.seq}`}>{ev.seq}</button></td>
                  <td>{when(ev.occurred_at)}</td>
                  <td><code>{ev.action}</code></td>
                  <td><Chip tone={tone(ev.outcome)}>{ev.outcome}</Chip></td>
                  <td>{ev.actor_admin_id ? <code>{short(ev.actor_admin_id)}…</code> : "—"}{ev.actor_role && <span className="muted small"> {words(ev.actor_role)}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!list.loading && list.rows.length === 0 && !list.notice && <p className="empty">No events match.</p>}
          {list.loading && <p className="muted" role="status">Loading…</p>}
          <Pager page={list.page} hasNext={list.next !== null} busy={list.loading} onPrevious={list.previous} onNext={list.forward} />
        </section>
        <aside className="panel" aria-label="Event detail">
          {!selected ? (
            <p className="muted">Select an event to see its details.</p>
          ) : (
            <>
              <h2>Event {selected.seq}</h2>
              <Detail rows={[
                ["Time", when(selected.occurred_at)],
                ["Action", <code key="a">{selected.action}</code>],
                ["Outcome", <Chip key="o" tone={tone(selected.outcome)}>{selected.outcome}</Chip>],
                ["Admin", selected.actor_admin_id ? <code key="i">{selected.actor_admin_id}</code> : "—"],
                ["Role", selected.actor_role ? words(selected.actor_role) : "—"],
                ["Target type", selected.target_type],
                ["Target ID", selected.target_id ? <code key="t">{selected.target_id}</code> : "—"],
                ["Request ID", <code key="r">{selected.request_id}</code>],
                ["Fingerprint", <code key="h">{short(selected.event_hash)}…</code>],
              ]} />
              <h3>Scope</h3>
              <pre className="scope" aria-label="Event scope">{JSON.stringify(selected.scope, null, 2)}</pre>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
