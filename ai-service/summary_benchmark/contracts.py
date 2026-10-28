"""Provider-independent immutable benchmark metadata and conservative offline budgets."""
from dataclasses import asdict,dataclass
import hashlib,json,re
from typing import Protocol

def fingerprint(value):
    return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False,allow_nan=False).encode()).hexdigest()
class BenchmarkError(Exception):
    def __init__(self,code='BENCHMARK_REFUSED'):
        self.code=code if code in {'BENCHMARK_REFUSED','NOT_ALLOWLISTED','LIMIT_EXCEEDED','BUSY','PROVIDER_FAILED','IDENTITY_MISMATCH','DEADLINE_EXCEEDED'} else 'BENCHMARK_REFUSED'
        super().__init__(self.code)
@dataclass(frozen=True,repr=False)
class ModelIdentity:
    provider:str
    model:str
    revision:str
    adapter_revision:str
    tokenizer_sha256:str
    configuration_sha256:str
    prompt_sha256:str
    input_microusd_per_token:int
    output_microusd_per_token:int
    def __post_init__(self):
        if type(self.provider) is not str or not re.fullmatch(r'[A-Za-z0-9_.-]{1,64}',self.provider):raise BenchmarkError()
        for v in [self.provider,self.model,self.revision,self.adapter_revision]:
            if type(v) is not str or not re.fullmatch(r'[A-Za-z0-9_.:/-]{1,128}',v) or v.lower() in ('auto','latest','default'):raise BenchmarkError()
        for h in [self.tokenizer_sha256,self.configuration_sha256,self.prompt_sha256]:
            if type(h) is not str or not re.fullmatch(r'[a-f0-9]{64}',h):raise BenchmarkError()
        for n in [self.input_microusd_per_token,self.output_microusd_per_token]:
            if type(n) is not int or not 0<=n<=1000000:raise BenchmarkError()
    @property
    def sha256(self):return fingerprint(asdict(self))
@dataclass(frozen=True)
class Limits:
    concurrency:int=1
    timeout_ms:int=1000
    max_requests:int=12
    max_input_tokens:int=16000
    max_output_tokens:int=8000
    spending_cap_microusd:int=1000000
    def __post_init__(self):
        values=asdict(self)
        if any(type(v) is not int for v in values.values()) or self.concurrency!=1 or not 10<=self.timeout_ms<=5000 or not 1<=self.max_requests<=12 or not 1<=self.max_input_tokens<=16000 or not 1<=self.max_output_tokens<=8000 or not 0<=self.spending_cap_microusd<=1000000:raise BenchmarkError()
@dataclass(frozen=True,repr=False)
class BenchmarkRequest:
    source:dict
    provenance:dict
    prompt:str
    identity:ModelIdentity
    settings:dict
    max_output_tokens:int
@dataclass(frozen=True,repr=False)
class BenchmarkReply:
    candidate:object
    identity_sha256:str
    input_tokens:int
    output_tokens:int
class BenchmarkProvider(Protocol):
    async def generate(self,request:BenchmarkRequest)->BenchmarkReply:
        """Injected port; no transport/credential fallback implementation exists."""
        ...
class Budget:
    """Reserve full worst-case request cost before admission; never refund ambiguous calls."""
    def __init__(self,limits:Limits,identity:ModelIdentity):self.limits=limits;self.identity=identity;self.requests=0;self.reserved_microusd=0
    def reserve(self,input_token_upper_bound):
        worst=self.limits.max_input_tokens*self.identity.input_microusd_per_token+self.limits.max_output_tokens*self.identity.output_microusd_per_token
        if type(input_token_upper_bound) is not int or not 0<input_token_upper_bound<=self.limits.max_input_tokens or self.requests>=self.limits.max_requests or self.reserved_microusd+worst>self.limits.spending_cap_microusd:raise BenchmarkError('LIMIT_EXCEEDED')
        self.requests+=1;self.reserved_microusd+=worst
    def verify_usage(self,reply):
        if type(reply.input_tokens) is not int or type(reply.output_tokens) is not int or not 0<=reply.input_tokens<=self.limits.max_input_tokens or not 0<=reply.output_tokens<=self.limits.max_output_tokens:raise BenchmarkError('LIMIT_EXCEEDED')
