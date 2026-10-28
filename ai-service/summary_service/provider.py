"""Cooperative async provider port. No database/job/storage capability is supplied."""
import copy
from typing import Protocol
from summary_contracts.types import SummaryInputV1, SummaryProvenanceV1
from summary_contracts.validation import expected_metadata

class ModelProvider(Protocol):
    async def generate(self, source: SummaryInputV1, recipe: SummaryProvenanceV1) -> object:
        """Return an untrusted candidate. Must cooperate with asyncio cancellation."""
        ...

class DeterministicFakeProvider:
    async def generate(self, source, recipe):
        facts = copy.deepcopy(source['facts'])
        meta = expected_metadata(source, facts)
        return {'schema_version': 1, 'kind': 'medical-summary-output',
                'scope': copy.deepcopy(source['scope']), 'reported_findings': facts,
                'educational_explanations': meta['terms'],
                'uncertainty': {k: meta[k] for k in ['codes', 'fact_ids']},
                'catalogue_coverage': 'all_catalogued', 'provenance': copy.deepcopy(recipe)}
