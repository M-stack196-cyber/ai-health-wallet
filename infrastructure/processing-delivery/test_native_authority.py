import unittest,tempfile,os,socket,threading,time,json,copy,contextlib,hashlib,hmac
from pathlib import Path
from native_manager import Refusal,MissingUnit,SdBus,NativeManager,NativeObservation,authority_lock,encode_properties,canonical
from native_bridge import NativeBridge
from native_peer import peer_credentials,verify_peer,receive_frame,send_package,receive_package,NativeHmacDispatcher
from native_issuer import IssuanceJournal,InvocationStage,RecoverableIssuer

def definitions():
    name='health-wallet-stage-c-'+'a'*24+'.service';root='/opt/ai-health-wallet/releases/offline';user='hw-'+'a'*24
    p={'Type':'exec','DynamicUser':'yes','Restart':'no','WorkingDirectory':root+'/backend','RuntimeDirectory':name[:-8],'RuntimeDirectoryMode':'0700','RuntimeMaxSec':'600','CPUQuota':'200%','MemoryMax':'3221225472','TasksMax':'128','KillMode':'mixed','KillSignal':'SIGTERM','TimeoutStopSec':'60','SendSIGKILL':'yes','ProtectControlGroups':'yes','Delegate':'no','PrivateMounts':'yes','PrivateNetwork':'yes','PrivateDevices':'yes','ProtectHome':'yes','ProtectSystem':'strict','PrivateTmp':'yes','NoNewPrivileges':'yes','CapabilityBoundingSet':'','AmbientCapabilities':'','UMask':'0077','StandardOutput':'null','StandardError':'null'}
    d={'manager':'system','name':name,'description':'AI Health Wallet synthetic','user':user,'controlGroup':'/system.slice/'+name,'execStart':[root+'/bin/node',root+'/backend/dist/processing/operational-entry.js'],'execStartPre':[root+'/bin/node',root+'/backend/dist/stage-c/inside-entry.js','/run/'+name[:-8]+'/inside.json'],'properties':p,'addressFamilies':{'allowList':True,'families':[]}}
    ctrl=copy.deepcopy(d);ctrl['name']=name[:-8]+'-controller.service';ctrl['controlGroup']='/system.slice/'+ctrl['name'];ctrl['description']+=' controller';ctrl['user']+='c';ctrl['execStart'][1]=root+'/backend/dist/stage-c/cli.js';ctrl['properties'].update(CPUQuota='50%',MemoryMax='805306368',TasksMax='64',RuntimeMaxSec='900',KillMode='control-group');p['BindsTo']=p['After']=ctrl['name'];return [d,ctrl]
class FakeBus:
    def __init__(self,defs):self.defs={d['name']:d for d in defs};self.epoch=':1.1';self.calls=[];self.missing=False;self.overrides={};self.referenced=False
    def owner(self):return self.epoch
    def get_unit(self,name):
        if self.missing:raise MissingUnit()
        self.current=self.defs[name];return '/org/freedesktop/systemd1/unit/synthetic'
    def property(self,path,interface,key):
        if key in self.overrides:return self.overrides[key]
        d=self.current;unit={'Id':d['name'],'Description':d['description'],'Transient':True,'FragmentPath':'/run/systemd/transient/'+d['name'],'InvocationID':list(bytes.fromhex('b'*32)),'ControlGroup':d['controlGroup'],'ActiveState':'active','SubState':'running','MainPID':101,'User':d['user'],'DynamicUser':True,'ExecStart':[[d['execStart'][0],d['execStart'],False]],'ExecStartPre':[[d['execStartPre'][0],d['execStartPre'],False]],'BindsTo':[d['properties']['BindsTo']] if 'BindsTo' in d['properties'] else [],'After':[d['properties']['After']] if 'After' in d['properties'] else []}
        if key in unit:return unit[key]
        return {k:(list(v) if k=='RestrictAddressFamilies' else v) for k,s,v in encode_properties(d)}[key]
    def ref(self,path):self.calls.append('ref');self.referenced=True
    def unref(self,path):self.calls.append('unref');self.referenced=False
    def start(self,d):self.calls.append('start')
    def stop(self,path):assert self.referenced;self.calls.append('stop')
    def reset(self,path):assert self.referenced;self.calls.append('reset')
