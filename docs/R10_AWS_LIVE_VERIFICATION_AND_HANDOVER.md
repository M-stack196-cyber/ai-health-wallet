# R10 — AWS Production Live Verification & Operational Handover

- **Target Host:** `3.27.60.207` (AWS EC2, Ubuntu 24.04 LTS)
- **Verification Date:** 2026-11-18
- **Status:** **PASSED (7/7 Live E2E Gates + Nightly Backup Cron + Expo Go 58 Client Config)**

## 1. Live Infrastructure & Microservices Topology
All 8 production containers under `/srv/hw/relay/docker-compose.prod.yml` are running and healthy:
- `hw-prod-postgres` (PostgreSQL + `pgvector`)
- `hw-prod-api` (Node.js/TypeScript REST API)
- `hw-prod-web` (Nginx TLS reverse proxy & web bundle)
- `hw-prod-worker` (Async document extraction, RAG indexing & job worker)
- `hw-prod-ocr` (Python OCR microservice on `127.0.0.1:8011`)
- `hw-prod-summary` (Python clinical summary microservice on `127.0.0.1:8012`)
- `hw-prod-rag` (Python RAG retrieval microservice on `127.0.0.1:8013`)
- `hw-prod-gmail-relay` (SMTP/IMAP transactional security email relay)

## 2. Live End-to-End Verification Gates (`V-23`)
1. **`LIVE-01` Dual-Origin HTTPS Isolation:** Verified `https://3.27.60.207` (`443`) serves Patient/Doctor routes and rejects `/api/v1/admin/*` with `404`; verified `https://3.27.60.207:8443` serves Admin routes and rejects `/api/v1/patients/*` with `404`.
2. **`LIVE-02` Registration & Real Email Verification:** Verified unverified login rejection (`401`), live Gmail SMTP delivery + IMAP token retrieval, account activation, and JWT login (`200`).
3. **`LIVE-03` Private AWS S3 Storage:** Verified multipart PDF upload (`201`) and authenticated download with exact byte-for-byte SHA-256 match.
4. **`LIVE-04` Async Worker Extraction:** Verified `hw-prod-worker` processes queued documents to `completed` state with extracted clinical text.
5. **`LIVE-05` Clinical Safety Gate (`CFG-06`):** Verified `POST /api/v1/documents/:id/summary-jobs` enforces `503 SUMMARY_UNAVAILABLE` until formal clinical validation sign-off is completed.
6. **`LIVE-06` `pgvector` RAG Q&A:** Verified `POST /api/v1/documents/:id/rag-index` and `POST /api/v1/rag/queries` return grounded, patient-scoped citations.
7. **`LIVE-07` Doctor Sharing, OTP & Instant Revocation:** Verified unique share link opening, real Gmail OTP delivery/verification, scoped `GET /api/v1/doctor/records` (returning only shared documents and returning `403` on unshared documents), cross-actor isolation, and immediate post-revocation `401/403` enforcement.

## 3. Operations, Backups (`CFG-09`) & Mobile Client (`Expo SDK 58`)
- **Nightly Backups:** `/usr/local/bin/hw-pg-backup.sh` runs nightly via cron with 7-day retention in `/var/backups/hw-postgres`.
- **Mobile Client (`frontend/apps/patient`):** Configured for Expo SDK 58 (`^58.0.0`) with `EXPO_PUBLIC_API_URL=http://3.27.60.207` (and HTTPS production origin `https://3.27.60.207`).
