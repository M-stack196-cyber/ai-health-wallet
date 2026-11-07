#!/usr/bin/env bash
# Shows the synthetic mailbox (verification and doctor codes). Messages are synthetic and memory-only.
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
curl -fsS --max-time 5 http://127.0.0.1:8026/messages | python3 -c 'import json,sys
for m in json.load(sys.stdin): print("To:",m["to"],"| Subject:",m["subject"]); print(m["text"]); print("-"*40)'
