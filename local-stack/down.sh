#!/usr/bin/env bash
# Stops everything started by up.sh. Usage: ./local-stack/down.sh [--reset]   (--reset also deletes the local database and stored sample files)
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
for n in patient admin doctor worker backend mailbox rag summary ocr; do
  if [ -f "$RUN/$n.pid" ]; then pid=$(cat "$RUN/$n.pid"); kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null; rm -f "$RUN/$n.pid"; say "stopped $n"; fi
done
[ -d "$PGDIR/data" ] && "$PGBIN/pg_ctl" -D "$PGDIR/data" -m fast -w stop >/dev/null 2>&1 && say "stopped database"
if [ "${1:-}" = "--reset" ]; then rm -rf "$PGDIR" "$FILES" "$RUN/demo-accounts.txt"; say "database and stored files deleted (env file kept)"; fi
exit 0
