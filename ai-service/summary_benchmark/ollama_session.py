"""Explicit synthetic-only bridge. No CLI, environment enablement or live startup."""
import asyncio
import copy
import hashlib
from dataclasses import asdict
from pathlib import Path

from summary_evaluation.evaluator import evaluate, VERSION as EVALUATOR_VERSION
from summary_evaluation.runner import write_receipt
from .contracts import fingerprint, BenchmarkRequest, BenchmarkReply
from .preparation import DATA, load_frozen, evaluator_identity
from .ollama_local import OllamaLocalProvider, LocalRefusal, trusted_recipe
from .ollama_http import LoopbackHttpTransport


class OllamaBenchmarkBridge:
    """Existing BenchmarkProvider port; explicit identity/configuration binding."""
    def __init__(self, provider, *, enabled=False):
        if type(provider) is not OllamaLocalProvider or type(enabled) is not bool:
            raise LocalRefusal()
        self.provider, self.enabled = provider, enabled

    async def generate(self, request):
        if not self.enabled: raise LocalRefusal('DISABLED')
        if (type(request) is not BenchmarkRequest or request.identity != self.provider.identity
            or request.settings != self.provider.settings
            or request.max_output_tokens != self.provider.policy.num_predict
            or request.prompt != (DATA / 'prompt-v1.txt').read_text()):
            raise LocalRefusal('IDENTITY_MISMATCH')
        candidate = await self.provider.generate(copy.deepcopy(request.source), copy.deepcopy(request.provenance))
        usage = self.provider.last_usage
        if usage is None: raise LocalRefusal('RESPONSE_REFUSED')
        return BenchmarkReply(candidate, self.provider.identity.sha256, usage[0], usage[1])


class OllamaBenchmarkSession:
    def __init__(self, provider, *, enabled=False, allowlist=(), mode='offline-fake-transport'):
        if (type(enabled) is not bool or type(provider) is not OllamaLocalProvider
            or type(allowlist) is not tuple or allowlist != (provider.identity.sha256,)):
            raise LocalRefusal('IDENTITY_MISMATCH')
        if (mode not in ('offline-fake-transport', 'local-loopback-http')
            or (mode == 'local-loopback-http') != (type(provider.transport) is LoopbackHttpTransport)):
            raise LocalRefusal()
        self.mode = mode
        self.provider, self.enabled = provider, enabled
        self.bridge = OllamaBenchmarkBridge(provider, enabled=enabled)
        self.outcomes, self.seen = [], set()
        self.active, self.stopped, self.started = False, False, None

    async def run_case(self, case_id):
        if not self.enabled: raise LocalRefusal('DISABLED')
        if self.stopped: raise LocalRefusal()
        if self.active: raise LocalRefusal('BUSY')
        cases, _ = load_frozen()
        case = next((c for c in cases if c['id'] == case_id), None)
        if case is None or case_id in self.seen or len(self.seen) >= self.provider.policy.max_requests:
            raise LocalRefusal()
        loop = asyncio.get_running_loop()
        if self.started is None: self.started = loop.time()
        remaining = self.provider.policy.run_timeout_ms / 1000 - (loop.time() - self.started)
        if remaining <= 0:
            self.stopped = True
            raise LocalRefusal('DEADLINE_EXCEEDED')
        source, context, recipe = trusted_recipe(case, self.provider.identity)
        self.seen.add(case_id)
        self.active = True
        request = BenchmarkRequest(copy.deepcopy(source), copy.deepcopy(recipe),
            (DATA / 'prompt-v1.txt').read_text(), self.provider.identity,
            copy.deepcopy(self.provider.settings), self.provider.policy.num_predict)
        task = asyncio.create_task(self.bridge.generate(request))
        code, score = None, None
        try:
            done, _ = await asyncio.wait((task,), timeout=remaining)
            if not done: raise TimeoutError()
            reply = task.result()
            if type(reply) is not BenchmarkReply or reply.identity_sha256 != self.provider.identity.sha256:
                raise LocalRefusal('IDENTITY_MISMATCH')
            score = evaluate(case, reply.candidate, source, context, recipe,
                             expected_scope=source['scope'], expected_provenance=recipe)
        except LocalRefusal as exc:
            code, score = exc.code, exc.outcome
        except (TimeoutError, asyncio.CancelledError):
            code = 'DEADLINE_EXCEEDED'
        except Exception:
            code = 'LOCAL_REFUSED'
        finally:
            self.active = False
            if code and code != 'CANDIDATE_REJECTED':
                self.stopped = True
                self.provider.stopped = True
            if not task.done(): task.cancel()
            task.add_done_callback(lambda t: None if t.cancelled() else t.exception())
        row = {'case': case_id, 'input_sha256': recipe['input_sha256'],
               'request_sha256': self.provider.last_request_sha256, 'failure': code, 'evaluation': score}
        self.outcomes.append(row)
        # Quality failures are measurable, not repaired or silently retried.
        if code and code != 'CANDIDATE_REJECTED': raise LocalRefusal(code)
        return copy.deepcopy(row)

    def receipt(self):
        _, pins = load_frozen()
        modules = ('ollama_local.py', 'ollama_http.py', 'ollama_session.py')
        adapter_hash = hashlib.sha256(b''.join((Path(__file__).parent / p).read_bytes()
                                              for p in modules)).hexdigest()
        return {'schema_version': 1, 'kind': 'local-ollama-synthetic-benchmark',
            'adapter_sha256': adapter_hash, 'identity': asdict(self.provider.identity),
            'settings': copy.deepcopy(self.provider.settings),
            'ollama_version': '0.31.2', 'identity_sha256': self.provider.identity.sha256,
            'configuration_sha256': self.provider.identity.configuration_sha256,
            'fixture_set_sha256': fingerprint(pins), 'pins': pins,
            'evaluator_version': EVALUATOR_VERSION, 'evaluator_sha256': evaluator_identity(),
            'external_spend_microusd': 0, 'synthetic_only': True,
            'execution_mode': self.mode, 'local_http_used': self.mode == 'local-loopback-http',
            'clinical_validation': False, 'automatic_retries': 0,
            'generation_attempts': self.provider.attempts, 'stopped': self.stopped,
            'complete': len(self.outcomes) == 12 and not self.stopped,
            'outcomes': copy.deepcopy(self.outcomes)}

    def write_receipt(self, path):
        # Existing owned/private/exclusive writer. Never logs candidate or thinking.
        write_receipt(path, self.receipt())
