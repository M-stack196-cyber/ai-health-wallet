"""Read-only PRD completeness gate. Standard library only; no service access.

The pinned DOCX documents remain authoritative. This tool cannot approve features,
regenerate the ledger, infer clinical truth, or turn isolated checks into release proof.
"""
import argparse
import hashlib
import html
import json
from pathlib import Path
import re
from zipfile import ZipFile
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[2]
LEDGER = 'docs/baselines/PRD_MODULE_DELIVERY.json'
NS = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
COUNTS = {'modules': 16, 'features': 127, 'functional_requirements': 36,
          'nonfunctional_requirements': 8, 'decisions': 12, 'configurations': 14}
SOURCE_NAMES = {'AI_Health_Wallet_Module_Wise_PRD_v1_0.docx',
                'AI_Health_Wallet_Final_SRS_v3.docx'}

class CoverageError(Exception):
    def __init__(self, code):
        super().__init__(code)

def require(condition, code):
    if not condition:
        raise CoverageError(code)

def read_source(path):
    with ZipFile(path) as archive:
        require(archive.getinfo('word/document.xml').file_size <= 4_000_000, 'SOURCE_TOO_LARGE')
        document = ET.fromstring(archive.read('word/document.xml'))
    def text(cell):
        return '\n'.join(''.join(t.text or '' for t in p.findall('.//w:t', NS))
                         for p in cell.findall('.//w:p', NS))
    tables = [[[text(c) for c in row.findall('./w:tc', NS)]
               for row in table.findall('./w:tr', NS)] for table in document.findall('.//w:tbl', NS)]
    paragraphs = [''.join(t.text or '' for t in p.findall('.//w:t', NS))
                  for p in document.findall('.//w:p', NS)]
    rows = [c for table in tables for c in table if c and
            re.fullmatch(r'PRD-M\d{2}-\d{2}\s*(BASELINE|CONTROL)', c[0])]
    return rows, tables, paragraphs

