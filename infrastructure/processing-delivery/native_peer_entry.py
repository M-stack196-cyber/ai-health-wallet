"""Purpose-specific SO_PEERCRED helper. No socket connect/bind or service control."""
import sys,socket,struct,json,os

def main(args):
    if args!=['--peer-fd3']:
        print('{"service":"health-wallet-peer-helper","event":"disabled"}');return 0
    try:
        s=socket.socket(fileno=os.dup(3))
        try:
            if s.family!=socket.AF_UNIX:raise ValueError()
            pid,uid,gid=struct.unpack('3i',s.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
            if pid<=1 or uid<0 or gid<0:raise ValueError()
            print(json.dumps({'pid':pid,'uid':uid,'gid':gid},separators=(',',':')));return 0
        finally:s.close()
    except Exception:return 1
if __name__=='__main__':raise SystemExit(main(sys.argv[1:]))
