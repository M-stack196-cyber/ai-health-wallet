# PRD v2 Phase 8 — patient and doctor frontends

29 October 2026 · Asia/Karachi · Owner review checkpoint; no commit/push/deployment.

## Outcome and qualification boundary

The approved React Native patient application and React + Vite doctor application now call the existing backend through a centralized typed API package. No backend business logic was rewritten. The doctor slice is implementation-complete and locally integrated at synthetic scope, including Chrome through Vite to actual backend routes, disposable PostgreSQL, private original bytes and actual sandbox email-OTP validation. The broader M12 module remains PARTIAL because M12-001 includes the explicitly excluded M13 administrative dashboard.

The patient workflows are implemented against existing contracts, with component/API integration and Android/iOS Hermes exports. **M11 is not implementation-complete:** the approved account-deletion request backend/policy is absent, and native secure storage, file transport/view/export and clipboard/share/device lifecycle acceptance remain unqualified. An export is not an installed APK/IPA, simulator/device run, usability study or full mobile E2E qualification. No additional patient web app exists.

Neither client is declared production-ready. Live email, private S3, clinical/serious-rule approval, hosted sensitive AI, legal retention/privacy, deployed TLS/security and full-system release qualification remain open. This phase does not close M16/M17 or authorize M13.

## Baseline and Git state

Authoritative requirements remain SRS v4.0 and PRD v2.0, together with the current v2 tracker, reconciliation and Phase 7 guardian-notification report. Relevant M11/M12 requirements and architecture decisions were checked against the two DOCX documents before implementation. Older SRS/PRD files and historical evidence were not treated as completion authority.

- Start: clean `main` at `3fec4f70b89e66c4297562494cd954a7c7f37b65` — Implement Phase 7 guardian notification backend.
- Final HEAD remains the same; work is uncommitted and unpushed.
- SRS SHA-256: `6b4f629fe18dcd3ecb02a61abea2de20e18a380f0dea34f5942e9603d72b2b55`.
- PRD SHA-256: `454a6a2a6c53cbb325cca0e9125da1b1f274506dc0557a8161d1e81fc8339c84`.
- All 36 captured pre-existing baseline documents, migrations and receipts retain their original SHA-256. No migration was created or modified; migrations 0001–0012 remain intact.
- All 232 unique tracker rows and their first four requirement/source/priority columns are preserved. Only the 21 M11/M12 detailed rows and their summary accounting changed; every other detailed requirement row remains byte-for-byte equivalent in its cells. No historical B01–B03.x evidence was overwritten.

## Structure and API integration

```text
frontend/
  apps/patient/       React Native + Expo SDK 55, TypeScript, Android/iOS only
    App.tsx          Native app lifecycle, privacy shield and auth flows
    src/Workspace.tsx  Profile/guardian, upload, records, summaries, timeline, RAG, shares
    src/platform.ts  SecureStore, native multipart adapter and temporary original handling
    src/ui.tsx       Reusable labeled controls and consistent green/neutral design
  apps/doctor/        React + Vite + TypeScript
    src/App.tsx      Share/identity/OTP entry and selected-record workspace
    src/main.tsx     One-time fragment consumption and history cleanup
    src/style.css    Responsive desktop/mobile layout and focus states
  packages/api/       Typed contracts, centralized request/session/error handling
  tests/              Client/session, actual backend contracts and Chrome workflows
```

Setup and reproducible commands are in [frontend/README.md](../frontend/README.md). Backend dependencies/lockfile and normal environment files are unchanged. The only existing infrastructure edit adds `--phase8` to the owned disposable identity runner. The runner never substitutes the development database or normal `.env`. The API contract harness follows the actual application's route ordering, including guardian routes after query-bearing document/sharing routes.

Doctor development uses a same-origin `/api` proxy to the explicitly selected loopback backend, default port 5000. Production origin/TLS/reverse-proxy/CORS acceptance is not supplied or claimed. Patient API configuration is explicit; only loopback/emulator HTTP is permitted in development, and HTTPS is required otherwise.

## Patient workflows

