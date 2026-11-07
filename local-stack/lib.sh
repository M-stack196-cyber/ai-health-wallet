# Shared settings for the local demo stack. Sourced by the other scripts. Local development only.
# Everything the stack creates lives OUTSIDE the repository in $HW_STACK_HOME (default ~/.local/share/hw-local-stack).
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export HW_STACK_HOME="${HW_STACK_HOME:-$HOME/.local/share/hw-local-stack}"
RUN="$HW_STACK_HOME/run"; LOGS="$HW_STACK_HOME/logs"; PGDIR="$HW_STACK_HOME/pg"; FILES="$HW_STACK_HOME/files"
ENVFILE="$RUN/local.env"
PGBIN=/usr/lib/postgresql/16/bin
PGPORT=55432
PY="${HW_STACK_PYTHON:-$HW_STACK_HOME/python/bin/python}"
say() { printf '%s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
load_env() { [ -f "$ENVFILE" ] || die "Run ./local-stack/setup.sh first."; set -a; . "$ENVFILE"; set +a; }
