"""Linux-only native peer and credential descriptor delivery, inactive on import."""
import os,socket,struct,array,hashlib,json,time,stat,re
from native_manager import need,Refusal,canonical
MAX_FRAME=65536

def peer_credentials(connection):
    need(connection.family==socket.AF_UNIX and hasattr(socket,'SO_PEERCRED'))
    pid,uid,gid=struct.unpack('3i',connection.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,struct.calcsize('3i')))
    need(pid>1 and uid>=0 and gid>=0);return {'pid':pid,'uid':uid,'gid':gid}

def verify_peer(connection,expected,observe,authorize):
    keys={'process','gid','unit','invocationId','grantSha256','expiresAt'};need(type(expected) is dict and set(expected)==keys and time.time()*1000<expected['expiresAt'])
    peer=peer_credentials(connection);p=expected['process'];need(peer=={'pid':p['pid'],'uid':p['uid'],'gid':expected['gid']});authorize(expected)
    actual=observe(expected['unit']);need(actual['snapshot']['identity']['invocationId']==expected['invocationId'] and actual['snapshot']['main']==p and actual['gid']==expected['gid']);need(peer_credentials(connection)==peer);return peer

def receive_frame(connection):
    connection.settimeout(1);chunks=[];size=0
    while True:
        b=connection.recv(min(4096,MAX_FRAME+1-size));need(b);size+=len(b);need(size<=MAX_FRAME);chunks.append(b)
        if b'\n' in b:break
    raw=b''.join(chunks);need(raw.endswith(b'\n') and b'\n' not in raw[:-1]);v=json.loads(raw);need(canonical(v)+b'\n'==raw);return v

class PeerGateway:
    """Actual SO_PEERCRED verification precedes existing HMAC dispatcher.

    Dispatcher runs in the trusted broker boundary, never an untrusted external
    JSON claim. Its input never gains a generic executable or unit selection.
    """
    def __init__(self,expected,observe,authorize,dispatch):self.expected=expected;self.observe=observe;self.authorize=authorize;self.dispatch=dispatch
    def handle(self,connection):
        try:
            verify_peer(connection,self.expected,self.observe,self.authorize);frame=receive_frame(connection);need(type(frame) is dict);
            if 'caller' in frame:need(frame['caller']==self.expected['process'])
            verify_peer(connection,self.expected,self.observe,self.authorize);value=self.dispatch(frame);connection.sendall(canonical(value)+b'\n')
        except Exception:
            raise Refusal() from None

NAMES={'aws':'aws-profile.json','postgres':'postgres-password.json','approval':'processing-approval.json','authorization':'runtime-authorization.json'}
def send_package(connection,expected,receipt,root_fd,observe,authorize):
    """Four regular-file descriptors, never pathname credentials or argv secrets."""
    verify_peer(connection,expected,observe,authorize);need(receipt['binding']['process']==expected['process'] and receipt['binding']['invocationId']==expected['invocationId']);fds=[]
    try:
        for key,name in NAMES.items():
            fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=root_fd);fds.append(fd);s=os.fstat(fd);need(stat.S_ISREG(s.st_mode) and s.st_uid==expected['process']['uid'] and s.st_gid==expected['gid'] and stat.S_IMODE(s.st_mode)==0o400 and s.st_nlink==1 and 0<s.st_size<=16384)
            b=os.read(fd,16385);need(len(b)==s.st_size and hashlib.sha256(b).hexdigest()==receipt['files'][key]);os.lseek(fd,0,os.SEEK_SET)
        verify_peer(connection,expected,observe,authorize);payload=canonical({'version':1,'kind':'health-wallet-credential-fds','receipt':receipt,'gid':expected['gid']});need(len(payload)<=8192)
        sent=connection.sendmsg([payload],[(socket.SOL_SOCKET,socket.SCM_RIGHTS,array.array('i',fds))]);need(sent==len(payload))
    finally:
        for fd in fds:os.close(fd)

