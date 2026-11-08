#!/usr/bin/env bash
# Creates a REAL doctor share for the Doctor Web Portal demo, through the normal patient API (no database writes by hand).
# Usage: ./local-stack/demo-share.sh [--print]
#   It registers a new synthetic patient, verifies the email through the synthetic mailbox, uploads the sample digital report,
#   waits for processing, indexes the record for questions (RAG), and creates a link share bound to doctor-demo@example.invalid with the patient's own session.
#   The share link is a bearer token, so it is written to an owner-only file; --print also shows it in this terminal.
# Needs the stack running (./local-stack/up.sh) and the sample files (./local-stack/seed-demo.sh). Local, synthetic data only.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
PRINT=0
for arg in "$@"; do
  case "$arg" in
    --print) PRINT=1 ;;
    *) die "Unknown option: $arg (use --print)" ;;
  esac
done
load_env
[ "${NODE_ENV:-}" = "development" ] && [ "${HW_LOCAL_STACK:-}" = "1" ] || die "Local stack environment required."
DOCTOR_EMAIL="doctor-demo@example.invalid"
SAMPLE="$HW_STACK_HOME/samples/sample-digital-report.pdf"
[ -f "$SAMPLE" ] || die "Sample file missing. Run ./local-stack/seed-demo.sh first."
curl -fsS -o /dev/null --max-time 5 http://127.0.0.1:5000/api/v1/health || die "The backend is not running. Run ./local-stack/up.sh first."
curl -fsS -o /dev/null --max-time 5 http://127.0.0.1:8026/messages || die "The synthetic mailbox is not running. Run ./local-stack/up.sh first."
OUT="$RUN/demo-share.txt"
HW_DOCTOR_EMAIL="$DOCTOR_EMAIL" HW_SAMPLE="$SAMPLE" HW_OUT="$OUT" HW_PRINT="$PRINT" python3 - <<'PY'
import json, os, re, secrets, sys, time, urllib.request, urllib.error, uuid

API = "http://127.0.0.1:5000/api/v1"
MAIL = "http://127.0.0.1:8026/messages"
doctor, sample, out, show = os.environ["HW_DOCTOR_EMAIL"], os.environ["HW_SAMPLE"], os.environ["HW_OUT"], os.environ["HW_PRINT"] == "1"
if not doctor.endswith("@example.invalid"):
    sys.exit("ERROR: the doctor email must end in @example.invalid (the synthetic mailbox accepts nothing else).")

def call(path, body=None, token=None, form=None):
    headers = {}
    if token: headers["Authorization"] = "Bearer " + token
    data = None
    if body is not None: data = json.dumps(body).encode(); headers["Content-Type"] = "application/json"
    if form is not None: data, headers["Content-Type"] = form
    request = urllib.request.Request(API + path, data=data, headers=headers, method="POST" if data is not None else "GET")
    try:
        with urllib.request.urlopen(request, timeout=60) as response: return response.status, response.read()
    except urllib.error.HTTPError as error: return error.code, error.read()

def payload(raw):
    try:
        value = json.loads(raw)
        return value.get("data", value) if isinstance(value, dict) else {}
    except Exception: return {}

def step(label, status, ok=(200, 201, 202)):
    if status not in ok: sys.exit("ERROR: " + label + " failed (HTTP " + str(status) + "). Is the stack healthy? See ~/.local/share/hw-local-stack/logs.")
    print("  ok: " + label)

patient = "demo-share-" + secrets.token_hex(4) + "@example.invalid"
password = "Demo-" + secrets.token_hex(12) + "-aA1!"   # synthetic, never printed or saved
print("Creating a synthetic patient and a real share for " + doctor)
status, _ = call("/auth/register", {"full_name": "Demo Share Patient (synthetic)", "email": patient, "password": password, "date_of_birth": "2000-01-01", "sex_gender": "prefer_not_to_say"})
step("registered", status)
code = None
for _ in range(45):
    messages = json.load(urllib.request.urlopen(MAIL, timeout=10))
    mine = [m for m in messages if m["to"] == patient]
    if mine:
        found = re.search(r"[a-f0-9-]{36}\.[a-f0-9]{64}", mine[-1]["text"])
        if found: code = found.group(0); break
    time.sleep(1)
if not code: sys.exit("ERROR: the verification email did not arrive. Is the worker running? (./local-stack/up.sh)")
status, _ = call("/auth/verify-email", {"token": code}); step("email verified through the synthetic mailbox", status)
status, raw = call("/auth/login", {"email": patient, "password": password}); step("signed in", status)
access = payload(raw)["access_token"]

boundary = uuid.uuid4().hex
pdf = open(sample, "rb").read()
parts = [("--%s\r\nContent-Disposition: form-data; name=\"%s\"\r\n\r\n%s\r\n" % (boundary, k, v)).encode()
         for k, v in (("category", "lab_report"), ("hospital_name", "Synthetic Hospital"), ("document_date", "2026-02-03"))]
parts.append(("--%s\r\nContent-Disposition: form-data; name=\"file\"; filename=\"sample-digital-report.pdf\"\r\nContent-Type: application/pdf\r\n\r\n" % boundary).encode() + pdf + b"\r\n")
parts.append(("--%s--\r\n" % boundary).encode())
status, raw = call("/documents", token=access, form=(b"".join(parts), "multipart/form-data; boundary=" + boundary)); step("sample report uploaded", status)
document = payload(raw)["document"]["id"]

state = ""
for _ in range(60):
    status, raw = call("/documents/" + document + "/processing", token=access)
    info = payload(raw).get("processing", {}) if status == 200 else {}
    state = info.get("state") or info.get("status") or ""
    if state in ("completed", "failed"): break
    time.sleep(2)
if state != "completed": sys.exit("ERROR: processing did not complete (last state: " + (state or "unknown") + "). Is the worker running?")
print("  ok: processing completed")

# Index the processed text for record questions (the patient's own session, the normal route). Without this step RAG answers
# "insufficient evidence", because nothing else in the stack indexes documents.
status, raw = call("/documents/" + document + "/rag-index", {}, token=access)
step("record indexed for questions (RAG)", status)
indexed = (json.loads(raw).get("result") or {}).get("indexed_chunks", 0)
if not indexed: sys.exit("ERROR: indexing returned no chunks. Is the RAG service running? (./local-stack/up.sh)")
print("      " + str(indexed) + " chunk(s) indexed")

status, raw = call("/sharing/grants", {"document_ids": [document], "share_type": "unique_link", "doctor_email": doctor}, token=access)
step("share created for " + doctor, status)
share = json.loads(raw)
url, expires = share["share_url"], share["grant"]["expires_at"]
descriptor = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(descriptor, "w") as handle:
    handle.write("SYNTHETIC DEMO SHARE (local only; the link is a bearer token, keep this file private)\n"
                 "doctor email : " + doctor + "\npatient email: " + patient + "\nexpires      : " + expires + "\nshare link   : " + url + "\n")
os.chmod(out, 0o600)
print("\nDone. The share is bound to " + doctor + " and expires " + expires + ".")
print("Share link saved to the owner-only file: " + out)
if show: print("Share link: " + url)
print("""
Next, in your browser:
  1. Open the share link (cat the file above; or run this script with --print to create a new share and show its link).
     It opens the Doctor Web Portal at http://127.0.0.1:5173
  2. Enter the doctor email """ + doctor + """ and any name, then request the code.
  3. Read the one-time code with:  ./local-stack/mailbox.sh
  4. Enter the code in the portal. You will see the one shared record.""")
PY