- Registration collects name/email/password, DOB, optional rule-context sex/gender, phone and guardian email using the existing approved field names. Verification-required, full email-token completion/resend, login, forgot/reset password and explicit success/error states use M01. Tokens are not shown as ordinary text or logged; reset invalidates local and backend sessions.
- Access tokens remain in memory. A rotating refresh credential uses Expo SecureStore with device-only unlocked Keychain accessibility; no AsyncStorage secrets. Renewal is single-flight. Logout, failed renewal and authorization denial clear credentials and mounted sensitive views. Native secure-store failure prevents a retained login. App inactivity obscures content; screenshot protection is requested. Actual native enforcement remains a device gate.
- Profile edits allow only name/DOB/phone/sex-gender. Guardian NONE/PENDING/ACTIVE/REVOKED/EXPIRED status, add/resend/replace/remove call M02; replace/remove require confirmation. No guardian portal or real medical email is enabled.
- The native picker accepts PDF/JPG/JPEG/PNG; client extension/MIME checks provide early feedback while the backend remains authoritative for bytes, signatures, size and malformed content. Upload sends category/hospital/date and shows indeterminate activity until server confirmation. Extraction status/failure and server-approved retry availability never imply AI completion.
- Library search is explicitly limited to loaded records. Category/hospital/upload-date filters and pagination go to the backend. Detail/metadata edits, authenticated original retrieval and confirmed access deletion reuse M03/M04. Deletion does not claim physical erasure or resolved retention. Native originals use a private transient file and native viewer/export sheet after current byte authorization, without handing bearer credentials to an external viewer. Temporary files are cleaned on completion/session end; already exported copies cannot be recalled.
- Report summary requests/status/retry, accepted summary display, queued/failed/completed history sections, provenance/limitations, chronological timeline and upload-date fallback use M06/M07. Sources can be checked through current document reads. Missing/failed/unsupported evidence is not invented.
- Patient RAG displays grounded text, date/page/file citations, explicit insufficiency and safe failures. Source access remains a current backend request. Synthetic/offline and non-diagnostic boundaries are visible.
- Sharing starts with an empty exact selection, capped by the existing 20-record contract. QR/link creation, backend-produced SVG/reference, expiry, list/status and confirmed revocation use M09. Explicit native **Copy link** and **Share link** actions never generate identifiers/storage keys. The opaque reference remains transient unless the user copies/exports it. Clipboard/exported copies are outside app control; backend expiry/OTP/revocation remain authoritative.
- Account deletion is visibly unavailable. No invented endpoint, fake request submission, original erasure or legal-retention completion is presented.

## Doctor workflows and privacy behavior

QR-derived references and unique links are accepted. The fragment is removed from browser history immediately. Doctor name/email and optional organization precede email OTP request/verify/resend, expiry and safe invalid/rate-limit handling. The UI accepts the complete opaque email code supported by the backend, with no invented numeric OTP protocol or permanent doctor account.

Every record/search/filter/detail/original/summary/history/timeline/RAG operation uses the doctor temporary-session API. Only selected sources are returned; no patient-wide history endpoint is used. Original view/download fetches authenticated bytes and creates runtime-only object URLs. View URLs are revoked on close, navigation, denial and unmount. User-requested downloads cannot be recalled after saving.

A protected 401/403 clears the token, aborts pending requests and advances an epoch before notifying the UI. Late responses cannot restore medical state. The entire protected workspace unmounts, including originals, summaries and RAG results. Expiry also clears through a timer; pagehide ends the session, and focus/visibility refreshes current authorization. Missing sources clear stale source views; summary absence is represented as unavailable. There is no localStorage/sessionStorage, service worker, medical analytics or persistent medical cache. Unknown exception messages are redacted rather than exposing native paths/server internals.

The responsive UI supplies labeled fields, visible keyboard focus, loading/empty/error states, safe destructive confirmations and clear source/processing cues. Protected pages were inspected in headless Chrome at 1440px desktop and 390px mobile width with no horizontal overflow. Mobile-width browser evidence covers the doctor interface; it is not React Native device evidence.