class FakeKernel:
    def __init__(self,d):self.d=d;self.uid=62000;self.gid=62000;self.start='123';self.protected=True;self.ro=True
    def process(self,pid):return {'pid':pid,'uid':self.uid,'startTime':self.start,'bootId':'11111111-1111-1111-1111-111111111111'},self.gid
    def text(self,path,max):return '0::'+self.d['controlGroup'] if path.endswith('cgroup') else '1 0 0:1 / /sys/fs/cgroup '+('ro' if self.ro else 'rw')+' - cgroup2 cgroup rw'
    def executable(self,pid):return self.d['execStart'][0]
    def artifacts(self,path):return 'a'*64
    def inside(self,name,p,gid):return {'process':p,'gid':gid,'controlGroup':self.d['controlGroup'],'protected':self.protected,'observedAt':time.time()*1000}
    def limits(self,group):return {'cpuQuota':200000,'cpuPeriod':100000,'memoryMax':3221225472,'tasksMax':128}
    def cgroup_empty(self,group):return False
class NativeTests(unittest.TestCase):
    def test_disabled_library_never_opens_bus(self):
        with self.assertRaises(Refusal):SdBus()
    def test_typed_security_properties(self):
        out={k:(t,v) for k,t,v in encode_properties(definitions()[0])};self.assertEqual(out['RestrictAddressFamilies'],('(bas)',(True,[])));self.assertEqual(out['TimeoutStopUSec'],('t',60000000));self.assertEqual(out['CapabilityBoundingSet'],('t',0));self.assertEqual(out['RuntimeMaxUSec'],('t',600000000))
    def test_no_unknown_properties(self):
        d=definitions()[0];d['properties']['Environment']='unsafe'
        with self.assertRaises(Refusal):encode_properties(d)
    def test_observation(self):
        defs=definitions();bus=FakeBus(defs);kernel=FakeKernel(defs[0]);v=NativeObservation(defs,bus,kernel,kernel.process(101)[0]['bootId']).read(defs[0]['name']);self.assertEqual(v['gid'],62000);self.assertEqual(v['snapshot']['main']['startTime'],'123')
    def test_missing_unit_only_explicit_missing(self):
        defs=definitions();b=FakeBus(defs);b.missing=True;k=FakeKernel(defs[0]);self.assertIsNone(NativeObservation(defs,b,k,'boot').read(defs[0]['name']))
    def test_observation_field_failures(self):
        for field,value in [('MainPID','101'),('InvocationID',[0]*16),('Transient',False),('DynamicUser',False),('User','foreign'),('ControlGroup','/other'),('RestrictAddressFamilies',[False,[]]),('ProtectControlGroups',False),('PrivateNetwork',False),('ExecStart',[]),('SubState','invalid state')]:
            with self.subTest(field=field):
                defs=definitions();b=FakeBus(defs);b.overrides[field]=value;k=FakeKernel(defs[0])
                with self.assertRaises((Refusal,KeyError)):NativeObservation(defs,b,k,'boot').read(defs[0]['name'])
    def test_inside_cgroup_protection(self):
        for field in ('ro','protected'):
            defs=definitions();b=FakeBus(defs);k=FakeKernel(defs[0]);setattr(k,field,False)
            with self.assertRaises(Refusal):NativeObservation(defs,b,k,'boot').read(defs[0]['name'])
    def test_retained_exact_stop(self):
        defs=definitions();b=FakeBus(defs);proof={'snapshot':{'identity':{'invocationId':'b'*32},'state':'active','main':{'pid':101}},'cgroupEmpty':False};m=NativeManager(defs,b,lambda _:copy.deepcopy(proof),lambda:None,contextlib.nullcontext,b.owner);m.execute('stop-exact',defs[0]['name'],proof);self.assertEqual(b.calls,['ref','stop','unref'])
    def test_replacement_between_observe_and_control(self):
        defs=definitions();b=FakeBus(defs);proof={'snapshot':{'identity':{'invocationId':'b'*32},'state':'active','main':{'pid':101}},'cgroupEmpty':False};reads=0
        def observe(_):
            nonlocal reads;reads+=1;r=copy.deepcopy(proof)
            if reads>1:r['snapshot']['identity']['invocationId']='c'*32
            return r
        m=NativeManager(defs,b,observe,lambda:None,contextlib.nullcontext,b.owner)
        with self.assertRaises(Refusal):m.execute('stop-exact',defs[0]['name'],proof)
        self.assertNotIn('stop',b.calls)
    def test_manager_replacement(self):
        defs=definitions();b=FakeBus(defs);m=NativeManager(defs,b,lambda _:None,lambda:None,contextlib.nullcontext,b.owner);b.epoch=':1.2'
        with self.assertRaises(Refusal):m.execute('start-absent',defs[0]['name'])
    def test_unknown_operation_and_unit(self):
        defs=definitions();b=FakeBus(defs);m=NativeManager(defs,b,lambda _:None,lambda:None,contextlib.nullcontext,b.owner)
        for op,name in [('kill',defs[0]['name']),('stop-exact','other.service'),('start-absent',defs[1]['name'])]:
            with self.assertRaises(Refusal):m.execute(op,name)
        self.assertEqual(b.calls,[])
    def test_real_flock_contention(self):
        with tempfile.TemporaryDirectory() as d:
            with authority_lock(d):
                with self.assertRaises(Refusal):
                    with authority_lock(d,.01):pass
            with authority_lock(d):pass
    def test_real_peer_credentials(self):
        a,b=socket.socketpair()
        try:self.assertEqual(peer_credentials(a),{'pid':os.getpid(),'uid':os.getuid(),'gid':os.getgid()})
        finally:a.close();b.close()
    def test_tcp_refused_without_connection(self):
        a=type('UnexpectedTransport',(),{'family':socket.AF_INET,'close':lambda self:None})()
        try:
            with self.assertRaises(Refusal):peer_credentials(a)
        finally:a.close()
    def test_peer_claims(self):
        a,b=socket.socketpair();p={'pid':os.getpid(),'uid':os.getuid(),'bootId':'boot','startTime':'1'};e={'process':p,'gid':os.getgid(),'unit':'owned','invocationId':'a'*32,'grantSha256':'b'*64,'expiresAt':time.time()*1000+10000};observe=lambda _: {'snapshot':{'identity':{'invocationId':e['invocationId']},'main':p},'gid':os.getgid()}
        try:
            verify_peer(a,e,observe,lambda _:None)
            for field in ('pid','uid'):
                wrong=copy.deepcopy(e);wrong['process'][field]+=1
                with self.assertRaises(Refusal):verify_peer(a,wrong,observe,lambda _:None)
            wrong=copy.deepcopy(e);wrong['gid']+=1
            with self.assertRaises(Refusal):verify_peer(a,wrong,observe,lambda _:None)
        finally:a.close();b.close()
    def test_oversized_frame(self):
        a,b=socket.socketpair()
        try:b.sendall(b'x'*65537)
        except BlockingIOError:pass
        try:
            with self.assertRaises(Refusal):receive_frame(a)
        finally:a.close();b.close()
    def test_hmac_replay_and_wrong_key(self):
        class Bridge:
            def request(self,r):return {'accepted':True}
        key=b'a'*32;caller={'pid':101};dispatch=NativeHmacDispatcher(key,caller,Bridge());body=json.dumps({'version':1,'nonce':'b'*32,'caller':caller,'request':{'operation':'observe'}},separators=(',',':'));frame={'version':1,'body':body,'mac':hmac.new(key,body.encode(),'sha256').hexdigest()};self.assertEqual(dispatch(frame)['version'],1)
        with self.assertRaises(Refusal):dispatch(frame)
        frame['mac']='c'*64
        with self.assertRaises(Refusal):NativeHmacDispatcher(key,caller,Bridge())(frame)

