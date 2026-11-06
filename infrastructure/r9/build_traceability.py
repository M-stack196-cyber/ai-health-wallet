#!/usr/bin/env python3
"""R9: build docs/R9_REQUIREMENTS_TRACEABILITY_MATRIX.md from SRS v4.0 and the delivery tracker.

Reads only repository documents (no database, no network). Run from the repository root:
    python3 infrastructure/r9/build_traceability.py          (write)
    python3 infrastructure/r9/build_traceability.py --check  (fail if the file is out of date)
It stops with an error if the SRS registers do not have the expected sizes, so a silent skip is not possible.
"""
import re, sys, zipfile, collections, pathlib

ROOT = pathlib.Path(__file__).resolve().parents[2]
SRS = ROOT / "docs/AI_Health_Wallet_Revised_SRS_v4_0.docx"
TRACKER = ROOT / "docs/PRD_V2_MODULE_DELIVERY_TRACKER.md"
OUT = ROOT / "docs/R9_REQUIREMENTS_TRACEABILITY_MATRIX.md"
ORDER = ["BLOCKED", "MISSING", "NEEDS_REVERIFICATION", "PARTIAL", "IMPLEMENTED"]  # worst first
SHORT = {"IMPLEMENTED": "I", "PARTIAL": "P", "MISSING": "M", "BLOCKED": "B", "NEEDS_REVERIFICATION": "N"}

# V-01..V-34 verdicts. VERIFIED_LOCAL = the cited synthetic tests exist and were run; it is never release acceptance.
V = {
 "V-01": ("VERIFIED_LOCAL", "identity-security tests (registration, login, profile, cross-patient isolation); P8-API-01; R4-02; R4-03; R9-V23-01", "Real mailbox and device sign-in not tested."),
 "V-02": ("PARTIAL", "identity-security cross-patient isolation test; P2-10; P2-16; P5-10; R4-03", "Another patient's S3 object was not tried against real S3 (storage is a synthetic map in tests)."),
 "V-03": ("PARTIAL", "P2-13; M03-13; P8-API-03; R9-V23-01", "Real S3 and the device file picker are not tested."),
 "V-04": ("VERIFIED_LOCAL", "P2-14; M03-14; P2-22", "Backend validation only; client messages covered by workflows.test.tsx."),
 "V-05": ("PARTIAL", "P3-07; R9-V23-01 (real Tesseract and PDF text)", "OCR accuracy on realistic reports is not measured."),
 "V-06": ("VERIFIED_LOCAL", "P3-09; P3-12; P3-13; M03-24; M03-26; M03-27; P4-04", "Failures are simulated; no live OCR or AI outage."),
 "V-07": ("VERIFIED_LOCAL", "P3-02; P8-API-03", ""),
 "V-08": ("VERIFIED_LOCAL", "P3-03; P8-API-03", ""),
 "V-09": ("PARTIAL", "P4-01; P4-03; P4-05; R9-V23-01", "Synthetic summary recipe only; no approved model, CFG-01 and clinical review open."),
 "V-10": ("PARTIAL", "P5-02; P5-03; P5-10; R6-01; R6-04; R9-V23-01", "Synthetic-offline RAG provider only; no approved model."),
 "V-11": ("PARTIAL", "P4-03; P5-04", "Document text stays inert with the synthetic provider; a real model was not tried."),
 "V-12": ("VERIFIED_LOCAL", "P6-02; P8-API-06", ""),
 "V-13": ("VERIFIED_LOCAL", "P6-03; P6-04; R4-10", "Real email delivery not tested."),
 "V-14": ("VERIFIED_LOCAL", "P6-06; P6-08; P6-11; P8-API-04; R9-V23-01", ""),
 "V-15": ("VERIFIED_LOCAL", "P6-05; P8-API-04; R9-V23-01", ""),
 "V-16": ("PARTIAL", "P7-02; R5-07; R9-V23-01", "Synthetic provider only; a real email provider is not approved."),
 "V-17": ("BLOCKED", "P7-09; P7-10; R6-06; R6-07", "Only the synthetic demo rule exists. No clinically reviewed serious rule is approved (CFG-06)."),
 "V-18": ("PARTIAL", "P7-01; P7-10; R6-08; R6-09", "Indeterminate results are never alerts or normal. The approved indeterminate handling (CFG-07) is open."),
 "V-19": ("PARTIAL", "R3-01; R3-04; R6-02", "Fixed notice and reply checks tested with the synthetic provider; a real model refusal is not tested."),
 "V-20": ("BLOCKED", "R7-01; R7-03; R7-04 (local readiness checks only)", "No AWS account or IAM role name. Nothing is deployed."),
 "V-21": ("PARTIAL", "R7-07; R7-08; R7-09", "Local backup and restore drill passed on a fresh disposable database. RDS backups and recovery objectives are not tested."),
 "V-22": ("PARTIAL", "R8-BUILD-01..04 (the admin build runs from the same generated test as R8-BUILD-04); R8-WEB-01; R8-ADMIN-WEB-01; R8-MOBILE-A11Y; R8-PERF-01", "CFG-10 thresholds are not approved; no devices, screen reader, usability sessions or load test."),
 "V-23": ("PARTIAL", "R9-V23-01", "The chain passed locally through the real HTTP routes with synthetic email, storage, model and rule. Not run on a deployed stack, from the clients, or with real providers."),
 "V-24": ("VERIFIED_LOCAL", "this matrix; R9-TRACE-01..05", "Every requirement shows its tracker rows or a recorded blocker. Many rows are still PARTIAL or BLOCKED by design."),
 "V-25": ("VERIFIED_LOCAL", "identity-security tests (verification, logout, expiry, refresh, reset, invalidation); R4-05; R4-09", "Real email provider not tested."),
 "V-26": ("VERIFIED_LOCAL", "P2-02; P2-03; P2-05; P2-06; P2-07; P2-08; P8-API-02", ""),
 "V-27": ("PARTIAL", "P7-02; P7-09; P7-15; R9-V23-01", "Synthetic provider and demo rule only."),
 "V-28": ("PARTIAL", "P3-04; P3-10; P4-06; P5-05", "Access ends and derived data is hidden. Physical erasure and retention durations are not set (CFG-12, CFG-18)."),
 "V-29": ("PARTIAL", "R2-01; R2-02; R2-03; R2-05; R2-08", "The request and immediate access end work. The scheduled deletion and erasure are blocked on retention and legal approval."),
 "V-30": ("PARTIAL", "R6-01; R6-04; R6-05; P5-02; P5-03", "Synthetic-offline provider only."),
 "V-31": ("VERIFIED_LOCAL", "P8-API-04; P6-05; P6-06; P6-08; P8-API-06", ""),
 "V-32": ("VERIFIED_LOCAL", "P9-04; P9-06; P9-08; P9-12; P9-19; R4-04; R2-09", "Role names and permissions still need CFG-17 approval."),
 "V-33": ("BLOCKED", "P9-13; P9-21; P9-23", "The default denial is tested. Exceptional minimum-scope support access is not built (CFG-17)."),
 "V-34": ("VERIFIED_LOCAL", "P9-22..P9-27; P9-33..P9-39; P9-40; P9-42", "CFG-17 approval of roles is still open."),
}

