"""Synthetic-only local provider. No import/startup effects or credential loading."""
import asyncio
import copy
import hashlib
import json
import os
from dataclasses import asdict, dataclass
from typing import Protocol

from summary_contracts.validation import (LIMITS, canonical_summary_json, parse_summary_json,
    validate_summary_input, validate_summary_output, render_summary, SummaryValidationError)
from summary_evaluation.evaluator import evaluate
from summary_evaluation.reference import compile_case
from .contracts import ModelIdentity, fingerprint
from .ollama_http import ENDPOINT, HttpReply
from .preparation import DATA, load_frozen, scope_for

MODEL = 'deepseek-r1:1.5b'
DIGEST = 'e0979632db5a88d1a53884cb2a941772d10ff5d055aabaa6801c4e36f3a6c2d7'
VERSION = '0.31.2'
ADAPTER = 'ollama-local-v1'
CODES = frozenset({'LOCAL_REFUSED', 'DISABLED', 'PROXY_REFUSED', 'HOST_REFUSED',
    'IDENTITY_MISMATCH', 'CONTEXT_EXCEEDED', 'RESOURCE_REFUSED', 'BUSY',
    'DEADLINE_EXCEEDED', 'TRANSPORT_REFUSED', 'RESPONSE_REFUSED', 'CANDIDATE_REJECTED'})


class LocalRefusal(Exception):
    def __init__(self, code='LOCAL_REFUSED', *, outcome=None):
        self.code = code if code in CODES else 'LOCAL_REFUSED'
        self.outcome = outcome
        super().__init__(self.code)


def refuse_proxies(environment=None):
    env = os.environ if environment is None else environment
    # Read only proxy settings, never API keys or application credentials.
    if any(env.get(k) for k in ('http_proxy', 'https_proxy', 'all_proxy',
                               'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY')):
        raise LocalRefusal('PROXY_REFUSED')


@dataclass(frozen=True)
class LocalPolicy:
    concurrency: int = 1
    num_ctx: int = 4096
    num_predict: int = 2048
    num_thread: int = 2
    timeout_ms: int = 180000
    run_timeout_ms: int = 2400000
    max_requests: int = 12
    minimum_available_bytes: int = 2147483648
    maximum_process_tree_bytes: int = 3221225472
    spending_cap_microusd: int = 0

    def __post_init__(self):
        v = asdict(self)
        if (any(type(n) is not int for n in v.values()) or self.concurrency != 1
            or self.num_ctx != 4096 or not 1 <= self.num_predict <= 2048
            or not 1 <= self.num_thread <= 2 or not 10 <= self.timeout_ms <= 180000
            or not self.timeout_ms <= self.run_timeout_ms <= 2400000
            or not 1 <= self.max_requests <= 12 or self.spending_cap_microusd != 0
            or self.minimum_available_bytes < 2147483648
            or not 1 <= self.maximum_process_tree_bytes <= 3221225472):
            raise LocalRefusal()


@dataclass(frozen=True, repr=False)
class HostAdmission:
    """Trusted, fresh observation supplied by a separately reviewed host checker.

    No permissive default checker exists. Memory monitoring is admission-only,
    not OS-enforced containment; an exclusive verified daemon is mandatory.
    """
    loopback_only: bool
    cloud_disabled: bool
    telemetry_disabled: bool
    exclusive_daemon: bool
    available_bytes: int
    process_tree_bytes: int
    physical_cores: int
    cpu_only: bool


class TokenAccountant(Protocol):
    """Independently verified counter for the COMPLETE rendered prompt/template.

    Counts role/control tokens and all prompt material, not just source text.
    No character-count approximation or default tokenizer is supplied here.
    """
    model_digest: str
    template_sha256: str
    tokenizer_sha256: str
    revision: str

    def count(self, messages: list[dict]) -> int: ...


def output_schema():
    root = json.loads((DATA.parent / 'v1.schema.json').read_bytes())
    return {'$ref': '#/$defs/SummaryOutputV1', '$defs': root['$defs']}


def local_settings(policy, template_sha256, parameters_sha256, accountant):
    return {'policy': asdict(policy), 'endpoint': ENDPOINT, 'stream': False,
            'format_sha256': fingerprint(output_schema()), 'temperature': 0,
            'top_p': 1, 'seed': 0, 'num_gpu': 0, 'keep_alive': 0,
            'thinking_policy': 'separate-discard-never-repair',
            'template_sha256': template_sha256, 'parameters_sha256': parameters_sha256,
            'tokenizer_sha256': accountant.tokenizer_sha256,
            'token_accountant_revision': accountant.revision,
            'tools': False, 'fallback': False, 'external_spend_microusd': 0}


def trusted_recipe(case, identity):
    source, context, recipe = compile_case(case, expected_scope=scope_for(case['id']))
    recipe.update(provider=identity.provider, model_id=identity.model,
                  model_revision=identity.revision, prompt_sha256=identity.prompt_sha256)
    return source, context, recipe


