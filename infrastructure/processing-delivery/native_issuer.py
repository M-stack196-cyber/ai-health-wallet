"""Protected local issuance journal and dynamic-identity credential packages.

Synthetic/offline issuer plumbing only. No AWS/DB provider, home or env fallback.
Native ownership transfer is dormant unless explicitly called by a privileged
broker. Tests use newly created own-UID files and injected identity observation.
"""
import os,stat,json,time,re,secrets,hashlib,fcntl,ctypes as C
from native_manager import need,Refusal,canonical,digest,authority_lock
from native_peer import NAMES

def private_root(path):
    need(os.path.isabs(path) and '//' not in path and not any(p in ('.','..') for p in path.split('/')))
    fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        for part in path.strip('/').split('/'):
            nxt=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd);s=os.fstat(nxt);need(s.st_uid in (0,os.getuid()) and (not s.st_mode&0o022 or stat.S_ISVTX&s.st_mode and part=='tmp'));os.close(fd);fd=nxt
        s=os.fstat(fd);need(s.st_uid==os.getuid() and stat.S_IMODE(s.st_mode)==0o700);return fd
    except Exception:os.close(fd);raise Refusal() from None

def read_regular(parent,name,uid,mode,maxsize=16384):
    fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=parent)
    try:
        s=os.fstat(fd);need(stat.S_ISREG(s.st_mode) and s.st_uid==uid and s.st_nlink==1 and stat.S_IMODE(s.st_mode)==mode and 0<s.st_size<=maxsize);b=os.read(fd,maxsize+1);a=os.fstat(fd);need(len(b)==s.st_size and (s.st_ino,s.st_ctime_ns)==(a.st_ino,a.st_ctime_ns));return b,s
    finally:os.close(fd)

class IssuanceJournal:
    def __init__(self,root,issuer,create=False):
        need(re.fullmatch(r'[a-f0-9]{64}',issuer));self.root=root;self.issuer=issuer;self.dir=private_root(root);self.path='issuance.jsonl';self.closed=False
        if create:
            fd=os.open(self.path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=self.dir)
            try:os.write(fd,canonical({'version':1,'issuer':issuer})+b'\n');os.fsync(fd)
            finally:os.close(fd)
            os.fsync(self.dir)
        try:self.records=self.load()
        except Exception:os.close(self.dir);self.closed=True;raise Refusal() from None
    def load(self):
        b,_=read_regular(self.dir,self.path,os.getuid(),0o600,1048576);need(b.endswith(b'\n'));lines=b.splitlines();header=json.loads(lines[0]);need(header=={'version':1,'issuer':self.issuer} and canonical(header)==lines[0]);out=[];head='0'*64
        for raw in lines[1:]:
            v=json.loads(raw);need(canonical(v)==raw and set(v)=={'version','sequence','previous','event','id','receipt','predecessor','sha256'} and v['version']==1 and v['sequence']==len(out)+1 and v['previous']==head and re.fullmatch(r'[a-f0-9]{32}',v['id']) and v['event'] in ('reserved','active','revoked','expired','cleaned','indeterminate','grant-revoked'));copy=dict(v);expected=copy.pop('sha256');need(digest(copy)==expected);head=expected;out.append(v);need(len(out)<=256)
        return out
    def append(self,event,id,receipt,predecessor=None):
        need(not self.closed)
        with authority_lock(self.root):
            records=self.load();need(len(records)<256);body={'version':1,'sequence':len(records)+1,'previous':records[-1]['sha256'] if records else '0'*64,'event':event,'id':id,'receipt':receipt,'predecessor':predecessor};body['sha256']=digest(body);raw=canonical(body)+b'\n';need(len(raw)<65536);fd=os.open(self.path,os.O_WRONLY|os.O_APPEND|os.O_NOFOLLOW,dir_fd=self.dir)
            try:
                s=os.fstat(fd);need(s.st_uid==os.getuid() and s.st_nlink==1 and stat.S_IMODE(s.st_mode)==0o600);need(os.write(fd,raw)==len(raw));os.fsync(fd)
            finally:os.close(fd)
            self.records=records+[body]
    def state(self,id):
        need(not self.closed);records=self.load();matches=[r for r in records if r['id']==id];need(matches);return matches[-1]
    def close(self):
        if not self.closed:self.closed=True;os.close(self.dir)