def srs_registers():
    x = zipfile.ZipFile(SRS).read("word/document.xml").decode()
    out = {}
    for row in re.findall(r"<w:tr[ >].*?</w:tr>", x, flags=re.S):
        cells = [re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", c)).strip() for c in re.findall(r"<w:tc>.*?</w:tc>", row, flags=re.S)]
        if cells and re.fullmatch(r"(FR-\d{3}|NFR-\d{2}|DEC-\d{2}|V-\d{2}|AT-\d{2}|CFG-\d{2})", cells[0]) and cells[0] not in out:
            out[cells[0]] = cells[1:]
    return out

def tracker():
    lines = TRACKER.read_text().split("\n")
    rows, inherited, module = {}, {}, None
    for l in lines:
        m = re.match(r"## (M\d\d) ", l)
        if m: module = m.group(1)
        m = re.match(r"Inherited SRS context \(.*?\): (.*)", l)
        if m and module: inherited[module] = set(re.findall(r"(?:FR|NFR|DEC|CFG|AT|V)-\d+", m.group(1)))
        if re.match(r"\| M\d\d-\d+ \|", l):
            c = [x.strip() for x in l.strip().strip("|").split(" | ")]
            rows[c[0]] = {"module": c[0][:3], "text": c[1], "src": c[2], "status": c[6]}
    return rows, inherited

def rollup(statuses):
    return next((s for s in ORDER if s in statuses), "NONE")

def main():
    reg = srs_registers()
    want = {"FR": 55, "NFR": 8, "DEC": 22, "V": 34, "AT": 14, "CFG": 18}
    have = collections.Counter(k.split("-")[0] for k in reg)
    if dict(have) != want: sys.exit(f"SRS register sizes differ from expected: {dict(have)} vs {want}")
    rows, inherited = tracker()
    if len(rows) != 232: sys.exit(f"tracker has {len(rows)} rows, expected 232")
    direct = collections.defaultdict(list)
    for rid, r in rows.items():
        for ref in set(re.findall(r"(?:FR|NFR|DEC|CFG|AT|V)-\d+", r["src"])): direct[ref].append(rid)
    inherits = collections.defaultdict(list)
    for mod, ids in inherited.items():
        for ref in ids: inherits[ref].append(mod)
    counts = collections.Counter(r["status"] for r in rows.values())
    per = collections.defaultdict(collections.Counter)
    for rid, r in rows.items(): per[r["module"]][r["status"]] += 1

    o = []
    o.append("# R9 requirements traceability matrix\n")
    o.append("Generated by `python3 infrastructure/r9/build_traceability.py` from SRS v4.0 (`docs/AI_Health_Wallet_Revised_SRS_v4_0.docx`) and `docs/PRD_V2_MODULE_DELIVERY_TRACKER.md`. Do not edit by hand; change the tracker or the script and run it again. `backend/src/r9/traceability.test.ts` checks this file against the tracker.\n")
    o.append("## How to read this\n")
    o.append("- **Roll-up** is the worst status of the PRD rows that cite the requirement (order: BLOCKED, MISSING, NEEDS_REVERIFICATION, PARTIAL, IMPLEMENTED). A roll-up of IMPLEMENTED means backend/process scope with local synthetic evidence, as the tracker defines it. It is never release acceptance.")
    o.append("- **Direct** rows cite the requirement in their own Source mapping. **Inherited** means no row cites it, but the module's inherited-context line does (the tracker's own rule). Nothing is left without one of the two.")
    o.append("- **V verdicts**: VERIFIED_LOCAL = the cited synthetic tests exist and passed on the local disposable stack. PARTIAL = part of the expected result is proven and the rest is named. BLOCKED = the expected result needs an approval or resource that does not exist. None of these means accepted for release.\n")
    o.append("## A. Count reconciliation\n")
    o.append(f"- SRS v4.0 registers read from the document: FR {have['FR']}, NFR {have['NFR']}, DEC {have['DEC']}, V {have['V']}, AT {have['AT']}, CFG {have['CFG']}.")
    o.append(f"- PRD rows read from the tracker: {len(rows)} across {len(per)} modules.")
    o.append("- Status counts derived from the rows: " + ", ".join(f"{s}={counts.get(s,0)}" for s in ORDER[::-1]) + f" (sum {sum(counts.values())}).")
    o.append("- The tracker header and module table must equal these numbers; `R9-TRACE-02` fails if they do not.\n")
    o.append("| Module | Rows | IMPLEMENTED | PARTIAL | MISSING | BLOCKED | NEEDS_REVERIFICATION |\n| --- | --- | --- | --- | --- | --- | --- |")
    for m in sorted(per):
        c = per[m]
        o.append(f"| {m} | {sum(c.values())} | {c['IMPLEMENTED']} | {c['PARTIAL']} | {c['MISSING']} | {c['BLOCKED']} | {c['NEEDS_REVERIFICATION']} |")
    o.append("")

    def section(title, prefix, ids, textcol):
        o.append(f"## {title}\n")
        o.append("| ID | SRS v4.0 text | Roll-up | Direct PRD rows (I/P/M/B/N) | Inherited from |\n| --- | --- | --- | --- | --- |")
        summary = collections.Counter()
        for i in ids:
            t = reg[i][textcol].replace("|", "/")
            t = t if len(t) <= 150 else t[:147] + "..."
            d = sorted(direct.get(i, []))
            if d:
                roll = rollup({rows[r]["status"] for r in d})
                cell = " ".join(f"{r}:{SHORT[rows[r]['status']]}" for r in d)
                inh = ""
            else:
                mods = sorted(inherits.get(i, []))
                if not mods: sys.exit(f"{i} has neither a direct row nor an inherited module")
                roll = rollup({rows[r]["status"] for r in rows if rows[r]["module"] in mods})
                roll = roll + " (module level)"
                cell = "none"
                inh = ", ".join(mods)
            summary[roll.split(" ")[0]] += 1
            o.append(f"| {i} | {t} | {roll} | {cell} | {inh} |")
        o.append("")
        o.append(f"Roll-up count for {prefix}: " + ", ".join(f"{s}={summary.get(s,0)}" for s in ORDER[::-1]) + ".\n")

    section("B. Functional requirements FR-001 to FR-055", "FR", [f"FR-{i:03d}" for i in range(1, 56)], 0)
    section("C. Non-functional requirements NFR-01 to NFR-08", "NFR", [f"NFR-{i:02d}" for i in range(1, 9)], 1)
    section("D. Decisions DEC-01 to DEC-22", "DEC", [f"DEC-{i:02d}" for i in range(1, 23)], 0)

    o.append("## E. Verification scenarios V-01 to V-34\n")
    o.append("Test IDs below are the titles' first token in the backend, frontend and AI test files. `R9-TRACE-04` fails if a cited ID cannot be found in the repository.\n")
    o.append("| ID | Scenario (SRS v4.0) | Verdict | Tests cited | What is not proven |\n| --- | --- | --- | --- | --- |")
    vc = collections.Counter()
    for i in [f"V-{n:02d}" for n in range(1, 35)]:
        verdict, tests, gap = V[i]
        vc[verdict] += 1
        o.append(f"| {i} | {reg[i][0].replace('|','/')} | {verdict} | {tests} | {gap or '-'} |")
    o.append("")
    o.append("V verdict count: " + ", ".join(f"{k}={vc[k]}" for k in ["VERIFIED_LOCAL", "PARTIAL", "BLOCKED"]) + ".\n")
    text = "\n".join(o) + "\n"
    if "--check" in sys.argv:
        if not OUT.exists() or OUT.read_text() != text: sys.exit("docs/R9_REQUIREMENTS_TRACEABILITY_MATRIX.md is out of date; run the script again")
        print("matrix is current"); return
    OUT.write_text(text)
    print("wrote", OUT.relative_to(ROOT), "| rows", len(rows), "| counts", dict(counts))

main()
