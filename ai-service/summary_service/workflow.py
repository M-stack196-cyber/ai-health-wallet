"""One candidate, no retries/checkpoints. Existing contracts own all grounding."""
import copy
from summary_contracts.validation import (
    validate_summary_input, validate_summary_output, render_summary, canonical_summary_json,
)
from .protocol import expected_recipe

async def generate_summary(raw, context, provider):
    snapshot = validate_summary_input(raw, context)
    recipe = expected_recipe(context['input_sha256'])
    # A provider receives copies; mutation cannot change the acceptance authority.
    candidate = await provider.generate(copy.deepcopy(snapshot), copy.deepcopy(recipe))
    accepted = validate_summary_output(candidate, snapshot, context, recipe)
    render_summary(accepted, snapshot, context, recipe)  # Enforce deterministic render budget too.
    return canonical_summary_json(accepted).encode('utf-8')
