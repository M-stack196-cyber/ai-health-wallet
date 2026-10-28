"""Synthetic ledger-mutation tests; never access services or credentials."""
import copy
import json
import unittest
from pathlib import Path
from unittest.mock import patch
from check_prd import ROOT, LEDGER, validate, CoverageError

class CoverageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.base = json.loads((ROOT / LEDGER).read_text())

    def rejects(self, mutate, code):
        value = copy.deepcopy(self.base)
        mutate(value)
        with self.assertRaisesRegex(CoverageError, '^' + code + '$'):
            validate(value)

    def test_all_exact_source_rows(self):
        self.assertEqual(validate(self.base)['counts']['features'], 127)

    def test_missing_entry(self):
        self.rejects(lambda x: x['modules'][0]['features'].pop(), 'FEATURE_COVERAGE')

    def test_duplicate_entry(self):
        self.rejects(lambda x: x['modules'][0]['features'].append(copy.deepcopy(x['modules'][0]['features'][0])), 'FEATURE_IDS')

    def test_edited_requirement(self):
        self.rejects(lambda x: x['modules'][0]['features'][0].update(requirement='Changed source'), 'SOURCE_TEXT_CHANGED')

    def test_edited_acceptance(self):
        self.rejects(lambda x: x['modules'][0]['features'][0].update(acceptance='Weaker criterion'), 'SOURCE_TEXT_CHANGED')

    def test_wrong_module(self):
        self.rejects(lambda x: x['modules'][0].update(id='M99'), 'MODULES')

    def test_wrong_source_pin(self):
        self.rejects(lambda x: x['source_sha256'].update({'AI_Health_Wallet_Final_SRS_v3.docx':'0'*64}), 'SOURCE_CHANGED')

    def test_missing_phase(self):
        self.rejects(lambda x: x['modules'][0]['features'][0].update(delivery_phases=['B02']), 'PHASE_MAPPING')

    def test_unknown_phase(self):
        self.rejects(lambda x: x['modules'][0]['features'][0].update(delivery_phases=['B99', 'B21']), 'PHASE_MAPPING')

    def test_false_module_completion(self):
        self.rejects(lambda x: x['modules'][0].update(module_complete=True), 'RELEASE_EVIDENCE_REQUIRED')

    def test_false_production_readiness(self):
        self.rejects(lambda x: x['modules'][0]['features'][0]['verification'].update(production_ready=True), 'RELEASE_EVIDENCE_REQUIRED')

    def test_missing_decision(self):
        self.rejects(lambda x: x['registers']['DEC'].pop(), 'REGISTER_CHANGED')

    def test_missing_configuration(self):
        self.rejects(lambda x: x['registers']['CFG'].pop(), 'REGISTER_CHANGED')

    def test_missing_requirement_id(self):
        self.rejects(lambda x: x['registers']['FR'].pop(), 'REGISTER_CHANGED')

    def test_missing_evidence(self):
        self.rejects(lambda x: x['modules'][0]['candidate_evidence_paths'].append('backend/no-such-file.ts'), 'EVIDENCE_PATH')

    def test_module_boundary_cannot_disappear(self):
        self.rejects(lambda x: x['modules'][0]['source_context_paragraphs'].pop(), 'MODULE_CONTEXT')

    def test_verification_scenario_cannot_disappear(self):
        self.rejects(lambda x: x['registers']['V'].pop(), 'REGISTER_CHANGED')

    def test_delivery_completion_needs_acceptance(self):
        self.rejects(lambda x: x['modules'][0]['features'][0].update(delivery_status='COMPLETE'), 'DELIVERY_ACCEPTANCE')

    def test_delivery_status_is_explicit(self):
        self.rejects(lambda x: x['modules'][0]['features'][0].update(delivery_status='looks good'), 'DELIVERY_ACCEPTANCE')

    def test_implementation_mapping_is_required(self):
        self.rejects(lambda x: x['modules'][0]['features'][0].update(existing_implementation={}), 'IMPLEMENTATION_EVIDENCE')

    def test_markdown_cannot_falsely_claim_completion(self):
        read = Path.read_text
        def altered(path, *args, **kwargs):
            text = read(path, *args, **kwargs)
            return text.replace('| PARTIAL |', '| COMPLETE |', 1) if path.name == 'PRD_MODULE_DELIVERY_TRACKER.md' else text
        with patch.object(Path, 'read_text', autospec=True, side_effect=altered):
            with self.assertRaisesRegex(CoverageError, '^TRACKER_STATUS$'):
                validate(self.base)

    def test_markdown_cannot_weaken_requirement(self):
        read = Path.read_text
        def altered(path, *args, **kwargs):
            text = read(path, *args, **kwargs)
            return text.replace(self.base['modules'][0]['features'][0]['requirement'], 'Weaker requirement', 1) if path.name == 'PRD_MODULE_DELIVERY_TRACKER.md' else text
        with patch.object(Path, 'read_text', autospec=True, side_effect=altered):
            with self.assertRaisesRegex(CoverageError, '^TRACKER_TEXT$'):
                validate(self.base)

    def test_counts_not_blessed_by_edit(self):
        self.rejects(lambda x: x['counts'].update(features=126), 'COUNTS')

if __name__ == '__main__':
    unittest.main()
