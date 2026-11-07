#!/usr/bin/env bash
# One-time setup for the local demo stack (Ubuntu). Checks tools, makes a Python environment, writes a private env file with
# random secrets (values are never printed), and installs npm packages. Safe to run again: it keeps the existing env file.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
say "Checking tools..."
for tool in node npm python3 tesseract pdftoppm pdfinfo curl openssl; do command -v "$tool" >/dev/null || die "Missing tool: $tool (try: sudo apt install nodejs npm python3 python3-venv tesseract-ocr poppler-utils curl openssl)"; done
[ -x "$PGBIN/initdb" ] || die "PostgreSQL 16 not found (sudo apt install postgresql-16 postgresql-16-pgvector)."
[ -f /usr/share/postgresql/16/extension/vector.control ] || die "pgvector is missing (sudo apt install postgresql-16-pgvector)."
mkdir -p "$RUN" "$LOGS" "$HW_STACK_HOME"; chmod 700 "$HW_STACK_HOME" "$RUN" "$LOGS"
if [ ! -x "$PY" ]; then
  if [ -x "$HOME/.local/share/hw-test/python/bin/python" ]; then ln -sfn "$HOME/.local/share/hw-test/python" "$HW_STACK_HOME/python"; say "Reusing the existing test Python environment."
  else say "Creating the Python environment (needs internet once)..."; python3 -m venv "$HW_STACK_HOME/python"
    "$PY" -m pip install --quiet -r "$REPO/ai-service/requirements-rag.txt" -r "$REPO/ai-service/requirements-ocr.txt"; fi
fi
"$PY" -c "import uvicorn, fastapi, PIL" || die "Python packages are missing."
if [ ! -f "$ENVFILE" ]; then
  umask 077; hex() { openssl rand -hex "$1"; }
  cat > "$ENVFILE" <<ENV
HW_LOCAL_STACK=1
HW_STACK_HOME=$HW_STACK_HOME
NODE_ENV=development
PORT=5000
FRONTEND_ORIGIN=http://127.0.0.1:5173
DB_HOST=$PGDIR/sock
DB_PORT=$PGPORT
DB_NAME=hw_local
DB_USER=health_wallet_app
DB_PASSWORD=$(hex 16)
JWT_SECRET=$(hex 32)
JWT_ALGORITHM=HS256
JWT_EXPIRES_IN_SECONDS=900
JWT_ISSUER=ai-health-wallet-api
JWT_AUDIENCE=ai-health-wallet-patient
ADMIN_JWT_SECRET=$(hex 32)
ADMIN_JWT_AUDIENCE=ai-health-wallet-admin
ADMIN_JWT_ISSUER=ai-health-wallet-api
ARGON2_MEMORY_KIB=19456
ARGON2_TIME_COST=2
ARGON2_PARALLELISM=1
AUTH_HASH_CONCURRENCY=1
DOCUMENT_STORAGE_LOCAL_DIR=$FILES
DOCUMENT_STORAGE_LOCAL_SYNTHETIC_ONLY=true
DOCUMENT_VALIDATION_TIMEOUT_MS=10000
AUTH_SECURITY_EMAIL_MODE=sandbox
AUTH_SECURITY_EMAIL_ENDPOINT=http://127.0.0.1:8026/security-email
AUTH_SECURITY_EMAIL_FROM=security@example.invalid
AUTH_SECURITY_EMAIL_ENCRYPTION_KEY=$(hex 32)
OCR_SERVICE_URL=http://127.0.0.1:8011/v1/extractions
OCR_SERVICE_TOKEN=$(hex 32)
SUMMARY_PROVIDER=synthetic-offline
SUMMARY_SERVICE_URL=http://127.0.0.1:8012/internal/v1/report-summaries:generate
SUMMARY_SERVICE_TOKEN=$(hex 32)
RAG_PROVIDER=synthetic-offline
RAG_SERVICE_URL=http://127.0.0.1:8013/internal/v1/rag/
RAG_SERVICE_TOKEN=$(hex 32)
SHARING_PUBLIC_ORIGIN=http://127.0.0.1:5173
PHASE3_PYTHON=$PY
ENV
  say "Wrote the private env file (owner-only, outside the repository). Secret values are not shown."
else say "Keeping the existing env file."; fi
say "Checking npm packages (installed only if missing; uses the lockfiles, never rewrites them)..."
[ -d "$REPO/backend/node_modules" ] || (cd "$REPO/backend" && npm ci --no-audit --no-fund --silent)
[ -d "$REPO/frontend/node_modules" ] || (cd "$REPO/frontend" && npm ci --no-audit --no-fund --silent)
say "Setup finished. Next: ./local-stack/up.sh"
