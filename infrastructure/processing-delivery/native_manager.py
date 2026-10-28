"""Inactive Linux sd-bus boundary. No bus, process or credentials at import.

Persistent sd-bus connection retains Unit.Ref across compare/control. No systemctl,
subprocess, shell or generic externally callable D-Bus operation. Native selection
is explicit; tests inject Bus and kernel callbacks, never connect the host bus.
"""
import ctypes as C
import time
import os
import json
import re
import hashlib
import fcntl
import stat
from contextlib import contextmanager

class Refusal(Exception):
    def __init__(self): super().__init__('NATIVE_AUTHORITY_REFUSED')
class MissingUnit(Refusal):pass
class BusError(C.Structure):
    _fields_=[('name',C.c_char_p),('message',C.c_char_p),('_need_free',C.c_int)]
def need(v):
    if not v: raise Refusal()
def canonical(v): return json.dumps(v,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()
def digest(v): return hashlib.sha256(canonical(v)).hexdigest()
def keys(v,expected):need(type(v) is dict and set(v)==set(expected))
DEST=b'org.freedesktop.systemd1';MANAGER='/org/freedesktop/systemd1'
U='org.freedesktop.systemd1.Unit';S='org.freedesktop.systemd1.Service'

class SdBus:
    """Native libsystemd marshalling, one persistent system-bus connection.

    CDLL/open_system occurs ONLY at explicit construction with enabled=True.
    Private methods are consumed only by NativeManager's frozen operation table.
    """
    def __init__(self,enabled=False,library=None):
        need(enabled is True)
        self.lib=library or C.CDLL('libsystemd.so.0');self.bus=C.c_void_p();self.deadline=time.monotonic()+600;self.operation_deadline=self.deadline
        # Declare all pointer-bearing prototypes. No unchecked pointer truncation.
        ptr=C.c_void_p;char=C.c_char_p;integer=C.c_int
        specs={'sd_bus_open_system':([C.POINTER(ptr)],integer),'sd_bus_unref':([ptr],ptr),
          'sd_bus_set_method_call_timeout':([ptr,C.c_uint64],integer),
          'sd_bus_message_new_method_call':([ptr,C.POINTER(ptr),char,char,char,char],integer),
          'sd_bus_message_append_basic':([ptr,integer,ptr],integer),
          'sd_bus_message_open_container':([ptr,integer,char],integer),
          'sd_bus_message_close_container':([ptr],integer),'sd_bus_call':([ptr,ptr,C.c_uint64,ptr,C.POINTER(ptr)],integer),
          'sd_bus_message_unref':([ptr],ptr),'sd_bus_message_peek_type':([ptr,C.POINTER(C.c_char),C.POINTER(char)],integer),
          'sd_bus_message_enter_container':([ptr,integer,char],integer),'sd_bus_message_exit_container':([ptr],integer),
          'sd_bus_message_read_basic':([ptr,integer,ptr],integer)}
        for name,(args,result) in specs.items():getattr(self.lib,name).argtypes=args;getattr(self.lib,name).restype=result
        self._ok(self.lib.sd_bus_open_system(C.byref(self.bus)))
        self._ok(self.lib.sd_bus_set_method_call_timeout(self.bus,800000))
    def _ok(self,n):need(n>=0);return n
    def close(self):
        if self.bus:self.lib.sd_bus_unref(self.bus);self.bus=C.c_void_p()
    def _append(self,m,sig,value):
        if sig in ('s','o','g'):
            need(type(value) is str and '\0' not in value and len(value)<=8192);raw=C.c_char_p(value.encode());self._ok(self.lib.sd_bus_message_append_basic(m,ord(sig),raw));return
        types={'b':C.c_int,'u':C.c_uint32,'i':C.c_int32,'t':C.c_uint64,'y':C.c_ubyte}
        if sig in types:
            need(type(value) in (int,bool));v=types[sig](value);self._ok(self.lib.sd_bus_message_append_basic(m,ord(sig),C.byref(v)));return
        if sig=='as':
            self._ok(self.lib.sd_bus_message_open_container(m,ord('a'),b's'))
            for x in value:self._append(m,'s',x)
        elif sig=='(bas)':
            self._ok(self.lib.sd_bus_message_open_container(m,ord('r'),b'bas'));self._append(m,'b',value[0]);self._append(m,'as',value[1])
        elif sig=='a(sasb)':
            self._ok(self.lib.sd_bus_message_open_container(m,ord('a'),b'(sasb)'))
            for path,args,ignore in value:
                self._ok(self.lib.sd_bus_message_open_container(m,ord('r'),b'sasb'));self._append(m,'s',path);self._append(m,'as',args);self._append(m,'b',ignore);self._ok(self.lib.sd_bus_message_close_container(m))
        elif sig=='a(sv)':
            self._ok(self.lib.sd_bus_message_open_container(m,ord('a'),b'(sv)'))
            for name,variant,data in value:
                self._ok(self.lib.sd_bus_message_open_container(m,ord('r'),b'sv'));self._append(m,'s',name);self._ok(self.lib.sd_bus_message_open_container(m,ord('v'),variant.encode()));self._append(m,variant,data);self._ok(self.lib.sd_bus_message_close_container(m));self._ok(self.lib.sd_bus_message_close_container(m))
        elif sig=='a(sa(sv))':
            need(value==[]);self._ok(self.lib.sd_bus_message_open_container(m,ord('a'),b'(sa(sv))'))
        else:raise Refusal()
        self._ok(self.lib.sd_bus_message_close_container(m))
    def _read(self,m,depth=0):
        need(depth<12);out=[]
        while True:
            typ=C.c_char();contents=C.c_char_p();n=self._ok(self.lib.sd_bus_message_peek_type(m,C.byref(typ),C.byref(contents)))
            if n==0:break
            t=typ.value.decode();need(len(out)<4096)
            if t in 'arve':
                self._ok(self.lib.sd_bus_message_enter_container(m,ord(t),contents));v=self._read(m,depth+1);self._ok(self.lib.sd_bus_message_exit_container(m));out.append(v[0] if t=='v' and len(v)==1 else v)
            elif t in 'sog':
                value=C.c_char_p();self._ok(self.lib.sd_bus_message_read_basic(m,ord(t),C.byref(value)));raw=value.value or b'';need(len(raw)<=65536);out.append(raw.decode('utf8'))
            else:
                typemap={'b':C.c_int,'u':C.c_uint32,'i':C.c_int32,'t':C.c_uint64,'x':C.c_int64,'y':C.c_ubyte,'q':C.c_uint16,'n':C.c_int16,'d':C.c_double}
                need(t in typemap);value=typemap[t]();self._ok(self.lib.sd_bus_message_read_basic(m,ord(t),C.byref(value)));out.append(bool(value.value) if t=='b' else value.value)
        return out
    def _call(self,path,interface,member,args=(),destination=DEST):
        need(self.bus and time.monotonic()<min(self.deadline,self.operation_deadline) and (path.startswith(MANAGER) or path=='/org/freedesktop/DBus' and destination==b'org.freedesktop.DBus') and len(path)<=512)
        message=C.c_void_p();reply=C.c_void_p();error=BusError()
        try:
            self._ok(self.lib.sd_bus_message_new_method_call(self.bus,C.byref(message),destination,path.encode(),interface.encode(),member.encode()))
            for sig,v in args:self._append(message,sig,v)
            remaining=int((min(self.deadline,self.operation_deadline)-time.monotonic())*1000000);need(remaining>0);status=self.lib.sd_bus_call(self.bus,message,min(800000,remaining),C.byref(error),C.byref(reply))
            if status<0:
                if member=='GetUnit' and error.name==b'org.freedesktop.systemd1.NoSuchUnit':raise MissingUnit()
                raise Refusal()
            return self._read(reply)
        finally:
            if reply:self.lib.sd_bus_message_unref(reply)
            if message:self.lib.sd_bus_message_unref(message)
            if hasattr(self.lib,'sd_bus_error_free'):
                self.lib.sd_bus_error_free.argtypes=[C.POINTER(BusError)];self.lib.sd_bus_error_free.restype=C.POINTER(BusError);self.lib.sd_bus_error_free(C.byref(error))
    def owner(self):
        v=self._call('/org/freedesktop/DBus','org.freedesktop.DBus','GetNameOwner',[('s','org.freedesktop.systemd1')],b'org.freedesktop.DBus');need(len(v)==1 and re.fullmatch(r':[0-9]+\.[0-9]+',v[0]));return v[0]
    def get_unit(self,name):
        result=self._call(MANAGER,'org.freedesktop.systemd1.Manager','GetUnit',[('s',name)]);need(len(result)==1 and re.fullmatch(r'/org/freedesktop/systemd1/unit/[A-Za-z0-9_]+',result[0]));return result[0]
    def property(self,path,interface,name):
        result=self._call(path,'org.freedesktop.DBus.Properties','Get',[('s',interface),('s',name)]);need(len(result)==1);return result[0]
    def ref(self,path):need(self._call(path,U,'Ref')==[])
    def unref(self,path):need(self._call(path,U,'Unref')==[])
    def start(self,definition):
        return self._call(MANAGER,'org.freedesktop.systemd1.Manager','StartTransientUnit',[('s',definition['name']),('s','fail'),('a(sv)',encode_properties(definition)),('a(sa(sv))',[])])
    def stop(self,path):return self._call(path,U,'Stop',[('s','fail')])
    def reset(self,path):return self._call(path,U,'ResetFailed')

# Input values are frozen typed UnitDefinition, never a client property list.
def encode_properties(d):
    keys(d,['manager','name','description','user','controlGroup','execStart','execStartPre','properties','addressFamilies']);need(d['manager']=='system' and re.fullmatch(r'health-wallet-stage-c-[a-f0-9]{24}(-controller)?\.service',d['name']))
    p=d['properties'];expected={'Type','DynamicUser','Restart','WorkingDirectory','RuntimeDirectory','RuntimeDirectoryMode','RuntimeMaxSec','CPUQuota','MemoryMax','TasksMax','KillMode','KillSignal','TimeoutStopSec','SendSIGKILL','ProtectControlGroups','Delegate','PrivateMounts','PrivateNetwork','PrivateDevices','ProtectHome','ProtectSystem','PrivateTmp','NoNewPrivileges','CapabilityBoundingSet','AmbientCapabilities','UMask','StandardOutput','StandardError'}
    if 'BindsTo' in p:expected|={'BindsTo','After'}
    need(set(p)==expected and d['addressFamilies']=={'allowList':True,'families':[]} and p['DynamicUser']=='yes' and p['Restart']=='no' and p['PrivateNetwork']=='yes' and p['ProtectControlGroups']=='yes' and p['Delegate']=='no' and p['CapabilityBoundingSet']==p['AmbientCapabilities']=='')
    out=[('Description','s',d['description']),('User','s',d['user'])]
    booleans={'DynamicUser','SendSIGKILL','ProtectControlGroups','Delegate','PrivateMounts','PrivateNetwork','PrivateDevices','PrivateTmp','NoNewPrivileges'}
    for k,v in p.items():
        if k in booleans:need(v in ('yes','no'));out.append((k,'b',v=='yes'))
        elif k in ('BindsTo','After','RuntimeDirectory'):out.append((k,'as',[v]))
        elif k in ('RuntimeMaxSec','TimeoutStopSec'):need(v.isdecimal());out.append((k[:-3]+'USec','t',int(v)*1000000))
        elif k=='CPUQuota':need(re.fullmatch(r'[0-9]+%',v));out.append(('CPUQuotaPerSecUSec','t',int(v[:-1])*10000))
        elif k in ('MemoryMax','TasksMax'):need(v.isdecimal());out.append((k,'t',int(v)))
        elif k in ('RuntimeDirectoryMode','UMask'):need(re.fullmatch(r'0[0-7]{3}',v));out.append((k,'u',int(v,8)))
        elif k in ('CapabilityBoundingSet','AmbientCapabilities'):out.append((k,'t',0))
        elif k=='KillSignal':need(v=='SIGTERM');out.append((k,'i',15))
        else:out.append((k,'s',v))
    for key in ('execStart','execStartPre'):
        argv=d[key];need(1<=len(argv)<=64 and all(type(x) is str and re.fullmatch(r'[-a-zA-Z0-9_./:=]+',x) for x in argv));out.append((key[0].upper()+key[1:],'a(sasb)',[(argv[0],argv,False)]))
    out.append(('RestrictAddressFamilies','(bas)',(True,[])));return out

@contextmanager
def authority_lock(root,timeout=0.15):
    need(0<timeout<=1 and os.path.isabs(root) and '//' not in root and not any(p in ('.','..') for p in root.split('/')))
    parent=os.open('/',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        for part in root.strip('/').split('/'):
            nxt=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
            try:
                st=os.fstat(nxt);need(st.st_uid in (0,os.getuid()) and (not st.st_mode&0o022 or part=='tmp' and st.st_mode&stat.S_ISVTX))
            except Exception:os.close(nxt);raise
            os.close(parent);parent=nxt
        st=os.fstat(parent);need(st.st_uid==os.getuid() and stat.S_IMODE(st.st_mode)==0o700)
        fd=os.open('manager.lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW|os.O_NONBLOCK,0o600,dir_fd=parent)
    finally:os.close(parent)
    try:
        s=os.fstat(fd);need(stat.S_ISREG(s.st_mode) and s.st_uid==os.getuid() and s.st_nlink==1 and stat.S_IMODE(s.st_mode)==0o600);deadline=time.monotonic()+timeout
        while True:
            try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB);break
            except BlockingIOError:
                need(time.monotonic()<deadline);time.sleep(.005)
        yield
    finally:os.close(fd)

class NativeManager:
    """All authorized writers share one flock + persistent referenced unit object.

    Root/system manager and out-of-band privileged administrators remain trusted.
    No claim of systemd InvocationID CAS. Policy must prohibit other untrusted
    writers and Restart!=no; connection/manager replacement poisons this session.
    """
    def __init__(self,definitions,bus,observe,authorize,lock,owner_epoch):
        need(len(definitions)==2);self.definitions={x['name']:json.loads(canonical(x)) for x in definitions}
        for d in self.definitions.values():encode_properties(d)
        self.bus=bus;self.observe=observe;self.authorize=authorize;self.lock=lock;self.owner_epoch=owner_epoch;self.epoch=owner_epoch();self.poisoned=False;self.request_deadline=float('inf')
    def begin(self):
        self.request_deadline=time.monotonic()+.9
        if hasattr(self.bus,'operation_deadline'):self.bus.operation_deadline=self.request_deadline
    def check(self):need(not self.poisoned and time.monotonic()<self.request_deadline and self.owner_epoch()==self.epoch);self.authorize();need(time.monotonic()<self.request_deadline)
    def execute(self,operation,name,expected=None):
        self.begin();need(operation in ('start-absent','stop-exact','reset-exact') and name in self.definitions and not name.endswith('-controller.service'))
        with self.lock():
            path=None;mutating=False
            try:
                self.check();current=self.observe(name)
                if operation=='start-absent':
                    need(expected is None and current is None);self.check();need(self.observe(name) is None);mutating=True;self.bus.start(self.definitions[name]);path=self.bus.get_unit(name);self.bus.ref(path);self.check();result=self.observe(name);need(result is not None);return result
                need(expected is not None and current==expected);path=self.bus.get_unit(name);self.bus.ref(path)
                # Fresh full comparison immediately before a call on the retained
                # unit object, under the exclusive broker lock and stable manager.
                self.check();need(self.observe(name)==expected)
                if operation=='reset-exact':need(expected['snapshot']['state']=='failed' and expected['snapshot']['main'] is None and expected['cgroupEmpty'] is True)
                self.check();mutating=True
                if operation=='stop-exact':self.bus.stop(path)
                else:self.bus.reset(path)
                self.check();return {'accepted':True,'invocationId':expected['snapshot']['identity']['invocationId']}
            except Exception:
                if mutating:self.poisoned=True
                raise Refusal() from None
            finally:
                if path:
                    try:self.bus.unref(path)
                    except Exception:self.poisoned=True;raise Refusal() from None

class Kernel:
    def __init__(self,boot,artifacts,inside):self.boot=boot;self.artifacts=artifacts;self.inside=inside
    def text(self,path,limit):
        need(re.fullmatch(r'/proc/(sys/kernel/random/boot_id|[1-9][0-9]*/(stat|status|cgroup|mountinfo))',path) or re.fullmatch(r'/sys/fs/cgroup/system.slice/health-wallet-stage-c-[a-f0-9]{24}(-controller)?\.service/(cpu.max|memory.max|pids.max|cgroup.procs|cgroup.events)',path))
        fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
        try:
            b=os.read(fd,limit+1);need(len(b)<=limit);return b.decode()
        finally:os.close(fd)
    def process(self,pid):
        need(type(pid) is int and pid>1 and self.text('/proc/sys/kernel/random/boot_id',64).strip()==self.boot)
        def one():
            raw=self.text('/proc/'+str(pid)+'/stat',8192);status=self.text('/proc/'+str(pid)+'/status',16384);end=raw.rfind(') ');need(raw.startswith(str(pid)+' (') and end>0);fields=raw[end+2:].split();need(len(fields)>=20 and fields[19].isdecimal() and fields[0] in ('R','S','D','I'))
            def group(key):
                m=re.search(r'^'+key+r':\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$',status,re.M);need(m and len(set(m.groups()))==1);return int(m[1])
            uid=group('Uid');gid=group('Gid');need(uid>0 and gid>0);return {'pid':pid,'startTime':fields[19],'uid':uid,'bootId':self.boot},gid
        a=one();b=one();need(a==b);return a
    def executable(self,pid):return os.readlink('/proc/'+str(pid)+'/exe')
    def limits(self,group):
        cpu=self.text('/sys/fs/cgroup'+group+'/cpu.max',1024).split();need(len(cpu)==2 and all(x.isdecimal() and int(x)>0 for x in cpu));out={'cpuQuota':int(cpu[0]),'cpuPeriod':int(cpu[1])}
        for name,key in [('memory.max','memoryMax'),('pids.max','tasksMax')]:
            v=self.text('/sys/fs/cgroup'+group+'/'+name,1024).strip();need(v.isdecimal() and int(v)>0);out[key]=int(v)
        return out

    def cgroup_empty(self,group):
        need(re.fullmatch(r'/system.slice/health-wallet-stage-c-[a-f0-9]{24}(-controller)?\.service',group));root='/sys/fs/cgroup'+group;count=0
        if not os.path.lexists(root):return True
        for current,dirs,files in os.walk(root,followlinks=False):
            count+=1;need(count<=128 and current.count('/')-root.count('/')<=8 and all(not os.path.islink(current+'/'+d) for d in dirs));fd=os.open(current+'/cgroup.procs',os.O_RDONLY|os.O_NOFOLLOW)
            try:need(os.read(fd,8193).strip()==b'')
            except Refusal:return False
            finally:os.close(fd)
        return True

class NativeObservation:
    def __init__(self,definitions,bus,kernel,boot):self.definitions={d['name']:d for d in definitions};self.bus=bus;self.kernel=kernel;self.boot=boot
    def read(self,name,require_inside=True):
        need(name in self.definitions);d=self.definitions[name];epoch=self.bus.owner()
        try:path=self.bus.get_unit(name)
        except MissingUnit:
            need(self.bus.owner()==epoch);return None
        def get(interface,key,typ):
            v=self.bus.property(path,interface,key);need(type(v) is typ);return v
        def identity():
            inv=get(U,'InvocationID',list);need(len(inv)==16 and all(type(x) is int and 0<=x<=255 for x in inv));return {'manager':'system','bootId':self.boot,'id':get(U,'Id',str),'description':get(U,'Description',str),'transient':get(U,'Transient',bool),'fragmentPath':get(U,'FragmentPath',str),'invocationId':bytes(inv).hex(),'user':get(S,'User',str),'dynamicUser':get(S,'DynamicUser',bool),'execStart':command('ExecStart'),'controlGroup':get(U,'ControlGroup',str)}
        def command(key):
            v=get(S,key,list);need(len(v)==1 and type(v[0]) is list and len(v[0])>=3 and type(v[0][0]) is str and type(v[0][1]) is list and v[0][0]==v[0][1][0] and v[0][2] is False);need(all(type(x) is str for x in v[0][1]));return v[0][1]
        first=identity();need(first['id']==name and first['transient'] is True and first['dynamicUser'] is True and first['fragmentPath']=='/run/systemd/transient/'+name and first['description']==d['description'] and first['user']==d['user'] and first['execStart']==d['execStart'] and re.fullmatch(r'(?!0{32})[a-f0-9]{32}',first['invocationId']))
        state=get(U,'ActiveState',str);sub=get(U,'SubState',str);pid=get(S,'MainPID',int);need(state in ('active','activating','deactivating','inactive','failed') and re.fullmatch(r'[a-z-]{1,64}',sub) and (pid==0 or pid>1));main=None;gid=0;readonly=False;effective={'cpuQuota':0,'cpuPeriod':0,'memoryMax':0,'tasksMax':0,'readOnlyCgroup':False};executable=None
        if pid:
            main,gid=self.kernel.process(pid);need(first['controlGroup']==d['controlGroup'] and self.kernel.text('/proc/'+str(pid)+'/cgroup',4096).strip()=='0::'+d['controlGroup']);need(self.kernel.executable(pid)==d['execStart'][0]);executable=self.kernel.artifacts(d['execStart'][0]);proof=self.kernel.inside(name,main,gid) if require_inside else None
            if require_inside:need(proof['process']==main and proof['gid']==gid and proof['controlGroup']==d['controlGroup'] and proof['protected'] is True and 0<=time.time()*1000-proof['observedAt']<=1000)
            mounts=[x for x in self.kernel.text('/proc/'+str(pid)+'/mountinfo',65536).splitlines() if ' - cgroup2 ' in x];need(mounts and all('ro' in x.split()[5].split(',') for x in mounts));effective=self.kernel.limits(d['controlGroup']);effective['readOnlyCgroup']=require_inside
        props={};boolean={'DynamicUser','SendSIGKILL','ProtectControlGroups','Delegate','PrivateMounts','PrivateNetwork','PrivateDevices','PrivateTmp','NoNewPrivileges'}
        for key in d['properties']:
            if key in ('BindsTo','After'):props[key]=' '.join(get(U,key,list))
            elif key=='CPUQuota':
                n=get(S,'CPUQuotaPerSecUSec',int);need(n%10000==0);props[key]=str(n//10000)+'%'
            elif key in ('RuntimeMaxSec','TimeoutStopSec'):
                n=get(S,key[:-3]+'USec',int);need(n%1000000==0);props[key]=str(n//1000000)
            elif key in ('RuntimeDirectoryMode','UMask'):props[key]=format(get(S,key,int),'04o')
            elif key in ('MemoryMax','TasksMax'):props[key]=str(get(S,key,int))
            elif key in ('CapabilityBoundingSet','AmbientCapabilities'):need(get(S,key,int)==0);props[key]=''
            elif key=='KillSignal':need(get(S,key,int)==15);props[key]='SIGTERM'
            elif key in boolean:props[key]='yes' if get(S,key,bool) else 'no'
            elif key=='RuntimeDirectory':props[key]=' '.join(get(S,key,list))
            else:props[key]=get(S,key,str)
        families=get(S,'RestrictAddressFamilies',list);need(families==[True,[]]);need(props==d['properties']);pre=command('ExecStartPre');need(pre==d['execStartPre'])
        if main:need(self.kernel.process(pid)==(main,gid) and self.kernel.executable(pid)==d['execStart'][0])
        need(identity()==first and get(S,'MainPID',int)==pid and get(U,'ActiveState',str)==state and get(U,'SubState',str)==sub and self.bus.owner()==epoch)
        return {'snapshot':{'identity':first,'state':state,'main':main,'resolvedUid':main['uid'] if main else 0,'mainExecutableSha256':executable,'execStartPre':pre,'properties':props,'bindsTo':get(U,'BindsTo',list),'after':get(U,'After',list),'addressFamilies':{'allowList':True,'families':[]},'effective':effective},'gid':gid,'subState':sub,'managerOwner':epoch,'cgroupEmpty':self.kernel.cgroup_empty(d['controlGroup'])}

if __name__=='__main__':
    # Import/library construction is never inferred from env flags. A future
    # deployment entry must explicitly supply reviewed, pinned capabilities.
    print('{"service":"health-wallet-native-authority","event":"disabled"}')
