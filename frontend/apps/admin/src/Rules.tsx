import { useMemo, useState, type FormEvent } from "react";
import {
  adminApi,
  adminMessage,
  adminRuleIdPattern,
  adminRuleOperators,
  validateRuleForm,
  type AdminMe,
  type AdminRule,
  type AdminRuleForm,
  type AdminRuleInput,
  type AdminRuleOperator,
  type AdminSession,
} from "@health-wallet/api";
import { Callout, Chip, Confirm, Detail, Field, Message, Pager, Select, short, when, words, type Notice } from "./ui";
import { useList } from "./useList";

const operatorText: Record<AdminRuleOperator, string> = {
  gt: "is greater than",
  gte: "is greater than or equal to",
  lt: "is less than",
  lte: "is less than or equal to",
  between: "is between (inclusive)",
  outside: "is outside",
};
const emptyForm: AdminRuleForm = { ruleId: "", field: "", units: "", operator: "", bounds: ["", ""], context: [{ key: "", value: "" }] };
const approvalText = (a: string) => (a === "not_clinically_approved" ? "not clinically approved" : words(a));
const describe = (r: AdminRule["definition"]) =>
  `${r.field} ${operatorText[r.operator] ?? r.operator} ${r.bounds.join(r.operator === "outside" ? " to " : " and ")} ${r.units}`;

