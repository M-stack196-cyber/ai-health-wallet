"""Tests for the read-only SRS v4 / PRD v2 completeness gate."""
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from check_prd import ROOT, TRACKER, validate, CoverageError


class CoverageTests(unittest.TestCase):
    def copy_sources(self, root):
        (root / 'docs').mkdir()
        for relative in (
            'docs/AI_Health_Wallet_Revised_SRS_v4_0.docx',
            'docs/AI_Health_Wallet_Module_Wise_PRD_v2_0.docx',
        ):
            destination = root / relative
            destination.write_bytes((ROOT / relative).read_bytes())
        tracker = root / TRACKER
        tracker.parent.mkdir(parents=True, exist_ok=True)
        tracker.write_text((ROOT / TRACKER).read_text(encoding='utf-8'), encoding='utf-8')

    def test_current_sources_and_tracker_pass(self):
        result = validate()
        self.assertTrue(result['passed'])
        self.assertEqual(result['counts']['features'], 232)
        self.assertEqual(result['status_counts'], {
            'IMPLEMENTED': 115,
            'PARTIAL': 78,
            'MISSING': 14,
            'BLOCKED': 19,
            'NEEDS_REVERIFICATION': 6,
        })

    def test_source_change_is_rejected(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            self.copy_sources(root)
            source = root / 'docs/AI_Health_Wallet_Revised_SRS_v4_0.docx'
            source.write_bytes(source.read_bytes() + b'changed')
            with self.assertRaisesRegex(CoverageError, '^SOURCE_CHANGED$'):
                validate(root=root)

    def test_tracker_requirement_text_cannot_drift(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            self.copy_sources(root)
            tracker = root / TRACKER
            text = tracker.read_text(encoding='utf-8')
            tracker.write_text(text.replace(
                '| M01-001 | The system shall support patient account registration. |',
                '| M01-001 | Changed requirement. |',
                1,
            ), encoding='utf-8')
            with self.assertRaisesRegex(CoverageError, '^TRACKER_SOURCE$'):
                validate(root=root)

    def test_complete_status_is_rejected(self):
        tracker = ROOT / TRACKER
        original = tracker.read_text(encoding='utf-8')
        try:
            mutated = '\n'.join(
                line.replace('| IMPLEMENTED |', '| COMPLETE |', 1)
                if line.startswith('| M01-001 |') else line
                for line in original.splitlines()
            ) + '\n'
            tracker.write_text(mutated, encoding='utf-8')
            with self.assertRaisesRegex(CoverageError, '^TRACKER_STATUS$'):
                validate()
        finally:
            tracker.write_text(original, encoding='utf-8')


if __name__ == '__main__':
    unittest.main()