class OllamaLocalProvider:
    """Implements ModelProvider.generate(source, recipe), restricted to frozen cases.

    Explicit composition only. No integration into FastAPI's fake-default workflow.
    All non-quality failures permanently latch admissions closed on this instance.
    """
    def __init__(self, *, transport, host_check, accountant, template_sha256,
                 parameters_sha256, enabled=False, endpoint=ENDPOINT, policy=None):
        self.policy = policy if policy is not None else LocalPolicy()
        if type(enabled) is not bool or endpoint != ENDPOINT or type(self.policy) is not LocalPolicy:
            raise LocalRefusal()
        import re
        for value in (template_sha256, parameters_sha256, accountant.tokenizer_sha256):
            if type(value) is not str or not re.fullmatch('[a-f0-9]{64}', value):
                raise LocalRefusal('IDENTITY_MISMATCH')
        if (accountant.model_digest != DIGEST or accountant.template_sha256 != template_sha256
            or type(accountant.revision) is not str
            or not re.fullmatch('[A-Za-z0-9_.-]{1,64}', accountant.revision)):
            raise LocalRefusal('IDENTITY_MISMATCH')
        _, pins = load_frozen()
        self.settings = local_settings(self.policy, template_sha256, parameters_sha256, accountant)
        self.identity = ModelIdentity('ollama-local', MODEL, DIGEST, ADAPTER,
            accountant.tokenizer_sha256, fingerprint(self.settings), pins['prompt_sha256'], 0, 0)
        self._identity_sha256 = self.identity.sha256
        self.transport, self.host_check, self.accountant = transport, host_check, accountant
        self.template_sha256, self.parameters_sha256 = template_sha256, parameters_sha256
        self.enabled, self.active, self.stopped = enabled, False, False
        self.attempts = 0
        self.last_usage = None
        self.last_request_sha256 = None

    def _host(self):
        if self.stopped: raise LocalRefusal()
        refuse_proxies()
        if (self.identity.sha256 != self._identity_sha256
            or fingerprint(self.settings) != self.identity.configuration_sha256
            or self.identity.configuration_sha256 != fingerprint(local_settings(self.policy, self.template_sha256, self.parameters_sha256, self.accountant))
            or self.accountant.model_digest != DIGEST or self.accountant.template_sha256 != self.template_sha256):
            raise LocalRefusal('IDENTITY_MISMATCH')
        h = self.host_check()
        if type(h) is not HostAdmission or any(v is not True for v in (
            h.loopback_only, h.cloud_disabled, h.telemetry_disabled, h.exclusive_daemon, h.cpu_only)):
            raise LocalRefusal('HOST_REFUSED')
        if (any(type(n) is not int for n in (h.available_bytes, h.process_tree_bytes, h.physical_cores))
            or h.available_bytes < self.policy.minimum_available_bytes
            or not 0 < h.process_tree_bytes <= self.policy.maximum_process_tree_bytes
            or h.physical_cores < self.policy.num_thread):
            raise LocalRefusal('RESOURCE_REFUSED')

    async def _json(self, method, path, payload=None):
        r = await self.transport.request(method, path, payload,
            timeout_s=self.policy.timeout_ms / 1000, max_bytes=262144)
        if type(r) is not HttpReply or r.status != 200 or type(r.body) is not bytes or not 0 < len(r.body) <= 262144:
            raise LocalRefusal('TRANSPORT_REFUSED')
        def pairs(items):
            result = {}
            for k, v in items:
                if k in result: raise LocalRefusal('RESPONSE_REFUSED')
                result[k] = v
            return result
        def bad(_): raise LocalRefusal('RESPONSE_REFUSED')
        value = json.loads(r.body.decode('utf-8'), object_pairs_hook=pairs, parse_constant=bad)
        if type(value) is not dict: raise LocalRefusal('RESPONSE_REFUSED')
        return value

    async def _metadata(self):
        version = await self._json('GET', '/api/version')
        tags = await self._json('GET', '/api/tags')
        if version != {'version': VERSION} or type(tags.get('models')) is not list:
            raise LocalRefusal('IDENTITY_MISMATCH')
        matches = [m for m in tags['models'] if type(m) is dict and m.get('name') == MODEL]
        if (len(matches) != 1 or matches[0].get('digest') != DIGEST
            or matches[0].get('model') != MODEL
            or any(k in matches[0] for k in ('remote_host', 'remote_model'))):
            raise LocalRefusal('IDENTITY_MISMATCH')
        show = await self._json('POST', '/api/show', {'model': MODEL, 'verbose': False})
        sha = lambda v: hashlib.sha256(v.encode()).hexdigest() if type(v) is str else None
        if (sha(show.get('template')) != self.template_sha256
            or sha(show.get('parameters')) != self.parameters_sha256
            or type(show.get('capabilities')) is not list or 'completion' not in show['capabilities']
            or show.get('model_info', {}).get('general.architecture') != 'qwen2'
            or show.get('system', '') != ''
            or any(k in show for k in ('remote_host', 'remote_model'))):
            raise LocalRefusal('IDENTITY_MISMATCH')
        return show

    async def _execute(self, source, recipe):
        code, outcome, candidate = None, None, None
        try:
            async with asyncio.timeout(self.policy.timeout_ms / 1000):
                self._host()
                if self.attempts >= self.policy.max_requests: raise LocalRefusal()
                cases, _ = load_frozen()
                authorities = [(*trusted_recipe(c, self.identity), c) for c in cases]
                match = next((a for a in authorities if a[0] == source and a[2] == recipe), None)
                if match is None: raise LocalRefusal('IDENTITY_MISMATCH')
                source, context, recipe, case = copy.deepcopy(match)
                validate_summary_input(source, context)
                show = await self._metadata()
                messages = [{'role': 'system', 'content': (DATA / 'prompt-v1.txt').read_text()},
                    {'role': 'user', 'content': canonical_summary_json({'input': source, 'provenance': recipe})}]
                count = self.accountant.count(copy.deepcopy(messages))
                if type(count) is not int or not 0 < count <= self.policy.num_ctx - self.policy.num_predict:
                    raise LocalRefusal('CONTEXT_EXCEEDED')
                self._host()  # Fresh admission immediately before inference.
                options = {k: getattr(self.policy, k) for k in ('num_ctx', 'num_predict', 'num_thread')}
                options.update(temperature=0, top_p=1, seed=0, num_gpu=0)
                payload = {'model': MODEL, 'messages': messages, 'format': output_schema(),
                           'stream': False, 'keep_alive': 0, 'options': options}
                # Do not guess unsupported thinking controls or silently change model.
                controls = show.get('thinking')
                if type(controls) is dict and type(controls.get('values')) is list and any(v is False for v in controls['values']):
                    payload['think'] = False
                self.last_request_sha256 = fingerprint(payload)
                self.attempts += 1  # Ambiguous requests consume admission; never retry.
                reply = await self._json('POST', '/api/chat', payload)
                allowed = {'model', 'created_at', 'message', 'done', 'done_reason',
                    'total_duration', 'load_duration', 'prompt_eval_count', 'prompt_eval_duration',
                    'eval_count', 'eval_duration'}
                message = reply.get('message')
                if (set(reply) - allowed or reply.get('model') != MODEL or reply.get('done') is not True
                    or reply.get('done_reason') != 'stop' or type(message) is not dict
                    or set(message) - {'role', 'content', 'thinking'} or message.get('role') != 'assistant'
                    or type(message.get('content')) is not str or not message['content'].strip()
                    or ('thinking' in message and type(message['thinking']) is not str)):
                    raise LocalRefusal('RESPONSE_REFUSED')
                # Never retain, concatenate, parse or receipt the reasoning field.
                message.pop('thinking', None)
                content = message['content']
                if '<think' in content.lower() or '</think' in content.lower():
                    raise LocalRefusal('RESPONSE_REFUSED')
                for k, cap in [('prompt_eval_count', count), ('eval_count', self.policy.num_predict)]:
                    if type(reply.get(k)) is not int or not 0 < reply[k] <= cap:
                        raise LocalRefusal('RESPONSE_REFUSED')
                candidate = parse_summary_json(content.encode(), 'output')
                await self._metadata()  # Retag/config drift invalidates the result.
                self._host()
                outcome = evaluate(case, candidate, source, context, recipe,
                                   expected_scope=source['scope'], expected_provenance=recipe)
                validate_summary_output(candidate, source, context, recipe)
                render_summary(candidate, source, context, recipe)
                self.last_usage = (reply['prompt_eval_count'], reply['eval_count'])
        except SummaryValidationError:
            code = 'CANDIDATE_REJECTED' if outcome is not None else 'RESPONSE_REFUSED'
        except (TimeoutError, asyncio.CancelledError):
            code = 'DEADLINE_EXCEEDED'
        except LocalRefusal as exc:
            code = exc.code
        except Exception:
            code = 'TRANSPORT_REFUSED'
        finally:
            if code is not None and code != 'CANDIDATE_REJECTED': self.stopped = True
        # Outside handler: no raw exception cause/context or provider text escapes.
        if code: raise LocalRefusal(code, outcome=outcome)
        return candidate

    async def generate(self, source, recipe):
        if not self.enabled: raise LocalRefusal('DISABLED')
        if self.stopped: raise LocalRefusal()
        if self.active: raise LocalRefusal('BUSY')
        self.active = True
        self.last_usage = None
        self.last_request_sha256 = None
        task = asyncio.create_task(self._execute(copy.deepcopy(source), copy.deepcopy(recipe)))
        code, outcome, result = None, None, None
        try:
            done, _ = await asyncio.wait((task,), timeout=self.policy.timeout_ms / 1000)
            if not done: raise TimeoutError()
            result = task.result()
        except (TimeoutError, asyncio.CancelledError):
            code = 'DEADLINE_EXCEEDED'
        except LocalRefusal as exc:
            code, outcome = exc.code, exc.outcome
        except Exception:
            code = 'TRANSPORT_REFUSED'
        finally:
            self.active = False
            if code and code != 'CANDIDATE_REJECTED': self.stopped = True
            if not task.done(): task.cancel()
            task.add_done_callback(lambda t: None if t.cancelled() else t.exception())
        if code: raise LocalRefusal(code, outcome=outcome)
        return result
