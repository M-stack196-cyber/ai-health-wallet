import { useId, type ReactNode } from "react";

export function Field({
  label,
  value,
  onChange,
  type = "text",
  autoComplete = "off",
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  autoComplete?: string;
  hint?: string;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        value={value}
        type={type}
        autoComplete={autoComplete}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint && <small className="muted">{hint}</small>}
    </div>
  );
}

export function Select<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T | "";
  onChange: (value: T | "") => void;
  options: { value: T | ""; label: string }[];
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value as T | "")}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export type Notice = { kind: "success" | "error" | "info"; text: string };
/** Success and info use a polite live region; errors are announced at once. */
export function Message({ notice }: { notice?: Notice }) {
  if (!notice) return null;
  return (
    <p
      className={"notice " + notice.kind}
      role={notice.kind === "error" ? "alert" : "status"}
    >
      {notice.text}
    </p>
  );
}

export function Chip({ tone, children }: { tone: string; children: ReactNode }) {
  return <span className={"chip " + tone}>{children}</span>;
}

export function Pager({
  page,
  hasNext,
  busy,
  onPrevious,
  onNext,
}: {
  page: number;
  hasNext: boolean;
  busy: boolean;
  onPrevious: () => void;
  onNext: () => void;
}) {
  return (
    <nav className="pager" aria-label="Pages">
      <button
        type="button"
        className="secondary"
        disabled={busy || page === 1}
        onClick={onPrevious}
      >
        ← Previous
      </button>
      <span aria-live="polite">Page {page}</span>
      <button
        type="button"
        className="secondary"
        disabled={busy || !hasNext}
        onClick={onNext}
      >
        Next →
      </button>
    </nav>
  );
}

/** Two-step confirmation for actions that change data. Nothing is sent until "Confirm" is pressed. */
export function Confirm({
  title,
  children,
  confirmLabel,
  busy,
  danger,
  onConfirm,
  onCancel,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  busy: boolean;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="confirm" role="group" aria-label="Confirm action">
      <h4>{title}</h4>
      <p>{children}</p>
      <div className="row">
        <button
          type="button"
          className={danger ? "danger" : ""}
          disabled={busy}
          onClick={onConfirm}
        >
          {confirmLabel}
        </button>
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Fixed UTC format, so the screen reads the same on every laptop. */
export function when(iso: string | null | undefined) {
  if (!iso) return "—";
  const t = Date.parse(iso);
  return Number.isFinite(t)
    ? new Date(t).toISOString().slice(0, 16).replace("T", " ") + " UTC"
    : "—";
}
export const short = (id: string) => id.slice(0, 8);
export function Detail({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="detail">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** "retry_wait" -> "retry wait". */
export const words = (s: string) => s.replace(/_/g, " ").toLowerCase();
export const idProblem = "The patient ID must be a full ID, like 3f2c1a9e-….";

/** A strong, always-visible statement, for messages the admin must not miss. */
export function Callout({ tone = "info", title, children }: { tone?: "info" | "warn"; title: string; children: ReactNode }) {
  return (
    <div className={"callout " + tone} role="note" aria-label={title}>
      <strong>{title}</strong>
      <p>{children}</p>
    </div>
  );
}

/** Count tiles. Zero is shown as 0, never hidden. */
export function Counts({ items, label }: { items: { name: string; count: number; alert?: boolean }[]; label: string }) {
  return (
    <ul className="cards" aria-label={label}>
      {items.map((i) => (
        <li key={i.name} className={i.alert ? "alert-card" : ""}>
          <b>{i.count}</b>
          <span>{i.name}</span>
        </li>
      ))}
    </ul>
  );
}
