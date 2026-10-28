"""Private pipe receiver. Never logs material; default is inert.

Only an explicitly inherited, connected Unix fd3 is accepted. Expected receipt
and root broker process identity arrive on stdin, never command arguments.
"""
import sys,os,socket,json,base64,re
from pathlib import Path

def process_identity(pid):
    if type(pid) is not int or pid<=1:raise ValueError()
    def read(name,limit):
        fd=os.open('/proc/'+str(pid)+'/'+name,os.O_RDONLY|os.O_NOFOLLOW)
        try:
            b=os.read(fd,limit+1)
            if len(b)>limit:raise ValueError()
            return b.decode()
        finally:os.close(fd)
    first=read('stat',8192);status=read('status',16384);last=read('stat',8192)
    def start(raw):return raw[raw.rfind(') ')+2:].split()[19]
    if start(first)!=start(last):raise ValueError()
    uid=re.search(r'^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$',status,re.M);gid=re.search(r'^Gid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$',status,re.M)
    if not uid or not gid or len(set(uid.groups()))!=1 or len(set(gid.groups()))!=1:raise ValueError()
    boot=Path('/proc/sys/kernel/random/boot_id').read_text().strip();return {'process':{'pid':pid,'uid':int(uid[1]),'startTime':start(last),'bootId':boot},'gid':int(gid[1])}

def main(args):
    if args!=['--receive-fd3']:
        print('{"service":"health-wallet-native-credential-receiver","event":"disabled"}');return 0
    # Parent pins this helper AND all three sibling modules before execution.
    sys.path.insert(0,str(Path(__file__).absolute().parent))
    from native_peer import receive_package,peer_credentials
    try:
        raw=sys.stdin.buffer.read(16385)
        if len(raw)>16384:return 1
        selected=json.loads(raw)
        if set(selected)!={'server','record'}:return 1
        server=selected['server'];record=selected['record'];
        if os.getuid()<=0 or not re.fullmatch(r'[a-f0-9]{32}',record['receipt']['id']):return 1
        s=socket.socket(fileno=os.dup(3));s.settimeout(.5)
        try:
            if server['process']['uid']!=0 or process_identity(server['process']['pid'])!=server:return 1
            peer={'pid':server['process']['pid'],'uid':0,'gid':server['gid']};metadata={};files=receive_package(s,peer,record['receipt'],record['gid'],metadata=metadata)
            if process_identity(server['process']['pid'])!=server:return 1
            r=record['receipt'];directory={'kind':'directory','uid':r['binding']['process']['uid'],'mode':0o700,'links':1,'size':0,'device':'0','inode':str(int(r['id'],16)),'mtimeNs':'0','ctimeNs':'0'}
            packet={'version':1,'kind':'health-wallet-received-descriptors','record':record,'directory':directory,'files':{k:{'identity':metadata[k],'base64':base64.b64encode(v).decode()} for k,v in files.items()}}
            sys.stdout.buffer.write(json.dumps(packet,sort_keys=True,separators=(',',':')).encode());sys.stdout.buffer.flush();return 0
        finally:s.close()
    except Exception:return 1
if __name__=='__main__':raise SystemExit(main(sys.argv[1:]))
