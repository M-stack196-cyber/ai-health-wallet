"""Read-only SRS v4 / PRD v2 completeness gate.

The DOCX files are authoritative. This checker validates source pins, PRD row
coverage and tracker accounting; it cannot approve requirements or claim release
readiness.
"""
import argparse
import hashlib
import json
import re
from pathlib import Path
from zipfile import ZipFile
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[2]
SRS = 'docs/AI_Health_Wallet_Revised_SRS_v4_0.docx'
PRD = 'docs/AI_Health_Wallet_Module_Wise_PRD_v2_0.docx'
TRACKER = 'docs/PRD_V2_MODULE_DELIVERY_TRACKER.md'
SOURCE_PINS = {
    SRS: '6b4f629fe18dcd3ecb02a61abea2de20e18a380f0dea34f5942e9603d72b2b55',
    PRD: '454a6a2a6c53cbb325cca0e9125da1b1f274506dc0557a8161d1e81fc8339c84',
}
COUNTS = {
    'modules': 18,
    'features': 232,
    'functional_requirements': 55,
    'nonfunctional_requirements': 8,
    'decisions': 22,
    'configurations': 18,
    'acceptance_tests': 14,
    'verification_scenarios': 34,
}
STATUSES = {'IMPLEMENTED', 'PARTIAL', 'MISSING', 'BLOCKED', 'NEEDS_REVERIFICATION'}
NS = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}


class CoverageError(Exception):
    """Raised when the controlled source or tracker is inconsistent."""


def require(condition, code):
    if not condition:
        raise CoverageError(code)


def docx_tables(path):
    with ZipFile(path) as archive:
        info = archive.getinfo('word/document.xml')
        require(info.file_size <= 8_000_000, 'SOURCE_TOO_LARGE')
        document = ET.fromstring(archive.read('word/document.xml'))
    tables = []
    for table in document.findall('.//w:tbl', NS):
        rows = []
        for row in table.findall('./w:tr', NS):
            rows.append([
                ''.join(text.text or '' for text in cell.findall('.//w:t', NS)).strip()
                for cell in row.findall('./w:tc', NS)
            ])
        tables.append(rows)
    return tables


def source_rows(path, header, id_pattern):
    rows = {}
    for table in docx_tables(path):
        if not table or table[0][0] != header:
            continue
        for row in table[1:]:
            if not row or not re.fullmatch(id_pattern, row[0]):
                continue
            require(row[0] not in rows, 'SOURCE_DUPLICATE')
            rows[row[0]] = row
    return rows


def read_tracker(path):
    rows = {}
    for line in path.read_text(encoding='utf-8').splitlines():
        if not re.match(r'^\| M\d{2}-\d{3} \|', line):
            continue
        cells = [cell.strip() for cell in line.split('|')[1:-1]]
        require(len(cells) == 12, 'TRACKER_ROW')
        require(cells[0] not in rows, 'TRACKER_DUPLICATE')
        rows[cells[0]] = cells
    return rows


def validate(root=ROOT):
    """Validate the current v4/v2 documents and tracker."""
    for relative, expected in SOURCE_PINS.items():
        path = root / relative
        require(path.is_file() and not path.is_symlink(), 'SOURCE_MISSING')
        require(hashlib.sha256(path.read_bytes()).hexdigest() == expected, 'SOURCE_CHANGED')

    prd_rows = source_rows(root / PRD, 'PRD ID', r'M\d{2}-\d{3}')
    require(len(prd_rows) == COUNTS['features'], 'SOURCE_COUNT')
    expected_ids = [
        f'M{module:02}-{feature:03}'
        for module in range(1, 19)
        for feature in range(1, 1000)
        if f'M{module:02}-{feature:03}' in prd_rows
    ]
    require(list(prd_rows) == expected_ids, 'FEATURE_IDS')

    register_specs = {
        'FR': ('SRS ID', r'FR-\d{3}', 55),
        'NFR': ('NFR', r'NFR-\d{2}', 8),
        'DEC': ('Decision', r'DEC-\d{2}', 22),
        'CFG': ('CFG', r'CFG-\d{2}', 18),
        'AT': ('Test', r'AT-\d{2}', 14),
        'V': ('Test', r'V-\d{2}', 34),
    }
    for prefix, (header, pattern, expected) in register_specs.items():
        rows = source_rows(root / PRD, header, pattern)
        require(len(rows) == expected, f'{prefix}_COUNT')

    tracker = read_tracker(root / TRACKER)
    require(set(tracker) == set(prd_rows), 'TRACKER_COVERAGE')
    status_counts = {status: 0 for status in STATUSES}
    for feature_id, cells in tracker.items():
        source = prd_rows[feature_id]
        require(cells[1] == source[1] and cells[2] == source[2], 'TRACKER_SOURCE')
        require(cells[6] in STATUSES and cells[6] != 'COMPLETE', 'TRACKER_STATUS')
        require(all(cells[index] for index in (3, 4, 5, 7, 8, 9, 10, 11)), 'TRACKER_EVIDENCE')
        status_counts[cells[6]] += 1
    require(sum(status_counts.values()) == COUNTS['features'], 'TRACKER_COUNT')

    return {
        'schema_version': 2,
        'check': 'prd-v2-completeness',
        'passed': True,
        'counts': COUNTS,
        'status_counts': status_counts,
        'release_complete_modules': 0,
        'production_readiness_claimed': False,
        'source_sha256': SOURCE_PINS,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', required=True)
    parser.parse_args()
    try:
        result = validate()
    except (CoverageError, OSError, ValueError, KeyError, ET.ParseError) as error:
        code = str(error) if isinstance(error, CoverageError) else 'UNREADABLE_OR_INVALID_SOURCE'
        print(json.dumps({'passed': False, 'code': code}, sort_keys=True))
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
