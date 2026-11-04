import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  adminApi,
  adminMessage,
  validateDecisionInput,
  validateSettingInput,
  type AdminDecision,
  type AdminMe,
  type AdminSession,
  type AdminSetting,
  type AdminSettingDetail,
  type AdminSettingStatus,
  type AdminSettingVersion,
} from "@health-wallet/api";
import { Callout, Chip, Confirm, Detail, Field, Message, Select, short, when, words, type Notice } from "./ui";

const statusTone = (s: AdminSettingStatus) => (s === "effective" ? "good" : s === "pending_approval" ? "warn" : s === "rejected" ? "bad" : "neutral");
const amount = (n: number, unit: string) => `${n.toLocaleString("en-US")} ${unit}`;
interface Pending { setting: AdminSettingDetail; version: AdminSettingVersion }

export function Settings({ client, admin }: { client: AdminSession; admin: AdminMe }) {
  const api = useMemo(() => adminApi(client), [client]);
  const canChange = admin.permissions.includes("admin.settings.change"),
    canApprove = admin.permissions.includes("admin.settings.approve");
  const [settings, setSettings] = useState<AdminSetting[]>([]),
    [pending, setPending] = useState<Pending[]>([]),
    [loading, setLoading] = useState(true),
    [listNotice, setListNotice] = useState<Notice>(),
    [detail, setDetail] = useState<AdminSettingDetail>(),
    [detailNotice, setDetailNotice] = useState<Notice>(),
    [value, setValue] = useState(""),
    [proposing, setProposing] = useState<number>(),
    [reviewing, setReviewing] = useState<number>(),
    [decision, setDecision] = useState<AdminDecision>("approved"),
    [reference, setReference] = useState(""),
    [deciding, setDeciding] = useState<AdminDecision>(),
    [acting, setActing] = useState(false);
  const request = useRef(0);

  const refresh = useCallback(async () => {
    const mine = ++request.current;
    setLoading(true);
    try {
      const list = (await api.settings()).settings;
      const details = await Promise.all(list.filter((s) => s.pending_versions > 0).map((s) => api.setting(s.key)));
      if (mine !== request.current) return;
      setSettings(list);
      setPending(details.flatMap((d) => d.setting.history.filter((v) => v.status === "pending_approval").map((version) => ({ setting: d.setting, version }))));
      setListNotice(undefined);
    } catch (error) {
      if (mine === request.current) setListNotice({ kind: "error", text: adminMessage(error) });
    } finally {
      if (mine === request.current) setLoading(false);
    }
  }, [api]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  function clearForms() {
    setValue("");
    setProposing(undefined);
    setReviewing(undefined);
    setReference("");
    setDecision("approved");
    setDeciding(undefined);
  }
  async function open(key: string, review?: number) {
    clearForms();
    setDetailNotice(undefined);
    setReviewing(review);
    try {
      setDetail((await api.setting(key)).setting);
    } catch (error) {
      setDetail(undefined);
      setDetailNotice({ kind: "error", text: adminMessage(error) });
    }
  }
  function review(e: FormEvent) {
    e.preventDefault();
    if (!detail) return;
    try {
      setProposing(validateSettingInput(detail, value));
      setDetailNotice(undefined);
    } catch (error) {
      setProposing(undefined);
      setDetailNotice({ kind: "error", text: adminMessage(error) });
    }
  }
  async function propose() {
    if (!detail || proposing === undefined || acting) return;
    setActing(true);
    try {
      const result = await api.proposeSetting(detail.key, proposing);
      clearForms();
      setDetail(result.setting);
      setDetailNotice({
        kind: "success",
        text:
          result.status === "pending_approval"
            ? `Version ${result.version} was saved and is waiting for approval by a different admin. The current value stays in effect until then.`
            : `Version ${result.version} was saved and is now in effect.`,
      });
      void refresh();
    } catch (error) {
      setProposing(undefined);
      setDetailNotice({ kind: "error", text: adminMessage(error) });
    } finally {
      setActing(false);
    }
  }
  function checkDecision(e: FormEvent) {
    e.preventDefault();
    try {
      validateDecisionInput(reference);
      setDeciding(decision);
      setDetailNotice(undefined);
    } catch (error) {
      setDeciding(undefined);
      setDetailNotice({ kind: "error", text: adminMessage(error) });
    }
  }
  async function decide() {
    if (!detail || reviewing === undefined || deciding === undefined || acting) return;
    setActing(true);
    try {
      const done = await api.decideSetting(detail.key, reviewing, deciding, validateDecisionInput(reference));
      const version = reviewing;
      clearForms();
      setDetail(done.setting);
      setDetailNotice({
        kind: "success",
        text: deciding === "approved" ? `Version ${version} was approved and is now in effect.` : `Version ${version} was rejected. The current value stays in effect.`,
      });
      void refresh();
    } catch (error) {
      setDeciding(undefined);
      setDetailNotice({ kind: "error", text: adminMessage(error) });
      // Show what the backend now holds (for example a decision made by someone else a moment ago).
      try {
        setDetail((await api.setting(detail.key)).setting);
      } catch {
        /* the error above is already shown */
      }
      void refresh();
    } finally {
      setActing(false);
    }
  }

  const target = detail && reviewing !== undefined ? detail.history.find((v) => v.version === reviewing && v.status === "pending_approval") : undefined;
  return (
    <div className="screen">
      <h1>Operational settings</h1>
      <p className="muted">
        Only these {settings.length || "listed"} settings can be changed here. Every change is saved as a new version and recorded in the audit log. Settings with a release gate wait for approval by a different admin.
      </p>
      <Message notice={listNotice} />
      <section aria-label="Pending approval">
        <div className="row spread">
          <h2>Pending approval</h2>
          <button type="button" className="secondary" onClick={() => void refresh()} disabled={loading}>Refresh</button>
        </div>
        {loading && settings.length === 0 ? (
          <p className="muted" role="status">Loading…</p>
        ) : pending.length === 0 ? (
          <p className="empty">Nothing is waiting for approval.</p>
        ) : (
          <table className="grid" aria-label="Changes waiting for approval">
            <thead>
              <tr><th scope="col">Setting</th><th scope="col">Version</th><th scope="col">Proposed value</th><th scope="col">Proposed by</th><th scope="col">Proposed</th><th scope="col">Gate</th><th scope="col"><span className="sr-only">Action</span></th></tr>
            </thead>
            <tbody>
              {pending.map((p) => (
                <tr key={p.setting.key + p.version.version}>
                  <td><code>{p.setting.key}</code></td>
                  <td>{p.version.version}</td>
                  <td>{amount(p.version.value, p.setting.unit)}</td>
                  <td>{p.version.proposed_by === admin.id ? "You" : <code>{short(p.version.proposed_by)}…</code>}</td>
                  <td>{when(p.version.proposed_at)}</td>
                  <td>{p.version.gate ?? "—"}</td>
                  <td>
                    <button className="secondary" onClick={() => void open(p.setting.key, p.version.version)} aria-label={`Review ${p.setting.key} version ${p.version.version}`}>
                      Review
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <h2>Settings</h2>
      <div className="split">
        <section aria-label="Setting list">
          <table className={"grid" + (loading ? " busy" : "")} aria-busy={loading}>
            <caption className="sr-only">Allowed settings</caption>
            <thead>
              <tr><th scope="col">Setting</th><th scope="col">Value in effect</th><th scope="col">Approval</th><th scope="col">Waiting</th></tr>
            </thead>
            <tbody>
              {settings.map((s) => (
                <tr key={s.key} className={detail?.key === s.key ? "selected" : ""}>
                  <td><button className="link" onClick={() => void open(s.key)} aria-label={`Open setting ${s.key}`}><code>{s.key}</code></button></td>
                  <td>{amount(s.value, s.unit)}{s.version === 0 && <span className="muted small"> (default)</span>}</td>
                  <td>{s.gate ? <Chip tone="warn">needs approval · {s.gate.cfg}</Chip> : <Chip tone="neutral">applies at once</Chip>}</td>
                  <td>{s.pending_versions}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <aside className="panel" aria-label="Setting detail">
          {!detail ? (
            <>
              <p className="muted">Select a setting to see its history and change it.</p>
              <Message notice={detailNotice} />
            </>
          ) : (
            <>
              <h2><code>{detail.key}</code></h2>
              <Detail rows={[
                ["In effect", amount(detail.value, detail.unit)],
                ["Version", detail.version === 0 ? "None yet (built-in default)" : String(detail.version)],
                ["Default", amount(detail.default, detail.unit)],
                ["Allowed range", `${detail.min.toLocaleString("en-US")} to ${detail.max.toLocaleString("en-US")} ${detail.unit}`],
                ["Source", detail.source],
                ["Release gate", detail.gate ? `${detail.gate.cfg}: ${detail.gate.requirement}` : "None. A change takes effect at once."],
              ]} />
              <Message notice={detailNotice} />
              {target ? (
                <section aria-label="Review a change">
                  <h3>Review version {target.version}</h3>
                  <p>
                    Proposed value: <b>{amount(target.value, detail.unit)}</b>, proposed {when(target.proposed_at)} by{" "}
                    {target.proposed_by === admin.id ? "you" : <code>{short(target.proposed_by)}…</code>}.
                  </p>
                  {!canApprove ? (
                    <p className="muted">Your admin role cannot approve or reject settings.</p>
                  ) : target.proposed_by === admin.id ? (
                    <p className="notice info" role="status">You proposed this change, so a different admin must approve it.</p>
                  ) : (
                    <form onSubmit={checkDecision} className="stack" aria-label="Decision form">
                      <Select label="Decision" value={decision} onChange={(d) => { setDecision(d || "approved"); setDeciding(undefined); }}
                        options={[{ value: "approved", label: "Approve" }, { value: "rejected", label: "Reject" }]} />
                      <Field label="Review reference" value={reference} onChange={(r) => { setReference(r); setDeciding(undefined); }}
                        hint="Where the review is recorded, for example a ticket or review number. Required for both decisions." />
                      <button disabled={acting}>Check decision</button>
                      {deciding && (
                        <Confirm
                          title={deciding === "approved" ? "Approve this change?" : "Reject this change?"}
                          confirmLabel={deciding === "approved" ? "Confirm approval" : "Confirm rejection"}
                          danger={deciding === "rejected"}
                          busy={acting}
                          onConfirm={() => void decide()}
                          onCancel={() => setDeciding(undefined)}
                        >
                          {deciding === "approved"
                            ? `Version ${target.version} becomes the value in effect. This is a second-person check only; it does not replace the security review named in the release gate. The decision and your reference are recorded and cannot be changed.`
                            : `Version ${target.version} will never take effect. The decision and your reference are recorded and cannot be changed.`}
                        </Confirm>
                      )}
                    </form>
                  )}
                </section>
              ) : canChange ? (
                <form onSubmit={review} className="stack" aria-label="Change form">
                  <h3>Change this setting</h3>
                  <Field label="New value" value={value} onChange={(v) => { setValue(v); setProposing(undefined); }}
                    hint={`Whole number from ${detail.min.toLocaleString("en-US")} to ${detail.max.toLocaleString("en-US")} ${detail.unit}.`} />
                  <button disabled={acting || value.trim() === ""}>Review change</button>
                  {proposing !== undefined && (
                    <Confirm title="Save this change?" confirmLabel="Confirm change" busy={acting} onConfirm={() => void propose()} onCancel={() => setProposing(undefined)}>
                      {`Set ${detail.key} to ${amount(proposing, detail.unit)}. `}
                      {detail.gate
                        ? `It will wait for approval by a different admin. The current value stays in effect until then. `
                        : `It takes effect at once. `}
                      This is recorded in the audit log.
                    </Confirm>
                  )}
                </form>
              ) : (
                <p className="muted">Your admin role cannot change settings.</p>
              )}
              <h3>Version history</h3>
              {detail.history.length === 0 ? (
                <p className="muted">No versions yet. The built-in default is in effect.</p>
              ) : (
                <table className="grid" aria-label="Version history">
                  <thead>
                    <tr><th scope="col">Version</th><th scope="col">Value</th><th scope="col">Status</th><th scope="col">Proposed</th><th scope="col">Decision</th></tr>
                  </thead>
                  <tbody>
                    {detail.history.map((v) => (
                      <tr key={v.version}>
                        <td>{v.version}</td>
                        <td>{v.value.toLocaleString("en-US")}</td>
                        <td><Chip tone={statusTone(v.status)}>{words(v.status)}</Chip></td>
                        <td>{when(v.proposed_at)}<br /><span className="muted small">by <code>{short(v.proposed_by)}…</code></span></td>
                        <td>
                          {v.decision ? (
                            <>
                              {v.decision.decision} {when(v.decision.decided_at)}
                              <br /><span className="muted small">by <code>{short(v.decision.decided_by)}…</code>, ref {v.decision.reference}</span>
                            </>
                          ) : v.requires_approval ? "Waiting" : "Not needed"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </aside>
      </div>
      <Callout title="What approval means here">
        Approval here is a second-person record inside the dashboard. It does not replace the security review named in a setting's release gate.
      </Callout>
    </div>
  );
}
