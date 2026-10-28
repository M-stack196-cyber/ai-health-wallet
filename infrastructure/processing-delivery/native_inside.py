"""Root-private fresh inside proofs, accepted only from the exact native peer.

Uses identity-only observation for bootstrap to avoid circularly trusting an
inside receipt before its producing peer has been authenticated. Full admission
still requires the freshly accepted inside proof and independent mount checks.
"""
import os,time,secrets,json,stat
from native_manager import need,Refusal,canonical
from native_peer import peer_credentials
from native_issuer import private_root,read_regular

class InsideReceiptStore:
    def __init__(self,root,observe_identity,now=None):self.root=root;self.observe=observe_identity;self.now=now or (lambda:time.time()*1000);self.pending={};self.files={}
    def challenge(self,name):
        proof=self.observe(name);need(proof and proof['snapshot']['main']);need(len(self.pending)<16);nonce=secrets.token_hex(16);self.pending[nonce]=(name,proof,self.now()+1000);return nonce
    def accept(self,connection,nonce,report):
        need(nonce in self.pending);name,before,expiry=self.pending.pop(nonce);need(self.now()<expiry and self.observe(name)==before);p=before['snapshot']['main'];gid=before['gid'];need(peer_credentials(connection)=={'pid':p['pid'],'uid':p['uid'],'gid':gid});need(type(report) is dict and set(report)=={'version','kind','nonce','process','gid','controlGroup','interfaces'} and report['version']==1 and report['kind']=='health-wallet-inside-challenge' and report['nonce']==nonce and report['process']==p and report['gid']==gid)
        group=before['snapshot']['identity']['controlGroup'];need(report['controlGroup']==group);parent=group.rsplit('/',1)[0] or '/';expected={group+'/cgroup.procs',group+'/cgroup.threads',group+'/cpu.max',group+'/memory.max',group+'/pids.max',parent+'/cgroup.procs','/cgroup.procs'};interfaces=report['interfaces'];need(type(interfaces) is list and len(interfaces)==len(expected) and {v['path'] for v in interfaces}==expected and all(set(v)=={'path','readOnly','writable','openDenied'} and v['readOnly'] is True and v['writable'] is False and v['openDenied'] is True for v in interfaces));need(self.observe(name)==before)
        receipt={'process':p,'gid':gid,'controlGroup':group,'protected':True,'observedAt':self.now()};fd=private_root(self.root);tmp='.proof-'+nonce;namefile='inside-'+name+'.json';f=None
        try:
            if name in self.files:
                st=os.stat(namefile,dir_fd=fd,follow_symlinks=False);need((st.st_dev,st.st_ino)==self.files[name])
            else:
                try:os.stat(namefile,dir_fd=fd,follow_symlinks=False);raise Refusal()
                except FileNotFoundError:pass
            f=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=fd);b=canonical(receipt);need(os.write(f,b)==len(b));os.fsync(f);os.close(f);f=None;os.rename(tmp,namefile,src_dir_fd=fd,dst_dir_fd=fd);os.fsync(fd);s=os.stat(namefile,dir_fd=fd,follow_symlinks=False);self.files[name]=(s.st_dev,s.st_ino)
        finally:
            if f is not None:os.close(f)
            os.close(fd)
        return receipt
    def read(self,name,process,gid):
        need(name in self.files);fd=private_root(self.root)
        try:b,s=read_regular(fd,'inside-'+name+'.json',os.getuid(),0o600,4096)
        finally:os.close(fd)
        r=json.loads(b);need((s.st_dev,s.st_ino)==self.files[name] and r['process']==process and r['gid']==gid and 0<=self.now()-r['observedAt']<=1000);return r
