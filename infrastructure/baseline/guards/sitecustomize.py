"""B01 test-process network guard, loaded only via explicit snapshot PYTHONPATH."""
import socket

def refused(*args, **kwargs): raise RuntimeError('B01_TEST_NETWORK_REFUSED')

socket.socket.connect=refused
socket.socket.connect_ex=refused
socket.create_connection=refused
socket.getaddrinfo=refused

import os
import sys

def credential_guard(event,args):
    if event != 'open' or not args or not isinstance(args[0],(str,bytes,os.PathLike)): return
    p=os.path.abspath(os.fsdecode(args[0]))
    scratch=os.environ.get('B01_SCRATCH_ROOT')
    if scratch and p.startswith(os.path.abspath(scratch)+os.sep): return
    if any(x in ('.aws','.ssh','.env','.env.migrations') for x in p.split(os.sep)):
        raise RuntimeError('B01_CREDENTIAL_READ_REFUSED')
sys.addaudithook(credential_guard)
