"""Explicit native composition; disabled before evaluating any capability factory.

No listener creation, service start, credential loading or bus open at import.
The caller supplies reviewed policy, grant/artifact verification and frozen units.
Actual production selection/provisioning remains a separate authorization gate.
"""
import time,os
from native_manager import need,SdBus,NativeObservation,NativeManager,authority_lock
from native_bridge import NativeBridge
from native_issuer import IssuanceJournal,InvocationStage,RecoverableIssuer,NativeIssuerBridge
from native_peer import send_package

class NativeBoundary:
    def __init__(self,policy,definitions,bus,kernel,authorize,authorize_runtime,manager_root,journal,stage,now):
        self.policy=policy;self.observation=NativeObservation(definitions,bus,kernel,kernel.boot);self.bus=bus;self.authorize=authorize;self.now=now
        self.control=NativeBridge(policy,definitions,bus,self.observation,authorize,lambda:authority_lock(manager_root),now)
        def verify_runtime(binding,gid):
            authorize();need(binding['service']==definitions[0]['name'] and binding['deploymentSha256']==policy['deploymentSha256']);proof=self.observation.read(binding['service']);need(proof and proof['snapshot']['main']==binding['process'] and proof['gid']==gid and proof['snapshot']['identity']['invocationId']==binding['invocationId'] and binding['process']['uid']>0 and now()<binding['expiresAt']);authorize_runtime(binding,gid)
        stage.verify_identity=verify_runtime
        self.issuer=RecoverableIssuer(journal,stage,verify_runtime,now);self.credentials=NativeIssuerBridge(self.issuer)
    def handoff(self,connection,public_record):
        self.authorize();record=self.credentials.resolve(public_record);receipt=self.credentials.validate(public_record);binding=receipt['binding'];expected={'process':binding['process'],'gid':record['gid'],'unit':binding['service'],'invocationId':binding['invocationId'],'grantSha256':binding['grantSha256'],'expiresAt':binding['expiresAt']};fd=self.issuer.stage.open_verified(record)
        try:
            self.credentials.validate(public_record);send_package(connection,expected,receipt,fd,self.observation.read,lambda _:self.authorize());self.credentials.validate(public_record)
        finally:os.close(fd)
    def close(self):
        try:self.issuer.journal.close()
        finally:self.bus.close()

def build_native_boundary(enabled,factory):
    if enabled is not True:return {'service':'health-wallet-native-boundary','event':'disabled'}
    selected=factory();need(type(selected) is dict and set(selected)=={'policy','definitions','bus','kernel','authorize','authorize_runtime','manager_root','journal','stage','now'});return NativeBoundary(**selected)