class IssuerTests(unittest.TestCase):
    def setup_issuer(self,d,create=True):
        root=Path(d);journal=root/'journal';packages=root/'packages';journal.mkdir(mode=0o700,exist_ok=True);packages.mkdir(mode=0o700,exist_ok=True)
        identity={'pid':os.getpid(),'uid':os.getuid(),'startTime':'123','bootId':'boot'};binding={'run':'stage-c-'+'a'*24,'deploymentSha256':'a'*64,'configurationSha256':'b'*64,'grantSha256':'c'*64,'invocationId':'d'*32,'service':definitions()[0]['name'],'process':identity,'expiresAt':20000};valid={'current':True};now={'value':1}
        def authorize(b,g):
            need=__import__('native_manager').need;need(valid['current'] and b==binding and g==os.getgid())
        j=IssuanceJournal(str(journal),'a'*64,create);stage=InvocationStage(str(packages),authorize);issuer=RecoverableIssuer(j,stage,authorize,lambda:now['value']);files={k:('SYNTHETIC-'+k).encode() for k in ('aws','postgres','approval','authorization')};return j,stage,issuer,binding,files,valid,now
    def test_issue_recover_revoke_cleanup(self):
        with tempfile.TemporaryDirectory() as d:
            j,s,i,b,f,v,n=self.setup_issuer(d);r=i.issue(b,os.getgid(),f);i.validate(r);j.close();j=IssuanceJournal(d+'/journal','a'*64);i=RecoverableIssuer(j,s,i.authorize,lambda:n['value']);i.validate(r);i.revoke(r)
            with self.assertRaises(Refusal):i.validate(r)
            i.cleanup(r);j.close();self.assertFalse((Path(d)/'packages'/r['id']).exists())
    def test_pending_grant_revocation_survives_restart(self):
        with tempfile.TemporaryDirectory() as d:
            j,s,i,b,f,v,n=self.setup_issuer(d);i.revoke_pending(b);j.close();j=IssuanceJournal(d+'/journal','a'*64);i=RecoverableIssuer(j,s,i.authorize,lambda:1)
            with self.assertRaises(Refusal):i.issue(b,os.getgid(),f)
            j.close()
    def test_expiry(self):
        with tempfile.TemporaryDirectory() as d:
            j,s,i,b,f,v,n=self.setup_issuer(d);r=i.issue(b,os.getgid(),f);n['value']=20001
            with self.assertRaises(Refusal):i.validate(r)
            i.expire(r);i.cleanup(r);j.close()
    def test_wrong_identity_before_staging(self):
        with tempfile.TemporaryDirectory() as d:
            j,s,i,b,f,v,n=self.setup_issuer(d);v['current']=False
            with self.assertRaises(Refusal):i.issue(b,os.getgid(),f)
            self.assertFalse(list((Path(d)/'packages').glob('[0-9a-f]*')));j.close()
    def test_changed_file_and_symlink(self):
        for mode in ('content','symlink','permission'):
            with self.subTest(mode=mode),tempfile.TemporaryDirectory() as d:
                j,s,i,b,f,v,n=self.setup_issuer(d);r=i.issue(b,os.getgid(),f);p=Path(d)/'packages'/r['id']/'aws-profile.json';p.chmod(0o600)
                if mode=='content':p.write_bytes(b'CHANGED');p.chmod(0o400)
                elif mode=='symlink':p.unlink();p.symlink_to('/dev/null')
                with self.assertRaises((Refusal,OSError)):i.validate(r)
                j.close()
    def test_journal_corruption(self):
        with tempfile.TemporaryDirectory() as d:
            j,s,i,b,f,v,n=self.setup_issuer(d);i.issue(b,os.getgid(),f);j.close();p=Path(d)/'journal'/'issuance.jsonl';p.write_bytes(p.read_bytes()+b'{')
            with self.assertRaises((Refusal,ValueError)):IssuanceJournal(d+'/journal','a'*64)
    def test_stale_invocation_after_restart(self):
        with tempfile.TemporaryDirectory() as d:
            j,s,i,b,f,v,n=self.setup_issuer(d);r=i.issue(b,os.getgid(),f);b['invocationId']='e'*32
            with self.assertRaises(Refusal):i.validate(r)
            j.close()
    def test_issuer_identity_mismatch(self):
        with tempfile.TemporaryDirectory() as d:
            j,*_=self.setup_issuer(d);j.close()
            with self.assertRaises(Refusal):IssuanceJournal(d+'/journal','b'*64)
    def test_descriptor_handoff_uses_kernel_peer_and_exact_receipt(self):
        with tempfile.TemporaryDirectory() as d:
            j,s,i,b,f,v,n=self.setup_issuer(d);r=i.issue(b,os.getgid(),f);a,z=socket.socketpair();fd=s.open_verified(r);expected={'process':b['process'],'gid':os.getgid(),'unit':b['service'],'invocationId':b['invocationId'],'grantSha256':b['grantSha256'],'expiresAt':time.time()*1000+10000};observe=lambda _: {'snapshot':{'main':b['process'],'identity':{'invocationId':b['invocationId']}},'gid':os.getgid()}
            try:
                send_package(a,expected,r['receipt'],fd,observe,lambda _:None);out=receive_package(z,{'pid':os.getpid(),'uid':os.getuid(),'gid':os.getgid()},r['receipt'],os.getgid(),lambda:1);self.assertEqual(set(out),set(f))
            finally:os.close(fd);a.close();z.close();i.revoke(r);i.cleanup(r);j.close()

