#!/bin/sh
# Loads secrets from files into the environment of ONE process, then runs it.
#   NAME_FILE=/run/secrets/name  ->  NAME=<file contents>   (only for the names listed below)
# Values are never printed. Error messages name the variable, never the value.
set -eu
umask 077
fail() { echo "Secret loading refused: $1" >&2; exit 78; }

for name in JWT_SECRET ADMIN_JWT_SECRET DB_PASSWORD MIGRATION_DB_PASSWORD AUTH_SECURITY_EMAIL_ENCRYPTION_KEY \
            AUTH_SECURITY_EMAIL_AUTHORIZATION GUARDIAN_SYNTHETIC_REFERENCE_KEY RAG_SERVICE_TOKEN SUMMARY_SERVICE_TOKEN OCR_SERVICE_TOKEN; do
  eval "file=\${${name}_FILE:-}"
  [ -n "$file" ] || continue
  eval "present=\${${name}+set}"
  [ -z "$present" ] || fail "$name is set directly and through ${name}_FILE"
  [ -f "$file" ] && [ ! -L "$file" ] || fail "${name}_FILE is not a regular file"
  [ -r "$file" ] || fail "${name}_FILE is not readable"
  # A secret that group or others can write could be swapped by someone else.
  [ -z "$(find "$file" -maxdepth 0 -perm /022)" ] || fail "${name}_FILE is writable by others"
  size=$(wc -c < "$file")
  [ "$size" -gt 0 ] && [ "$size" -le 4096 ] || fail "${name}_FILE must contain 1 to 4096 bytes"
  value=$(cat "$file")
  [ -n "$value" ] || fail "${name}_FILE is empty"
  case "$value" in *"
"*) fail "${name}_FILE must be a single line";; esac
  export "$name=$value"
  unset "${name}_FILE"
done
unset value file present size name
[ "$#" -gt 0 ] || fail "no command given"
exec "$@"
