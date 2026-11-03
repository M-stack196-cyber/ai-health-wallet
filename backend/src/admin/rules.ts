import type { PatientDatabase } from "../patients/repository.js";
import { transaction } from "../auth/security-repository.js";
import { ApiError } from "../http/errors.js";
import { writeAdminAudit, type AdminContext } from "./repository.js";
import { cursorTime, decodeCursor, encodeCursor, invalid, oneOf, parseListQuery, uuid } from "./paging.js";

const operators = ["gt", "gte", "lt", "lte", "between", "outside"] as const;
/** Any field that looks like a clinical sign-off is refused outright and audited as an attempt; editing is never approval (CFG-06). */
const approvalLike = /approv|clinical|validat|verif|review|status|sign|certif|qualif/i;
export const clinicalApprovalForbidden = () => new ApiError(403, "CLINICAL_APPROVAL_FORBIDDEN", "Clinical approval cannot be set from the Admin Dashboard.");

export interface RuleInput { ruleId: string; definition: { field: string; units: string; operator: (typeof operators)[number]; bounds: number[]; context: Record<string, string> }; }
const bad = () => new ApiError(400, "INVALID_INPUT", "Request fields are missing, invalid or not permitted.");
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

/** Returns the parsed rule, or throws: 403 when any field looks like a clinical approval, 400 for anything else that is not allowed. */
export function validateRuleInput(body: unknown): RuleInput {
  if (!plain(body)) throw bad();
  if (Object.keys(body).some(key => approvalLike.test(key))) throw clinicalApprovalForbidden();
  if (Object.keys(body).sort().join(",") !== "definition,rule_id" || typeof body.rule_id !== "string" || !/^[A-Z][A-Z0-9_]{2,79}$/.test(body.rule_id) || !plain(body.definition)) throw bad();
  const d = body.definition;
  if (Object.keys(d).some(key => approvalLike.test(key))) throw clinicalApprovalForbidden();
  if (Object.keys(d).sort().join(",") !== "bounds,context,field,operator,units") throw bad();
  if (typeof d.field !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_ ./-]{0,79}$/.test(d.field) || typeof d.units !== "string" || !/^[A-Za-z0-9_%/.^-]{1,30}$/.test(d.units)
    || !operators.includes(d.operator as never) || !Array.isArray(d.bounds) || !plain(d.context)) throw bad();
  const bounds = d.bounds as unknown[], two = d.operator === "between" || d.operator === "outside";
  if (bounds.length !== (two ? 2 : 1) || bounds.some(n => typeof n !== "number" || !Number.isFinite(n) || Math.abs(n) > 1000000) || (two && (bounds[0] as number) > (bounds[1] as number))) throw bad();
  const entries = Object.entries(d.context);
  if (entries.length > 5 || entries.some(([k, v]) => !/^[A-Za-z0-9_ ./-]{1,60}$/.test(k) || typeof v !== "string" || !/^[A-Za-z0-9_ ./-]{1,60}$/.test(v))) throw bad();
  return { ruleId: body.rule_id, definition: { field: d.field, units: d.units, operator: d.operator as (typeof operators)[number], bounds: bounds as number[], context: d.context as Record<string, string> } };
}

export const ruleListQuery = (query: Record<string, unknown>) => parseListQuery(query, { rule_id: (value: string) => { if (!/^[A-Z][A-Z0-9_]{2,79}$/.test(value)) throw invalid(); return value; } });
export function ruleIdParameter(value: unknown): string {
  if (typeof value !== "string" || !uuid.test(value)) throw invalid();
  return value.toLowerCase();
}
void oneOf;

const columns = `id,rule_id,version,definition,definition_sha256,clinical_approval,created_by,created_at`;
export function createAdminRules(db: PatientDatabase) {
  return {
    async list(parsed: { filters: Record<string, string | undefined>; limit: number; cursor?: { createdAt: string; id: string } }) {
      const values: unknown[] = [], where: string[] = [], add = (value: unknown) => { values.push(value); return "$" + values.length; };
      if (parsed.filters.rule_id) where.push("rule_id=" + add(parsed.filters.rule_id));
      if (parsed.cursor) where.push(`(created_at,id)<(${add(parsed.cursor.createdAt)}::timestamptz,${add(parsed.cursor.id)}::uuid)`);
      const rows = (await db.query<{ id: string; cursor_at: string }>(`SELECT ${columns},${cursorTime("created_at")} AS cursor_at FROM public.admin_serious_rule_versions ${where.length ? "WHERE " + where.join(" AND ") : ""}
        ORDER BY created_at DESC,id DESC LIMIT ${add(parsed.limit + 1)}`, values)).rows;
      const shown = rows.slice(0, parsed.limit);
      return { rows: shown.map(({ cursor_at: _unused, ...row }) => row), nextCursor: rows.length > parsed.limit ? encodeCursor(shown[shown.length - 1].cursor_at, shown[shown.length - 1].id) : null };
    },
    async get(id: string) { return (await db.query(`SELECT ${columns} FROM public.admin_serious_rule_versions WHERE id=$1`, [id])).rows[0]; },
    /** Appends the next version of a rule. The database fixes the version order, digest, time and the 'not_clinically_approved' value. */
    async create(admin: AdminContext, input: RuleInput) {
      return transaction(db, async c => {
        await c.query("SELECT pg_advisory_xact_lock(1095260233, hashtext($1))", ["admin_rule:" + input.ruleId]);
        const version = ((await c.query<{ v: number }>("SELECT COALESCE(max(version),0)::int AS v FROM public.admin_serious_rule_versions WHERE rule_id=$1", [input.ruleId])).rows[0].v) + 1;
        const row = (await c.query<{ id: string }>(`INSERT INTO public.admin_serious_rule_versions(rule_id,version,definition,created_by) VALUES($1,$2,$3::jsonb,$4) RETURNING id`,
          [input.ruleId, version, JSON.stringify(input.definition), admin.adminId])).rows[0];
        await writeAdminAudit(c, { actorAdminId: admin.adminId, actorRole: admin.role, action: "admin.rules.create", targetType: "serious_rule", targetId: row.id,
          scope: { rule_id: input.ruleId, version, clinical_approval: "not_clinically_approved" }, outcome: "success", requestId: admin.requestId });
        return row.id;
      });
    },
  };
}