class RecoveryAndAbiTests(unittest.TestCase):
    def test_typed_container_marshalling_without_bus(self):
        calls=[]
        class Library:
            def sd_bus_message_open_container(self,m,t,s):calls.append(('open',chr(t),s));return 0
            def sd_bus_message_close_container(self,m):calls.append(('close',));return 0
            def sd_bus_message_append_basic(self,m,t,v):calls.append(('basic',chr(t)));return 0
        bus=SdBus.__new__(SdBus);bus.lib=Library();bus._append(None,'a(sv)',encode_properties(definitions()[0]));self.assertEqual(sum(x[0]=='open' for x in calls),sum(x[0]=='close' for x in calls));self.assertIn(('open','v',b'(bas)'),calls);self.assertIn(('open','a',b'(sasb)'),calls)
    def test_rotation_new_invocation_and_revoked_lineage(self):
        with tempfile.TemporaryDirectory() as d:
            j,s,i,b,f,v,n=IssuerTests().setup_issuer(d);old=i.issue(b,os.getgid(),f);new=copy.deepcopy(b);new['invocationId']='e'*32;new['grantSha256']='f'*64;b.clear();b.update(new);r=i.rotate(old,new,os.getgid(),f);self.assertEqual(j.state(r['id'])['predecessor'],old['id']);i.validate(r)
            with self.assertRaises(Refusal):i.validate(old)
            i.cleanup(old);i.revoke(r);i.cleanup(r);j.close()
    def test_duplicate_invocation_after_recovery(self):
        with tempfile.TemporaryDirectory() as d:
            j,s,i,b,f,v,n=IssuerTests().setup_issuer(d);r=i.issue(b,os.getgid(),f);j.close();j=IssuanceJournal(d+'/journal','a'*64);i=RecoverableIssuer(j,s,i.authorize,lambda:1)
            with self.assertRaises(Refusal):i.issue(b,os.getgid(),f)
            i.revoke(r);i.cleanup(r);j.close()
    def test_incomplete_record_never_becomes_usable(self):
        with tempfile.TemporaryDirectory() as d:
            j,s,i,b,f,v,n=IssuerTests().setup_issuer(d);bad=dict(f);del bad['approval']
            with self.assertRaises(Refusal):i.issue(b,os.getgid(),bad)
            self.assertFalse([x for x in j.load() if x['event']=='active']);j.close()