def validate(ledger, root=ROOT):
    require(ledger.get('schema_version') == 1 and ledger.get('kind') == 'prd-module-delivery-checklist', 'SCHEMA')
    require(ledger.get('counts') == COUNTS, 'COUNTS')
    pins = ledger.get('source_sha256', {})
    require(set(pins) == SOURCE_NAMES, 'SOURCE_PINS')
    for name, pin in pins.items():
        path = root / 'docs' / name
        require(path.is_file() and not path.is_symlink(), 'SOURCE_MISSING')
        require(re.fullmatch(r'[a-f0-9]{64}', pin) and
                hashlib.sha256(path.read_bytes()).hexdigest() == pin, 'SOURCE_CHANGED')
    rows, tables, paragraphs = read_source(root / 'docs/AI_Health_Wallet_Module_Wise_PRD_v1_0.docx')
    source = {}
    for c in rows:
        require(len(c) == 4, 'SOURCE_ROW')
        fid, kind = re.fullmatch(r'(PRD-M\d{2}-\d{2})\s*(BASELINE|CONTROL)', c[0]).groups()
        require(fid not in source, 'SOURCE_DUPLICATE')
        source[fid] = (kind, c[1], c[2], c[3])
    require(len(source) == 127, 'SOURCE_COUNT')
    modules = ledger.get('modules', [])
    require([m['id'] for m in modules] == [f'M{k:02}' for k in range(1, 17)], 'MODULES')
    titles = [p[4:] for p in paragraphs if re.match(r'^\d{2}  ', p)][:16]
    require([m['title'] for m in modules] == titles, 'MODULE_TITLES')
    contexts = []
    current = None
    # Top-level paragraphs retain purpose, actors, dependencies, boundary and
    # exit demonstration. Table feature rows are compared separately below.
    with ZipFile(root / 'docs/AI_Health_Wallet_Module_Wise_PRD_v1_0.docx') as archive:
        body = ET.fromstring(archive.read('word/document.xml')).find('w:body', NS)
    for element in body:
        if element.tag.endswith('}p'):
            text = ''.join(t.text or '' for t in element.findall('.//w:t', NS))
            if re.match(r'^\d{2}  ', text):
                current = [] if len(contexts) < 16 else None
                if current is not None:
                    contexts.append(current)
            if current is not None:
                current.append(text)
    require([m.get('source_context_paragraphs') for m in modules] == contexts, 'MODULE_CONTEXT')
    tracker = (root / 'docs/PRD_MODULE_DELIVERY_TRACKER.md').read_text(encoding='utf-8')
    tracked_ids = re.findall(r'^\| (PRD-M[0-9]{2}-[0-9]{2}) \|', tracker, re.M)
    require(len(tracked_ids) == 127 and len(set(tracked_ids)) == 127 and set(tracked_ids) == set(source), 'TRACKER_COVERAGE')
    tracker_rows = {re.split(r'(?<!\\)\|', line)[1].strip(): [c.strip() for c in re.split(r'(?<!\\)\|', line)[1:-1]] for line in tracker.splitlines() if re.match(r'^\| PRD-M[0-9]{2}-[0-9]{2} \|', line)}
    found = set()
    states = {k: 0 for k in ['Implemented', 'Partially Implemented', 'Missing', 'Unknown']}
    for module in modules:
        require(isinstance(module['module_complete'], bool), 'MODULE_COMPLETE')
        require(bool(module['features']), 'EMPTY_MODULE')
        for evidence in module['candidate_evidence_paths']:
            relative = Path(evidence)
            require(not relative.is_absolute() and '..' not in relative.parts and
                    (root / relative).exists(), 'EVIDENCE_PATH')
        for feature in module['features']:
            fid = feature['id']
            require(fid not in found and fid in source and fid.startswith('PRD-' + module['id'] + '-'), 'FEATURE_IDS')
            found.add(fid)
            require(tuple(feature[k] for k in ['kind', 'requirement', 'acceptance', 'source_references']) == source[fid], 'SOURCE_TEXT_CHANGED')
            require(feature.get('delivery_status') in {'COMPLETE', 'PARTIAL', 'MISSING', 'BLOCKED'} and feature.get('final_acceptance_status') == 'OPEN' and feature['delivery_status'] != 'COMPLETE', 'DELIVERY_ACCEPTANCE')
            require(isinstance(feature.get('existing_implementation'), dict) and bool(feature['existing_implementation'].get('paths')), 'IMPLEMENTATION_EVIDENCE')
            cells = tracker_rows[fid]
            require(len(cells) == 8 and cells[3] == feature['delivery_status'] and cells[7] == feature['final_acceptance_status'], 'TRACKER_STATUS')
            escaped = lambda value: html.escape(value, quote=False).replace('|', '\\|').replace('\n', ' ')
            require(cells[1] == escaped(feature['requirement']) and cells[2] == escaped(feature['source_references']), 'TRACKER_TEXT')
            status = feature['implementation_status']
            require(status in states, 'STATUS')
            states[status] += 1
            phases = feature['delivery_phases']
            require(phases and 'B21' in phases and all(re.fullmatch(r'B(?:0[1-9]|1[0-9]|2[01])', p) for p in phases)
                    and len(phases) == len(set(phases)), 'PHASE_MAPPING')
            require(bool(feature['remaining_gap']) and bool(feature['status_scope']), 'SCOPE_OR_GAP')
            v = feature['verification']
            require(set(v) == {'unit', 'integration', 'end_to_end', 'live_service', 'production_ready'}
                    and isinstance(v['production_ready'], bool), 'VERIFICATION')
            # This initial checklist has no signed final release evidence. It must
            # not certify completion by merely toggling a status or test flag.
            require(not v['production_ready'] and not module['module_complete'], 'RELEASE_EVIDENCE_REQUIRED')
    require(found == set(source), 'FEATURE_COVERAGE')
    for prefix, count in [('FR', 36), ('NFR', 8), ('DEC', 12), ('CFG', 14), ('AT', 14), ('V', 24)]:
        actual = [c for table in tables for c in table if c and re.fullmatch(prefix + r'-\d{2,3}', c[0])]
        require(ledger['registers'].get(prefix) == actual and len(actual) == count, 'REGISTER_CHANGED')
        width = 3 if prefix == 'FR' else 2
        require({c[0] for c in actual} == {f'{prefix}-{i:0{width}}' for i in range(1, count + 1)}, 'REGISTER_IDS')
    return {'schema_version': 1, 'check': 'prd-completeness', 'passed': True,
            'counts': COUNTS, 'code_coverage_labels': states,
            'release_complete_modules': 0, 'production_readiness_claimed': False,
            'source_sha256': pins}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', required=True)
    args = parser.parse_args()
    try:
        result = validate(json.loads((ROOT / LEDGER).read_text(encoding='utf-8')))
        print(json.dumps(result, sort_keys=True))
    except (CoverageError, OSError, ValueError, KeyError, TypeError, ET.ParseError) as error:
        code = str(error) if isinstance(error, CoverageError) else 'UNREADABLE_OR_INVALID_CHECKLIST'
        print(json.dumps({'passed': False, 'code': code}))
        return 1
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