def receive_package(connection,expected_broker,expected_receipt,gid,now=None,metadata=None):
    """Receiver validates broker kernel identity, receipt pins and each fd.

    Returned bytes are private in-memory capability data, never public receipts.
    Caller must feed the existing strict credential loader and wipe owned copies.
    """
    need(peer_credentials(connection)==expected_broker);fds=[]
    try:
        raw,ancillary,flags,_=connection.recvmsg(8193,socket.CMSG_SPACE(4*array.array('i').itemsize),socket.MSG_CMSG_CLOEXEC)
        for level,kind,b in ancillary:
            need(level==socket.SOL_SOCKET and kind==socket.SCM_RIGHTS);a=array.array('i');a.frombytes(b[:len(b)-len(b)%a.itemsize]);fds.extend(a)
        need(not flags&(socket.MSG_TRUNC|socket.MSG_CTRUNC) and len(fds)==4 and len(raw)<=8192);v=json.loads(raw);need(canonical(v)==raw and v=={'version':1,'kind':'health-wallet-credential-fds','receipt':expected_receipt,'gid':gid});need((now or (lambda:time.time()*1000))()<expected_receipt['binding']['expiresAt']);need(expected_receipt['binding']['process']['uid']==os.getuid() and gid==os.getgid());out={}
        for (key,_),fd in zip(NAMES.items(),fds):
            s=os.fstat(fd);need(stat.S_ISREG(s.st_mode) and s.st_uid==os.getuid() and s.st_gid==gid and s.st_nlink==1 and stat.S_IMODE(s.st_mode)==0o400 and 0<s.st_size<=16384);b=os.read(fd,16385);a=os.fstat(fd);need(len(b)==s.st_size and (a.st_ino,a.st_ctime_ns)==(s.st_ino,s.st_ctime_ns) and hashlib.sha256(b).hexdigest()==expected_receipt['files'][key]);out[key]=b
            if metadata is not None:metadata[key]={'kind':'file','uid':s.st_uid,'mode':stat.S_IMODE(s.st_mode),'links':s.st_nlink,'size':s.st_size,'device':str(s.st_dev),'inode':str(s.st_ino),'mtimeNs':str(s.st_mtime_ns),'ctimeNs':str(s.st_ctime_ns)}
        need(peer_credentials(connection)==expected_broker);return out
    except Exception:raise Refusal() from None
    finally:
        for fd in fds:os.close(fd)

class NativeHmacDispatcher:
    """Raw-string HMAC avoids cross-language locale/case JSON sort ambiguity.

    Duplicate keys are rejected by the decoder. Privileged bridge validates the
    complete operation schema independently after peer and MAC authentication.
    """
    def __init__(self,key,caller,bridge):need(type(key) is bytes and len(key)==32);self.key=key;self.caller=caller;self.bridge=bridge;self.used=set()
    def __call__(self,frame):
        import hmac
        need(set(frame)=={'version','body','mac'} and frame['version']==1 and type(frame['body']) is str and len(frame['body'].encode())<=65536 and type(frame['mac']) is str)
        need(hmac.compare_digest(hmac.new(self.key,frame['body'].encode(),'sha256').hexdigest(),frame['mac']))
        def no_duplicates(pairs):
            out={}
            for k,v in pairs:need(k not in out);out[k]=v
            return out
        body=json.loads(frame['body'],object_pairs_hook=no_duplicates);need(set(body)=={'version','nonce','caller','request'} and body['version']==1 and body['caller']==self.caller and re.fullmatch(r'[a-f0-9]{32}',body['nonce']) and body['nonce'] not in self.used and len(self.used)<4096);self.used.add(body['nonce']);result=self.bridge.request(body['request']);raw=canonical({'version':1,'nonce':body['nonce'],'result':result}).decode();return {'version':1,'body':raw,'mac':hmac.new(self.key,raw.encode(),'sha256').hexdigest()}

def serve_owned_native(listener,expected,observe,authorize,dispatch,expires_at,stopping):
    """Explicit bounded server loop over an independently provisioned Unix fd.

    Never binds or installs a socket/service. Root-owned descriptor/path and
    dedicated GID must agree. Caller must provision them at a separate gate.
    """
    need(os.getuid()==0 and listener.family==socket.AF_UNIX and listener.getsockopt(socket.SOL_SOCKET,socket.SO_ACCEPTCONN)==1)
    path=listener.getsockname();need(type(path) is str and re.fullmatch(r'/run/health-wallet-delivery/stage-c-[a-f0-9]{24}/native.sock',path));st=os.lstat(path);need(stat.S_ISSOCK(st.st_mode) and st.st_uid==0 and st.st_gid==expected['gid'] and stat.S_IMODE(st.st_mode)==0o660);need(time.time()*1000<expires_at<=time.time()*1000+600000)
    listener.settimeout(.2);count=0;gateway=PeerGateway(expected,observe,authorize,dispatch)
    while not stopping() and time.time()*1000<expires_at:
        try:connection,_=listener.accept()
        except socket.timeout:continue
        count+=1
        try:need(count<=4096);gateway.handle(connection)
        finally:connection.close()
