"""Narrow bridge from versioned Node requests to native Python authority.

Construct programmatically with a pinned policy and trusted observation/authorization
ports. No implicit bus open, ambient policy, subprocess or privileged service.
"""
from native_manager import need,Refusal,NativeManager,canonical
import time

class NativeBridge:
    def __init__(self,policy,definitions,bus,observation,authorize,lock,now=None):
        need(policy['version']==1 and policy['enabled'] is False and policy['authority']=='exclusive-broker-flock-unit-ref' and policy['outOfBandRoot']=='trusted');self.policy=policy;self.definitions={d['name']:d for d in definitions};self.observation=observation;self.now=now or (lambda:time.time()*1000)
        self.manager=NativeManager(definitions,bus,observation.read,authorize,lock,bus.owner)
    def request(self,r):
        try:
            self.manager.begin()
            need(type(r) is dict and set(r)=={'version','kind','deploymentSha256','configurationSha256','operation','unit','definition','expected'} and r['version']==1 and r['kind']=='health-wallet-native-request' and r['deploymentSha256']==self.policy['deploymentSha256'] and r['configurationSha256']==self.policy['configurationSha256'] and r['unit'] in self.definitions);self.manager.check()
            if r['operation']=='observe':
                need(r['definition'] is None and r['expected'] is None);proof=self.observation.read(r['unit'])
                if proof is None:return None
                return {'version':1,'kind':'health-wallet-native-observation','deploymentSha256':r['deploymentSha256'],'configurationSha256':r['configurationSha256'],'observedAt':self.now(),**proof}
            expected=r['expected'];definition=r['definition']
            if r['operation']=='start-absent':need(expected is None and definition==self.definitions[r['unit']])
            else:
                need(definition is None and type(expected) is dict and set(expected)=={'version','kind','deploymentSha256','configurationSha256','observedAt','snapshot','gid','subState','managerOwner','cgroupEmpty'} and expected['deploymentSha256']==r['deploymentSha256'] and expected['configurationSha256']==r['configurationSha256'] and 0<=self.now()-expected['observedAt']<=1000)
                expected={k:expected[k] for k in ('snapshot','gid','subState','managerOwner','cgroupEmpty')}
            value=self.manager.execute(r['operation'],r['unit'],expected)
            if r['operation']=='start-absent':return {'version':1,'kind':'health-wallet-native-observation','deploymentSha256':r['deploymentSha256'],'configurationSha256':r['configurationSha256'],'observedAt':self.now(),**value}
            return {'version':1,'kind':'health-wallet-native-control','invocationId':value['invocationId'],'comparison':'flock-ref-revalidated','managerOwner':self.manager.epoch}
        except Exception:raise Refusal() from None