## Dependencies and security audit

Added frontend-only workspaces and an npm-generated lockfile:

| Area | Added dependencies |
|---|---|
| Shared | Local `@health-wallet/api` package; no network/runtime dependency |
| Doctor | React/React DOM 19.2.0, Vite 8.3.5 and React Vite plugin |
| Native | Expo 55.0.32, React Native 0.83.10, React 19.2.0; SDK-compatible SecureStore, DocumentPicker, FileSystem, Sharing, Clipboard, ScreenCapture, safe-area-context and react-native-svg |
| Verification | TypeScript 5.9, tsx, type declarations, Jest 29/jest-expo 55, React Native Testing Library, matching react-test-renderer and Playwright using existing system Chrome |

Exact installed versions and transitive resolution are in `frontend/package-lock.json`. SDK-native selections follow Expo's bundled-native-module manifest; SecureStore behavior follows the [Expo SDK 55 SecureStore documentation](https://docs.expo.dev/versions/v55.0.0/sdk/securestore/). No framework technology was replaced.

Initial frontend audit: 13 low and 3 high findings. The high chain was Expo CLI → Zod 3.25.76, [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5), audit affected range `<4.6.6`. A scoped npm override installs Zod **4.6.6** under Expo CLI. Its actual plugin/output parsing and MCP command-schema APIs are tested; native export and CLI startup also pass. No blind force/downgrade or audit suppression was used.

