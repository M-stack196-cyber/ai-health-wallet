# AI Health Wallet: standing rules for Claude

These rules apply to every session in this repository. The owner is a student, so keep explanations simple.

## Source of truth

- Build the whole project strictly from `docs/AI_Health_Wallet_Revised_SRS_v4_0.docx` (SRS v4.0) and `docs/AI_Health_Wallet_Module_Wise_PRD_v2_0.docx` (PRD v2.0).
- No requirement may be silently skipped. Every requirement ends as done, or as clearly marked not done.
- If something cannot be completed (blocked by a CFG approval, AWS, a real email provider, a real AI key, or similar), record it in `docs/PRD_V2_MODULE_DELIVERY_TRACKER.md` with:
  1. the requirement ID,
  2. the reason it is blocked,
  3. exactly what is needed to unblock it.
- Do not mark a CFG-gated item as done by approving it yourself. Admin or developer editing is never clinical, privacy or security approval.

## How to work

1. **One phase at a time.** Do not start the next phase until the owner says so.
2. **After each phase:**
   - run that phase's tests and fix failures that belong to the phase;
   - show the pass and fail counts;
   - list every file added or changed.
3. **Update the tracker after each phase with evidence only.** Name the tests, files and results that actually exist. Do not upgrade a row's status without evidence. Keep IMPLEMENTED, PARTIAL, MISSING, BLOCKED and NEEDS_REVERIFICATION meanings exactly as the tracker defines them.
4. **Never invent facts.** Say clearly what was tested and what was not (for example: tests that need pgvector, a real database, AWS, a real email provider or a real device). If a command was not run, say so. Report failing tests as failing.
5. **Explain results in simple English.** Short sentences, no unexplained jargon, say what a result means for the project.

## Secrets and safety

- Never commit or print secrets: `.env` files (including `.env.migrations`), API keys, tokens, passwords, password hashes, `.aws`, and `.private-evidence`.
- When checking configuration, report variable names only, never values.
- Use synthetic data only (for example `@example.invalid` emails). Never use real patient data.
- Never run `git push`. The owner pushes. Only commit when the owner asks, and never with `--no-verify` or force options.
- Do not change the development database, `backend/.env`, or deployed or cloud resources unless the owner asks. Tests run on disposable local databases.

## Code style and security

- Match the surrounding code: naming, comment density, file layout and idiom. Look at a neighbouring module (for example `backend/src/sharing/` or `backend/src/guardian-notifications/`) before writing a new one.
- Backend is TypeScript (ESM, strict), Express 5, `pg`, tests with `node:test` run through `tsx`. Database changes are new, additive migrations in `backend/migrations/` (never edit an applied migration). Use `public.` names, CHECK constraints, `clock_timestamp()`, and explicit `REVOKE`/`GRANT` for `health_wallet_app`.
- Keep the security model: separate actors and token audiences, authorization re-checked against the database on every request, no raw driver errors or secrets in responses or logs, `Cache-Control: no-store`, input validated with explicit allowlists, rate limits stored by hash, audit rows written in the same transaction as the action.
- Patient, doctor and admin credentials must never work on each other's routes. Admin power never replaces patient consent and gives no way to browse, download or edit medical records.
- Do not add features, endpoints or files beyond what the current phase needs.

## Useful commands (from `backend/`)

- Typecheck: `npm run typecheck`
- Start the local Postgres container: `cd infrastructure && docker compose --env-file .env up -d postgres`
- Run the backend: `npm run dev` (after `npm run db:migrate`)
- Admin phase tests (plain Postgres 16, disposable): `npm run phase9:test`
- Other isolated suites: `npm run identity:phase1:test` and `phase2`, `phase3` to `phase7:test`. Some need pgvector or a Python path (see `infrastructure/identity/run.mjs`).
- `npm test` is only a placeholder. Run the named suites instead.