class InvocationStage:
    def __init__(self,root,verify_identity,ownership=None):self.root=root;self.verify_identity=verify_identity;self.ownership=ownership or os.fchown
    def stage(self,id,binding,gid,files):
        need(re.fullmatch(r'[a-f0-9]{32}',id) and set(files)==set(NAMES) and type(gid) is int and gid>0);self.verify_identity(binding,gid);uid=binding['process']['uid'];need(os.getuid()==0 or (uid==os.getuid() and gid==os.getgid()));parent=private_root(self.root);tmp='.stage-'+id;fd=None;published=False
        try:
            os.mkdir(tmp,0o700,dir_fd=parent);fd=os.open(tmp,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
            for key,name in NAMES.items():
                b=files[key];need(type(b) in (bytes,bytearray) and 0<len(b)<=16384);f=os.open(name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=fd)
                try:need(os.write(f,b)==len(b));self.ownership(f,uid,gid);os.fchmod(f,0o400);os.fsync(f)
                finally:os.close(f)
            self.verify_identity(binding,gid);self.ownership(fd,uid,gid);os.fchmod(fd,0o700);os.fsync(fd)
            # No replacing rename: atomic directory publication is protected by
            # the issuer flock; collision refusal is checked before rename.
            try:os.stat(id,dir_fd=parent,follow_symlinks=False);raise Refusal()
            except FileNotFoundError:pass
            lib=C.CDLL(None,use_errno=True);rename=lib.renameat2;rename.argtypes=[C.c_int,C.c_char_p,C.c_int,C.c_char_p,C.c_uint];rename.restype=C.c_int;need(rename(parent,tmp.encode(),parent,id.encode(),1)==0);published=True;os.fsync(parent)
            s=os.fstat(fd);return {'device':str(s.st_dev),'inode':str(s.st_ino),'uid':uid,'gid':gid}
        finally:
            if fd is not None:os.close(fd)
            os.close(parent)
            # Incomplete private .stage-* is retained, never guessed or delivered.
    def open_verified(self,record,delivery=True):
        id=record['id'];need(re.fullmatch(r'[a-f0-9]{32}',id));r=record['receipt'];
        if delivery:self.verify_identity(r['binding'],record['gid'])
        parent=private_root(self.root)
        try:fd=os.open(id,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
        finally:os.close(parent)
        try:
            s=os.fstat(fd);meta=record['directory'];need(s.st_uid==meta['uid'] and s.st_gid==meta['gid'] and str(s.st_dev)==meta['device'] and str(s.st_ino)==meta['inode'] and stat.S_IMODE(s.st_mode)==0o700 and sorted(os.listdir(fd))==sorted(NAMES.values()))
            for key,name in NAMES.items():
                b,f=read_regular(fd,name,s.st_uid,0o400);need(f.st_gid==meta['gid'] and hashlib.sha256(b).hexdigest()==r['files'][key])
            return fd
        except Exception:os.close(fd);raise Refusal() from None
    def cleanup(self,record):
        # Cleanup is authorized by stored exact receipt/inode, not live process;
        # no delivery permission is restored for expired/revoked invocations.
        fd=self.open_verified(record,delivery=False)
        parent=private_root(self.root)
        try:
            for name in NAMES.values():os.unlink(name,dir_fd=fd)
            s=os.stat(record['id'],dir_fd=parent,follow_symlinks=False);need(str(s.st_dev)==record['directory']['device'] and str(s.st_ino)==record['directory']['inode']);os.rmdir(record['id'],dir_fd=parent);os.fsync(parent)
        finally:os.close(fd);os.close(parent)

class RecoverableIssuer:
    def __init__(self,journal,stage,authorize,now):self.journal=journal;self.stage=stage;self.authorize=authorize;self.now=now
    def revoked_grant(self,binding):return any(x['event']=='grant-revoked' and x['receipt']['grantSha256']==binding['grantSha256'] for x in self.journal.load())
    def revoke_pending(self,binding):self.journal.append('grant-revoked',binding['grantSha256'][:32],{'grantSha256':binding['grantSha256']})
    def issue(self,binding,gid,files,predecessor=None):
        binding=json.loads(canonical(binding));need(not self.revoked_grant(binding));need(not any(x['event']=='reserved' and x['receipt']['receipt']['binding']['invocationId']==binding['invocationId'] for x in self.journal.load()));self.authorize(binding,gid);need(self.now()+6000<binding['expiresAt']<=self.now()+600000)
        with authority_lock(self.stage.root):
            id=secrets.token_hex(16);pins={k:hashlib.sha256(v).hexdigest() for k,v in files.items()};need(set(pins)==set(NAMES));receipt={'version':1,'kind':'health-wallet-credential-stage','id':id,'generation':len(self.journal.load())+1,'binding':binding,'files':pins};record={'id':id,'receipt':receipt,'gid':gid,'directory':None,'issuer':self.journal.issuer}
            self.journal.append('reserved',id,record,predecessor)
            try:
                record['directory']=self.stage.stage(id,binding,gid,files);self.authorize(binding,gid);need(not self.revoked_grant(binding));self.journal.append('active',id,record,predecessor);return json.loads(canonical(record))
            except Exception:self.journal.append('indeterminate',id,record,predecessor);raise Refusal() from None
    def validate(self,record):
        state=self.journal.state(record['id']);need(state['event']=='active' and state['receipt']==record);r=record['receipt'];need(not self.revoked_grant(r['binding']) and self.now()<r['binding']['expiresAt']);self.authorize(r['binding'],record['gid']);fd=self.stage.open_verified(record);os.close(fd);need(self.journal.state(record['id'])['event']=='active');return r
    def revoke(self,record):
        state=self.journal.state(record['id']);need(state['receipt']==record);self.journal.append('revoked',record['id'],record,state['predecessor'])
    def rotate(self,old,binding,gid,files):
        state=self.journal.state(old['id']);need(state['event']=='active' and state['receipt']==old);previous=old['receipt']['binding'];need(all(binding[k]==previous[k] for k in ('run','deploymentSha256','service')) and binding['invocationId']!=previous['invocationId'] and binding['grantSha256']!=previous['grantSha256']);self.authorize(binding,gid);self.revoke(old);return self.issue(binding,gid,files,old['id'])
    def expire(self,record):
        need(self.journal.state(record['id'])['receipt']==record and self.now()>=record['receipt']['binding']['expiresAt']);self.journal.append('expired',record['id'],record)
    def cleanup(self,record):
        state=self.journal.state(record['id']);need(state['receipt']==record and state['event'] in ('revoked','expired'));self.stage.cleanup(record);self.journal.append('cleaned',record['id'],record,state['predecessor'])

class NativeIssuerBridge:
    """Versioned Node-facing wrapper; raw package paths/metadata stay local."""
    def __init__(self,issuer):self.issuer=issuer
    def public(self,record):return {'version':1,'kind':'health-wallet-native-credential-record','issuerSha256':self.issuer.journal.issuer,'gid':record['gid'],'receipt':record['receipt']}
    def resolve(self,public):
        need(set(public)=={'version','kind','issuerSha256','gid','receipt'} and public['version']==1 and public['kind']=='health-wallet-native-credential-record' and public['issuerSha256']==self.issuer.journal.issuer);record=self.issuer.journal.state(public['receipt']['id'])['receipt'];need(self.public(record)==public);return record
    def issue(self,binding,gid,files):return self.public(self.issuer.issue(binding,gid,files))
    def validate(self,public):return self.issuer.validate(self.resolve(public))
    def revoke(self,public):return self.issuer.revoke(self.resolve(public))
    def cleanup(self,public):return self.issuer.cleanup(self.resolve(public))
    def revoke_pending(self,binding):return self.issuer.revoke_pending(binding)