Final frontend audit: **0 critical, 0 high, 0 moderate, 15 low**. Remaining findings are the Expo/Jest configuration/tooling chains around `deepmerge` 4.3.1, [GHSA-gcqx-w48m-w2h4](https://github.com/advisories/GHSA-gcqx-w48m-w2h4); the registry supplied no newer patched deepmerge release. These findings remain recorded for security/release review. No claim of an audit-clean or production-qualified system is made.

## Focused verification results

All final focused checks below pass. No broad backend regression or final M17 suite was run.

| Check | Result and boundary |
|---|---|
| `npm --prefix frontend run typecheck` | PASS: shared API, doctor app and native app/components |
| `npm --prefix frontend test` | **12 PASS**: secure refresh/login/restore/logout/reset, failed secure storage, renewal, doctor denial/late-response fence/expiry, network timeout, exact scopes/file validation/filter encoding, safe errors and Zod compatibility |
| `npm --prefix frontend run test:mobile` | **19 PASS**: native auth/verification/recovery, five guardian states/replace/remove, upload/selection, library/search/detail, failure/retry/summary/deletion, RAG citations/insufficiency, timeline order/fallback/exclusion, history queued/failed/completed, exact QR sharing/copy. Native bridges/API adapters are explicitly mocked in these component tests |
| `npm --prefix frontend run test:browser` | **6 PASS**: link/QR reference and OTP gate, invalid/expired OTP/resend, scoped search/file/summary/timeline/RAG, revocation with original open, expiry while open and responsive layouts. Synthetic APIs are intercepted for these browser scenarios |
| `node infrastructure/identity/run.mjs --execute-isolated --phase8` | **6 PASS**: actual M01 auth/recovery; M02 profile/guardian; upload/metadata/filtered lists/private bytes/readiness/deletion/timeline; selected-doctor originals/summary/history/RAG/bypass/revoke; deletion/account suspension; Chrome→Vite→actual backend/email OTP/private bytes/revocation. Private storage is a synthetic byte adapter, not live S3 |
| Doctor production bundle | PASS: `npm --prefix frontend run build:doctor` |
| Native bundle exports | PASS: `CI=1 EXPO_NO_TELEMETRY=1 npm --prefix frontend run build:patient` for Android/iOS Hermes; no installed/signed native binary acceptance |
| Final `npm audit --json` | Completed: 15 low, no moderate/high/critical findings; non-zero audit exit is retained, not treated as audit-clean |
| Governance checks | PASS: 232 unique rows, 18 modules, 21 scoped row updates; all other detailed rows/source mappings and captured historical hashes preserved; no migration/backend runtime changes; `git diff --check` |

Total focused tests: **43 passed**. The actual disposable integration run used `/tmp/hw-phase1-pg-OmDYk5`, and its database was stopped. No development or production database, production AWS, real guardian/clinical provider, hosted LLM or production deployment was used.

Protected local logs and synthetic screenshots reside under `.private-evidence/prd-v2-phase8-20261029/`; hashes and result boundaries are recorded in the [Phase 8 receipt](baselines/PRD_V2_PHASE_8_PATIENT_DOCTOR_FRONTENDS_RECEIPT.json). They are ignored by Git. Native screenshot/device usability evidence is absent and remains pending.

## Every M11 and M12 requirement

IMPLEMENTED below means the stated local implementation/contract slice has evidence. It does not close the explicitly listed native/live/clinical/deployed acceptance gates.

| Requirement | Status | Implementation / evidence scope | Remaining gap |
|---|---|---|---|
| M11-001 | IMPLEMENTED | frontend/apps/patient/{App.tsx,index.ts,app.json}; React Native/Expo native entry | Native source and Android/iOS Hermes exports present. Installed-device usability/E2E and release acceptance remain pending. |
| M11-002 | PARTIAL | frontend/apps/patient/App.tsx Auth; src/platform.ts createSession; frontend/packages/api/src/client.ts PatientSession | Local auth UI/API lifecycle qualified; actual Keychain/Keystore persistence, renewal/background/expiry and logout require Android/iOS device qualification; production email remains gated. |
| M11-003 | IMPLEMENTED | frontend/apps/patient/src/Workspace.tsx ProfilePanel; shared patientApi profile/guardian lifecycle | Local synthetic profile/guardian lifecycle qualified. Native-device and live email/privacy acceptance remain release gates. |
| M11-004 | PARTIAL | frontend/apps/patient/src/Workspace.tsx UploadPanel/RecordDetail; src/platform.ts pickedForm; shared upload/processing/retry | Upload/metadata/status/retry source, component and real API contracts qualified; native picker URI multipart transport and real device upload/error/retry must be qualified. Live S3 remains external. |
| M11-005 | PARTIAL | frontend/apps/patient/src/Workspace.tsx RecordsPanel/RecordDetail; src/platform.ts presentOriginal/clearFiles | Library/filter/detail/metadata/access-deletion and private bytes integrated locally; native original preview/export, FileReader/cache cleanup and device lifecycle still require native qualification. Physical erasure/retention not claimed. |
| M11-006 | IMPLEMENTED | frontend/apps/patient/src/Workspace.tsx SummaryCard/HistoryPanel/TimelinePanel; shared summary/history/timeline APIs | Local synthetic summaries/history/timeline integrated; native E2E plus clinical/provider/semantic completeness and release acceptance remain open. |
| M11-007 | IMPLEMENTED | frontend/apps/patient/src/Workspace.tsx RagPanel; shared patientApi.ask and current source reads | Local bounded patient RAG/citations/insufficiency integrated; broad semantic, hosted-sensitive-provider, native E2E and clinical acceptance remain gated. |
| M11-008 | PARTIAL | frontend/apps/patient/src/Workspace.tsx SharingPanel; backend SVG rendering; explicit Clipboard/Share actions; shared grants API | Exact selection, backend QR/link, expiry/list/revoke and explicit copy/share implemented; native SVG/clipboard/share-sheet and lifecycle acceptance require devices. Live delivery/forwarding review remains open. |
| M11-009 | BLOCKED | frontend/apps/patient/src/Workspace.tsx ProfilePanel privacy section; no account-deletion endpoint invented | Approved account-deletion policy/API is absent (M15-001/M15-002). UI truthfully says unavailable and does not submit or claim a deletion request. Requires separately authorized M15 implementation/policy. |
| M11-010 | IMPLEMENTED | frontend/packages/api/src/client.ts ApiError/safeMessage; native safe labels, privacy shield and session clearing | Safe local presentation and unknown-error redaction qualified; screenshot/app-switcher and temporary-file enforcement still require native devices/security acceptance. |
| M11-011 | IMPLEMENTED | frontend/apps/patient/app.json platforms=android/ios; no patient web entry or web build | No patient web app added. Retain scope restriction. |
| M12-001 | PARTIAL | frontend/apps/doctor/{src/App.tsx,vite.config.ts}; doctor entry/workspace only; no M13 dashboard | Doctor slice locally integrated/qualified. Administrative-dashboard clause belongs to explicitly excluded M13 and remains undelivered; row cannot be fully IMPLEMENTED. |
| M12-002 | IMPLEMENTED | frontend/apps/doctor/src/App.tsx Workspace filters/summary views; shared doctorApi records/summary/history | Doctor local synthetic behavior qualified by source, focused browser and actual backend contracts as applicable. Live email/S3, deployed browser/TLS/privacy/security and full-system release acceptance remain open. |
| M12-003 | IMPLEMENTED | frontend/apps/doctor/package.json; vite.config.ts; src/main.tsx | Doctor local synthetic behavior qualified by source, focused browser and actual backend contracts as applicable. Live email/S3, deployed browser/TLS/privacy/security and full-system release acceptance remain open. |
| M12-004 | IMPLEMENTED | frontend/apps/doctor/src/App.tsx App open/requestOtp/verify; shared doctorApi open/otp/verify | Doctor local synthetic behavior qualified by source, focused browser and actual backend contracts as applicable. Live email/S3, deployed browser/TLS/privacy/security and full-system release acceptance remain open. |
| M12-005 | IMPLEMENTED | frontend/apps/doctor/src/App.tsx Workspace; backend-controlled doctorApi records/record | Doctor local synthetic behavior qualified by source, focused browser and actual backend contracts as applicable. Live email/S3, deployed browser/TLS/privacy/security and full-system release acceptance remain open. |
| M12-006 | IMPLEMENTED | frontend/apps/doctor/src/App.tsx Workspace timeline/history/filters; shared doctorApi | Doctor local synthetic behavior qualified by source, focused browser and actual backend contracts as applicable. Live email/S3, deployed browser/TLS/privacy/security and full-system release acceptance remain open. |
| M12-007 | IMPLEMENTED | frontend/apps/doctor/src/App.tsx Workspace original/dispose; authenticated blobs and temporary object URLs | Doctor local synthetic behavior qualified by source, focused browser and actual backend contracts as applicable. Live email/S3, deployed browser/TLS/privacy/security and full-system release acceptance remain open. |
| M12-008 | IMPLEMENTED | frontend/apps/doctor/src/App.tsx scoped question/citation views; doctorApi.ask | Doctor local synthetic behavior qualified by source, focused browser and actual backend contracts as applicable. Live email/S3, deployed browser/TLS/privacy/security and full-system release acceptance remain open. |
| M12-009 | IMPLEMENTED | frontend/packages/api/src/client.ts ApiClient epoch/abort/clear and DoctorSession expiry; doctor unmount/dispose/pagehide/focus handling | Doctor local synthetic behavior qualified by source, focused browser and actual backend contracts as applicable. Live email/S3, deployed browser/TLS/privacy/security and full-system release acceptance remain open. |
| M12-010 | IMPLEMENTED | frontend/apps/doctor/src/App.tsx temporary share/email-OTP session; no persistent account or storage | Doctor local synthetic behavior qualified by source, focused browser and actual backend contracts as applicable. Live email/S3, deployed browser/TLS/privacy/security and full-system release acceptance remain open. |

## Tracker totals and all 18 modules

**IMPLEMENTED 115 · PARTIAL 57 · MISSING 35 · BLOCKED 19 · NEEDS_REVERIFICATION 6 = 232.** Only M11/M12 rows changed. M11: 6 I / 4 P / 1 B. M12: 9 I / 1 P. I/P/M/B/NR are the five approved tracker classifications, not module-completion declarations.

| Module | I | P | M | B | NR |
|---|---:|---:|---:|---:|---:|
| M01 | 14 | 0 | 0 | 0 | 0 |
| M02 | 10 | 0 | 0 | 0 | 0 |
| M03 | 8 | 2 | 0 | 0 | 2 |
| M04 | 11 | 3 | 0 | 0 | 0 |
| M05 | 9 | 1 | 0 | 0 | 0 |
| M06 | 5 | 3 | 0 | 0 | 0 |
| M07 | 3 | 5 | 2 | 1 | 0 |
| M08 | 13 | 5 | 2 | 2 | 0 |
| M09 | 14 | 4 | 0 | 1 | 0 |
| M10 | 10 | 3 | 0 | 1 | 0 |
| M11 | 6 | 4 | 0 | 1 | 0 |
| M12 | 9 | 1 | 0 | 0 | 0 |
| M13 | 0 | 0 | 21 | 1 | 0 |
| M14 | 0 | 9 | 0 | 1 | 1 |
| M15 | 1 | 4 | 6 | 1 | 0 |
| M16 | 0 | 5 | 1 | 3 | 1 |
| M17 | 0 | 5 | 3 | 1 | 2 |
| M18 | 2 | 3 | 0 | 6 | 0 |

## Integration gaps and next owner decision

1. Qualify an installed Android/iOS build with the approved synthetic backend: secure store/renewal/revocation/logout, native picker multipart transport, temporary original preview/export/cleanup, screenshot/background protection, QR/copy/share and full device workflows. No emulator/native SDK/device was available for this phase.
2. Obtain the approved account-deletion/privacy/retention contract and separately authorize missing M15 work before closing M11-009. The present unavailable state is intentional and honest.
3. Retain all unresolved CFG gates. In particular, hosted/provider/semantic/clinical approvals, real email/storage, consent/forwarding/retention, native/client usability, deployment/TLS/security and full integrated qualification remain external. Existing M01–M10 classifications were not automatically upgraded by frontend tests.
4. Resolve/review the remaining low-severity tooling advisories and perform approved deployed/browser/native security acceptance before release. No production-readiness claim follows from the local test count.
5. **M13 has not begun and is not automatically authorized.** The doctor slice is ready for owner review; the owner must explicitly authorize any Admin phase. This phase stops here.

## Files changed

New frontend files:

- `frontend/README.md`
- `frontend/apps/doctor/index.html`
- `frontend/apps/doctor/package.json`
- `frontend/apps/doctor/src/App.tsx`
- `frontend/apps/doctor/src/main.tsx`
- `frontend/apps/doctor/src/style.css`
- `frontend/apps/doctor/tsconfig.json`
- `frontend/apps/doctor/vite.config.ts`
- `frontend/apps/patient/.env.example`
- `frontend/apps/patient/App.tsx`
- `frontend/apps/patient/app.json`
- `frontend/apps/patient/index.ts`
- `frontend/apps/patient/package.json`
- `frontend/apps/patient/src/Workspace.tsx`
- `frontend/apps/patient/src/platform.ts`
- `frontend/apps/patient/src/ui.tsx`
- `frontend/apps/patient/src/workflows.test.tsx`
- `frontend/apps/patient/tsconfig.json`
- `frontend/package-lock.json`
- `frontend/package.json`
- `frontend/packages/api/package.json`
- `frontend/packages/api/src/client.ts`
- `frontend/packages/api/src/contracts.ts`
- `frontend/packages/api/src/index.ts`
- `frontend/packages/api/tsconfig.json`
- `frontend/tests/backend.contract.ts`
- `frontend/tests/client.test.ts`
- `frontend/tests/doctor.browser.ts`

Existing file updates:

- `infrastructure/identity/run.mjs` — explicit owned Phase 8 contract selector only.
- `docs/PRD_V2_MODULE_DELIVERY_TRACKER.md` — 21 M11/M12 rows and corresponding totals/progress.

New governance artifacts:

- `docs/PRD_V2_PHASE_8_PATIENT_DOCTOR_FRONTENDS.md` — this report.
- `docs/baselines/PRD_V2_PHASE_8_PATIENT_DOCTOR_FRONTENDS_RECEIPT.json` — scoped evidence receipt.

No migrations, existing backend runtime/dependency changes, commit, push or deployment.