class InsideTests(unittest.TestCase):
    def test_native_inside_challenge_peer_freshness_and_replay(self):
        from native_inside import InsideReceiptStore
        with tempfile.TemporaryDirectory() as d:
            p={'pid':os.getpid(),'uid':os.getuid(),'startTime':'1','bootId':'boot'};group=definitions()[0]['controlGroup'];proof={'snapshot':{'main':p,'identity':{'controlGroup':group}},'gid':os.getgid()};clock={'now':1};store=InsideReceiptStore(d,lambda _:proof,lambda:clock['now']);nonce=store.challenge(definitions()[0]['name']);paths=[group+'/'+x for x in ('cgroup.procs','cgroup.threads','cpu.max','memory.max','pids.max')]+['/system.slice/cgroup.procs','/cgroup.procs'];report={'version':1,'kind':'health-wallet-inside-challenge','nonce':nonce,'process':p,'gid':os.getgid(),'controlGroup':group,'interfaces':[{'path':x,'readOnly':True,'writable':False,'openDenied':True} for x in paths]};a,b=socket.socketpair()
            try:
                store.accept(a,nonce,report);self.assertTrue(store.read(definitions()[0]['name'],p,os.getgid())['protected'])
                with self.assertRaises(Refusal):store.accept(a,nonce,report)
                clock['now']=1002
                with self.assertRaises(Refusal):store.read(definitions()[0]['name'],p,os.getgid())
            finally:a.close();b.close()

class BoundaryTests(unittest.TestCase):
    def test_disabled_native_composition_does_not_evaluate_factory(self):
        from native_boundary import build_native_boundary
        self.assertEqual(build_native_boundary(False,lambda:(_ for _ in ()).throw(AssertionError())),{'service':'health-wallet-native-boundary','event':'disabled'})
    def test_public_issuer_bridge_recovers_exact_record(self):
        from native_issuer import NativeIssuerBridge
        with tempfile.TemporaryDirectory() as d:
            j,s,i,b,f,v,n=IssuerTests().setup_issuer(d);bridge=NativeIssuerBridge(i);public=bridge.issue(b,os.getgid(),f);bridge.validate(public);bad=copy.deepcopy(public);bad['issuerSha256']='b'*64
            with self.assertRaises(Refusal):bridge.validate(bad)
            bridge.revoke(public);bridge.cleanup(public);j.close()

if __name__=='__main__':unittest.main()
