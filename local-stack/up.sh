#!/usr/bin/env bash
# Starts the whole local demo stack. Usage: ./local-stack/up.sh [--light]
#   --light  skips the admin web and the patient web preview (the two heaviest parts) to save memory.
# Local development only. Synthetic data only. Loopback only. Nothing here talks to AWS, a real mailbox or a real AI model.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
LIGHT=0; [ "${1:-}" = "--light" ] && LIGHT=1
load_env
[ "${NODE_ENV:-}" = "development" ] || die "NODE_ENV must be development."
mkdir -p "$PGDIR/sock" "$FILES" "$LOGS" "$RUN"; chmod 700 "$PGDIR" "$PGDIR/sock" "$FILES"
alive() { [ -f "$RUN/$1.pid" ] && kill -0 "$(cat "$RUN/$1.pid")" 2>/dev/null; }
start() { # name, directory, command...
  local name="$1" dir="$2"; shift 2
  if alive "$name"; then say "  $name already running"; return; fi
  # The shell records its own PID, then becomes the service (exec), so the saved PID is the real process and its own process group.
  ( cd "$dir" && setsid bash -c 'echo $$ > "$0"; exec "$@"' "$RUN/$name.pid" "$@" > "$LOGS/$name.log" 2>&1 < /dev/null & ) > /dev/null 2>&1
}
wait_http() { # name, url, [seconds]
  for _ in $(seq 1 "${3:-90}"); do curl -fsS -o /dev/null --max-time 2 "$2" 2>/dev/null && { say "  $1 ready"; return; }; sleep 1; done
  die "$1 did not become ready. See $LOGS/$1.log"
}
say "1/4 Database (system PostgreSQL 16 with pgvector, local socket only)"
if [ ! -d "$PGDIR/data" ]; then "$PGBIN/initdb" -D "$PGDIR/data" --auth=trust --no-locale --encoding=UTF8 > "$LOGS/initdb.log" 2>&1; fi
if ! "$PGBIN/pg_ctl" -D "$PGDIR/data" status >/dev/null 2>&1; then
  "$PGBIN/pg_ctl" -D "$PGDIR/data" -l "$LOGS/postgres.log" -o "-c listen_addresses='' -k $PGDIR/sock -p $PGPORT -c unix_socket_permissions=0700 -c shared_buffers=64MB -c max_connections=30" -w start >/dev/null
fi
(cd "$REPO/backend" && node --import tsx src/local-stack/provision.ts)
say "2/4 Python services (OCR, summary, RAG) and the synthetic mailbox"
PYE=(env -i PATH=/usr/bin:/bin PYTHONPATH="$REPO/ai-service" PYTHONDONTWRITEBYTECODE=1)
start ocr "$REPO/ai-service" "${PYE[@]}" OCR_SERVICE_TOKEN="$OCR_SERVICE_TOKEN" OCR_SERVICE_PORT=8011 "$PY" -m ocr_service.entry
start summary "$REPO/ai-service" "${PYE[@]}" SUMMARY_PROVIDER=synthetic-offline SUMMARY_SERVICE_TOKEN="$SUMMARY_SERVICE_TOKEN" SUMMARY_SERVICE_PORT=8012 "$PY" -m summary_service.entry
start rag "$REPO/ai-service" "${PYE[@]}" RAG_PROVIDER=synthetic-offline RAG_SERVICE_TOKEN="$RAG_SERVICE_TOKEN" RAG_SERVICE_PORT=8013 "$PY" -m rag_service.entry
start mailbox "$REPO/backend" node --import tsx src/auth/security-email-sandbox.ts --local-synthetic-only
say "3/4 Backend API and the local demo worker"
start backend "$REPO/backend" node --import tsx src/local-stack/server-entry.ts
start worker "$REPO/backend" node --import tsx src/local-stack/worker-entry.ts
say "4/4 Web apps"
start doctor "$REPO/frontend/apps/doctor" npx vite --host 127.0.0.1 --port 5173 --strictPort
if [ "$LIGHT" = 0 ]; then
  start admin "$REPO/frontend/apps/admin" npx vite --host 127.0.0.1 --port 5174 --strictPort
  start patient "$REPO/frontend/apps/patient" env CI=1 EXPO_NO_TELEMETRY=1 EXPO_PUBLIC_API_URL=http://127.0.0.1:5000 npx expo start --web --localhost --port 8081
fi
say "Waiting for health checks..."
wait_http backend http://127.0.0.1:5000/api/v1/health 60
wait_http mailbox http://127.0.0.1:8026/messages 30
wait_http doctor http://127.0.0.1:5173/ 60
if [ "$LIGHT" = 0 ]; then wait_http admin http://127.0.0.1:5174/ 60; wait_http "patient (bundle served)" http://127.0.0.1:8081/ 240; fi
# A port that answers is not proof that a page draws. Open each web app in headless Chrome (skipped, with a note, if Chrome is missing).
if [ -x /usr/bin/google-chrome ]; then
  say "Render checks (headless Chrome)"
  node "$REPO/local-stack/check-web.mjs" http://127.0.0.1:5173 "Shared with care" || say "  WARNING: doctor web did not render"
  if [ "$LIGHT" = 0 ]; then
    node "$REPO/local-stack/check-web.mjs" http://127.0.0.1:5174 "Sign in" || say "  WARNING: admin web did not render"
    node "$REPO/local-stack/check-web.mjs" http://localhost:8081 "Welcome back" || say "  WARNING: patient web did not render"
  fi
else say "  (render checks skipped: /usr/bin/google-chrome not found)"; fi
for n in ocr summary rag worker; do alive "$n" && say "  $n running" || say "  WARNING: $n is not running. See $LOGS/$n.log"; done
cat <<DONE

The stack is up (synthetic data only).
  Patient app (web preview)  http://localhost:8081 $( [ "$LIGHT" = 1 ] && echo "(not started: --light)")
  Doctor web                 http://127.0.0.1:5173
  Admin web                  http://127.0.0.1:5174 $( [ "$LIGHT" = 1 ] && echo "(not started: --light)")
  Backend API                http://127.0.0.1:5000/api/v1/health
  Synthetic mailbox          http://127.0.0.1:8026/messages   (verification and doctor codes appear here)
Next: ./local-stack/seed-demo.sh     Stop: ./local-stack/down.sh
DONE