export function Rules({ client, admin }: { client: AdminSession; admin: AdminMe }) {
  const api = useMemo(() => adminApi(client), [client]);
  const canCreate = admin.permissions.includes("admin.rules.create");
  const list = useList<{ rule: string }, AdminRule>((f, cursor) => api.rules({ rule_id: f.rule || undefined, limit: 10, cursor }), { rule: "" });
  const [selected, setSelected] = useState<AdminRule>(),
    [detailNotice, setDetailNotice] = useState<Notice>(),
    [form, setForm] = useState<AdminRuleForm>(emptyForm),
    [formNotice, setFormNotice] = useState<Notice>(),
    [pending, setPending] = useState<AdminRuleInput>(),
    [saving, setSaving] = useState(false);

  function search(e: FormEvent) {
    e.preventDefault();
    const rule = list.draft.rule.trim();
    if (rule && !adminRuleIdPattern.test(rule)) {
      list.setNotice({ kind: "error", text: "A rule ID uses capital letters, numbers and underscores, for example LAB_GLUCOSE_HIGH." });
      return;
    }
    setSelected(undefined);
    list.apply({ rule });
  }
  async function choose(row: AdminRule) {
    setDetailNotice(undefined);
    setSelected(row);
    try {
      setSelected((await api.rule(row.id)).rule);
    } catch (error) {
      setDetailNotice({ kind: "error", text: adminMessage(error) });
    }
  }
  const edit = (change: Partial<AdminRuleForm>) => {
    setForm((f) => ({ ...f, ...change }));
    setPending(undefined);
    setFormNotice(undefined);
  };
  function check(e: FormEvent) {
    e.preventDefault();
    try {
      setPending(validateRuleForm(form));
      setFormNotice(undefined);
    } catch (error) {
      setPending(undefined);
      setFormNotice({ kind: "error", text: adminMessage(error) });
    }
  }
  async function save() {
    if (!pending || saving) return;
    setSaving(true);
    try {
      const { rule } = await api.createRule(pending);
      setForm(emptyForm);
      setPending(undefined);
      setSelected(rule);
      setFormNotice({ kind: "success", text: `Saved as version ${rule.version} of ${rule.rule_id}. It is recorded as not clinically approved.` });
      list.reset();
    } catch (error) {
      setPending(undefined);
      setFormNotice({ kind: "error", text: adminMessage(error) });
    } finally {
      setSaving(false);
    }
  }
  const two = form.operator === "between" || form.operator === "outside";

  return (
    <div className="screen">
      <h1>Serious-finding rules</h1>
      <Callout tone="warn" title="Admin editing is NOT clinical approval">
        A rule saved here is stored as “not clinically approved”. Saving, viewing or re-saving it never changes that. The approval cannot be set or edited from this dashboard, and no field for it is offered. A rule can be used for real patients only after the clinical approval required by CFG-06, given outside this dashboard.
      </Callout>
      <h2>Rule versions</h2>
      <form className="filters" onSubmit={search} aria-label="Filter rules">
        <Field label="Rule ID" value={list.draft.rule} onChange={(rule) => list.setDraft({ rule })} hint="Optional, exact ID" />
        <span /><span />
        <div className="row end">
          <button disabled={list.loading}>Apply filter</button>
          <button type="button" className="secondary" onClick={() => { setSelected(undefined); list.reset(); }}>Reset</button>
        </div>
      </form>
      <Message notice={list.notice} />
      <div className="split">
        <section aria-label="Rule list">
          <table className={"grid" + (list.loading ? " busy" : "")} aria-busy={list.loading}>
            <caption className="sr-only">Rule versions</caption>
            <thead>
              <tr><th scope="col">Rule</th><th scope="col">Version</th><th scope="col">Clinical approval</th><th scope="col">Saved</th></tr>
            </thead>
            <tbody>
              {list.rows.map((r) => (
                <tr key={r.id} className={selected?.id === r.id ? "selected" : ""}>
                  <td><button className="link" onClick={() => void choose(r)} aria-label={`Open ${r.rule_id} version ${r.version}`}><code>{r.rule_id}</code></button></td>
                  <td>{r.version}</td>
                  <td><Chip tone="warn">{approvalText(r.clinical_approval)}</Chip></td>
                  <td>{when(r.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!list.loading && list.rows.length === 0 && !list.notice && <p className="empty">No rule versions yet.</p>}
          {list.loading && <p className="muted" role="status">Loading…</p>}
          <Pager page={list.page} hasNext={list.next !== null} busy={list.loading} onPrevious={list.previous} onNext={list.forward} />
        </section>
        <aside className="panel" aria-label="Rule detail">
          {!selected ? (
            <p className="muted">Select a rule version to see its definition.</p>
          ) : (
            <>
              <h2><code>{selected.rule_id}</code> v{selected.version}</h2>
              <Detail rows={[
                ["Clinical approval", <Chip key="a" tone="warn">{approvalText(selected.clinical_approval)}</Chip>],
                ["Meaning", describe(selected.definition)],
                ["Field", selected.definition.field],
                ["Units", selected.definition.units],
                ["Comparison", operatorText[selected.definition.operator] ?? selected.definition.operator],
                ["Bounds", selected.definition.bounds.join(", ")],
                ["Context", Object.keys(selected.definition.context).length ? Object.entries(selected.definition.context).map(([k, v]) => `${k}: ${v}`).join("; ") : "None"],
                ["Saved", when(selected.created_at)],
                ["Saved by", <code key="c">{short(selected.created_by)}…</code>],
                ["Fingerprint", <code key="h">{short(selected.definition_sha256)}…</code>],
              ]} />
              <Message notice={detailNotice} />
              <p className="muted small">Versions cannot be edited or deleted. To change a rule, save a new version.</p>
            </>
          )}
        </aside>
      </div>
      <h2>Save a new version</h2>
      <Message notice={formNotice} />
      {!canCreate ? (
        <p className="muted">Your admin role cannot create rule versions.</p>
      ) : (
        <form className="panel flat" onSubmit={check} aria-label="New rule version">
          <div className="form-grid">
            <Field label="Rule ID" value={form.ruleId} onChange={(ruleId) => edit({ ruleId })} hint="Capital letters, numbers, underscores. A new version is added if the ID exists." />
            <Field label="Field" value={form.field} onChange={(field) => edit({ field })} hint="What is measured, for example glucose" />
            <Field label="Units" value={form.units} onChange={(units) => edit({ units })} hint="For example mg/dL" />
            <Select label="Comparison" value={form.operator} onChange={(operator) => edit({ operator })}
              options={[{ value: "", label: "Choose…" }, ...adminRuleOperators.map((o) => ({ value: o, label: operatorText[o] }))]} />
            <Field label={two ? "Lower bound" : "Bound"} value={form.bounds[0]} onChange={(b) => edit({ bounds: [b, form.bounds[1]] })} />
            {two && <Field label="Upper bound" value={form.bounds[1]} onChange={(b) => edit({ bounds: [form.bounds[0], b] })} />}
          </div>
          <fieldset className="context">
            <legend>Context (optional, up to 5)</legend>
            {form.context.map((row, i) => (
              <div className="row" key={i}>
                <Field label={`Context name ${i + 1}`} value={row.key} onChange={(key) => edit({ context: form.context.map((r, j) => (j === i ? { ...r, key } : r)) })} />
                <Field label={`Context value ${i + 1}`} value={row.value} onChange={(value) => edit({ context: form.context.map((r, j) => (j === i ? { ...r, value } : r)) })} />
                <button type="button" className="secondary" onClick={() => edit({ context: form.context.filter((_, j) => j !== i) })} aria-label={`Remove context ${i + 1}`}>Remove</button>
              </div>
            ))}
            {form.context.length < 5 && (
              <button type="button" className="secondary" onClick={() => edit({ context: [...form.context, { key: "", value: "" }] })}>Add context</button>
            )}
          </fieldset>
          <div className="field">
            <label htmlFor="rule-approval">Clinical approval</label>
            <input id="rule-approval" value="Not clinically approved" disabled readOnly aria-describedby="rule-approval-hint" />
            <small id="rule-approval-hint" className="muted">Fixed by the system. It cannot be set from this dashboard.</small>
          </div>
          <button disabled={saving}>Review rule</button>
          {pending && (
            <Confirm title="Save this rule version?" confirmLabel="Confirm save" busy={saving} onConfirm={() => void save()} onCancel={() => setPending(undefined)}>
              {`${pending.rule_id}: ${describe(pending.definition)}. It is saved as a new version, recorded as not clinically approved, and cannot be edited or deleted afterwards. This is recorded in the audit log.`}
            </Confirm>
          )}
        </form>
      )}
    </div>
  );
}
