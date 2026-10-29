# Health Wallet clients — Phase 8

This workspace contains the React Native patient app, React + Vite doctor web app, and a shared typed API package. It does not contain an Admin dashboard or a patient web app. All authorization, ownership, processing and medical scope remain backend decisions.

## Local setup

Use Node 24 and npm 11. From `frontend`, run `npm ci`. The backend remains a separate npm project with its existing lockfile. No backend runtime dependency was changed.

- **Doctor:** `npm run dev -w @health-wallet/doctor`. Vite binds loopback and proxies `/api` to `http://127.0.0.1:5000`. Override `HW_LOCAL_API` with an explicitly approved local backend URL when needed. Configure the backend's existing `SHARING_PUBLIC_ORIGIN` to the doctor origin (for local development, `http://127.0.0.1:5173`). The doctor receives `/#/share/<opaque-reference>` and immediately removes the fragment from browser history. Alternatively paste the reference on the entry screen. No permanent doctor account is created.
- **Patient:** copy `apps/patient/.env.example` to the ignored `.env` there and select your approved API endpoint. `npm start -w @health-wallet/patient`; use a matching Expo SDK 55 native runtime or local development build. `npm run android -w @health-wallet/patient` / `npm run ios -w @health-wallet/patient` require the relevant native SDK. Loopback/emulator HTTP is accepted only in development; other environments require HTTPS. No patient web target is configured.
- Verification/reset/doctor OTP screens accept the **complete opaque email token**, not a six-digit invented code. Existing configured backend delivery is required. No client bypass or test-token endpoint is supplied.
- Disabled storage, processing retry, summaries, sharing or RAG produce explicit unavailable/error states. Do not enable live providers or clinical/guardian functionality merely to demo the clients. Use synthetic data only.

## Security boundaries

Patient access tokens live in memory; only a rotating refresh credential is stored via Expo SecureStore with device-only, unlocked Keychain accessibility. Android backup is disabled. Logout and authorization denial clear runtime state and private temporary originals. The app obscures itself when inactive and requests screenshot protection. Native enforcement must still be qualified on Android/iOS.

Doctor references/tokens and medical content live only in runtime memory. There is no localStorage/sessionStorage, service worker, medical analytics or client credential logging. Protected requests always call current backend authorization. Denial aborts pending requests, advances the session generation and unmounts medical content. Expiry also clears locally. Originals are authenticated bytes in temporary object URLs, revoked on close/navigation/denial/unmount. No direct storage URLs are used. Explicit exports cannot be recalled after a user saves them.

Account deletion is visibly unavailable: M15 backend/policy work is pending, and no request is falsely submitted. Document deletion reports access restriction and pending retention rather than physical erasure.

## Focused verification

- `npm run typecheck`
- `npm test` — shared client/session/helper and scoped Expo tooling compatibility tests
- `npm run test:mobile` — React Native component workflows with explicitly mocked native modules/API adapters
- `npm run test:browser` — headless local Chrome with synthetic intercepted API fixtures; requires `/usr/bin/google-chrome` or an explicitly configured compatible local executable in the test harness
- `npm run test:contracts` — actual route factories/DB migrations/private byte adapter/email sandbox/synthetic Python RAG plus a real Chrome→Vite→backend flow. The existing runner creates an owned `/tmp/hw-phase1-pg-*` Unix-socket-only database. Requires the owned PostgreSQL/pgvector prefix `/tmp/hw-phase5-pg` and synthetic Python environment `/tmp/hw-phase3-python`; never substitutes a normal database or `.env`.
- `npm run build:doctor`
- `CI=1 EXPO_NO_TELEMETRY=1 npm run build:patient` — Android/iOS Hermes JavaScript bundle exports, **not** signed APK/IPA or device acceptance

The root workspace scopes `@expo/cli → zod` to patched 4.6.6; tests verify the CLI's actual plugin/output/MCP schema APIs. The audit still reports low-severity `deepmerge` toolchain chains with no current patched release. No forced downgrade or audit suppression was applied. See the Phase 8 report for exact evidence and open release gates.
