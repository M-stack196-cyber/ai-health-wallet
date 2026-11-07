#!/usr/bin/env bash
# Creates the synthetic demo admin and two synthetic sample PDFs. The admin password goes only into an owner-only file
# outside the repository (shown at the end as a path); it is not printed.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
load_env
(cd "$REPO/backend" && node --import tsx src/local-stack/seed.ts)
say "Demo accounts file (read it yourself): $RUN/demo-accounts.txt"
say "Sample files to upload: $HW_STACK_HOME/samples/"
