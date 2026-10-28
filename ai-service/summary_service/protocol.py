"""Versioned fake-service recipe; no credentials, provider SDKs or persistence."""
import hashlib
PATH = '/internal/v1/report-summaries:generate'
PROMPT_SHA256 = hashlib.sha256(b'health-wallet-summary-fake-extractive-v1').hexdigest()
CONTEXT_HEADERS = {
    'request_id': 'x-summary-request-id',
    'source_ref': 'x-summary-source-ref',
    'scope_token': 'x-summary-scope-token',
    'input_sha256': 'x-summary-input-sha256',
}
def expected_recipe(input_sha256):
    return {'schema_version': 1, 'input_sha256': input_sha256,
            'pipeline_version': 'summary-contract-v1', 'prompt_sha256': PROMPT_SHA256,
            'provider': 'synthetic-fake', 'model_id': 'extractive-fixture', 'model_revision': '1'}
