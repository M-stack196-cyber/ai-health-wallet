"""Synthetic injected-port tests only. No HTTP, SDK, credentials, retries or live launcher."""
import asyncio,copy,re
from summary_contracts.validation import canonical_summary_json,validate_summary_input,LIMITS
from summary_evaluation.evaluator import evaluate
from summary_evaluation.reference import compile_case
from .contracts import BenchmarkError,BenchmarkProvider,BenchmarkReply,BenchmarkRequest,Budget,Limits,ModelIdentity,fingerprint
from .preparation import DATA,load_frozen,scope_for,generation_settings
class OfflineSession:
    def __init__(self,identity:ModelIdentity,provider:BenchmarkProvider,*,allowlist=(),limits=None):
        self.limits=limits if limits is not None else Limits()
        if type(identity) is not ModelIdentity or type(self.limits) is not Limits:raise BenchmarkError()
        # This stage can compose only a synthetic testing port, never a real provider.
        if type(allowlist) is not tuple or any(type(h) is not str or not re.fullmatch(r'[a-f0-9]{64}',h) for h in allowlist) or len(set(allowlist))!=len(allowlist):raise BenchmarkError('NOT_ALLOWLISTED')
        if identity.provider!='synthetic-offline' or identity.sha256 not in allowlist:raise BenchmarkError('NOT_ALLOWLISTED')
        _,pins=load_frozen()
        if identity.prompt_sha256!=pins['prompt_sha256'] or identity.configuration_sha256!=fingerprint(generation_settings()):raise BenchmarkError('IDENTITY_MISMATCH')
        self.identity=identity;self.provider=provider;self.budget=Budget(self.limits,identity);self.active=False;self.stopped=False
    async def run_case(self,case_id):
        if self.stopped:raise BenchmarkError()
        if self.active:raise BenchmarkError('BUSY')
        self.active=True
        operation=None
        failure_code=None
        try:
            cases,_=load_frozen();case=next((c for c in cases if c['id']==case_id),None)
            if case is None:raise BenchmarkError()
            scope=scope_for(case_id);source,context,recipe=compile_case(case,expected_scope=scope)
            recipe.update(provider=self.identity.provider,model_id=self.identity.model,model_revision=self.identity.revision,prompt_sha256=self.identity.prompt_sha256)
            validate_summary_input(source,context)
            prompt=(DATA/'prompt-v1.txt').read_text()
            raw=canonical_summary_json(source).encode()
            if len(raw)>LIMITS['inputBytes']:raise BenchmarkError('LIMIT_EXCEEDED')
            # Test-port accounting uses bytes as conservative synthetic token units.
            # Real model tokenization/billing must be independently verified later.
            self.budget.reserve(len(raw)+len(prompt.encode()))
            request=BenchmarkRequest(copy.deepcopy(source),copy.deepcopy(recipe),prompt,self.identity,generation_settings(),self.limits.max_output_tokens)
            operation=asyncio.create_task(self.provider.generate(request))
            done,_=await asyncio.wait((operation,),timeout=self.limits.timeout_ms/1000)
            if not done:raise TimeoutError()
            reply=operation.result()
            if type(reply) is not BenchmarkReply or reply.identity_sha256!=self.identity.sha256:raise BenchmarkError('IDENTITY_MISMATCH')
            self.budget.verify_usage(reply)
            if len(canonical_summary_json(reply.candidate).encode())>LIMITS['outputBytes']:raise BenchmarkError('LIMIT_EXCEEDED')
            return evaluate(case,reply.candidate,source,context,recipe,expected_scope=scope,expected_provenance=recipe)
        except (TimeoutError,asyncio.CancelledError):failure_code='DEADLINE_EXCEEDED'
        except BenchmarkError as exc:failure_code=exc.code
        except Exception:failure_code='PROVIDER_FAILED'
        finally:
            self.active=False
            if operation is not None:
                if not operation.done():operation.cancel()
                operation.add_done_callback(lambda task:None if task.cancelled() else task.exception())
            if failure_code is not None:self.stopped=True
        # Outside exception handlers: provider exception context cannot escape.
        raise BenchmarkError(failure_code)
