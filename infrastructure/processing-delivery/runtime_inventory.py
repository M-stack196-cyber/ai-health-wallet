"""Offline runtime inventory helpers. Never executes an artifact or loader.

Explicit assembler inputs must be independently reviewed/pinned before validation.
No host scan, credential loading or automatic release installation at import time.
"""
import hashlib
import os
from pathlib import Path
import stat
import struct

class InventoryRefusal(Exception):
    def __init__(self): super().__init__('RUNTIME_INVENTORY_REFUSED')

def need(value):
    if not value: raise InventoryRefusal()

def elf_dependencies(raw):
    """ELF64 LE/BE program-header discovery, without ldd or loading the binary.

    Returns interpreter, DT_NEEDED and RPATH/RUNPATH for explicit resolution.
    Unknown ELF class, malformed offsets and duplicate dynamic strings refuse.
    """
    need(isinstance(raw,bytes) and 64<=len(raw)<=134217728 and raw[:4]==b'\x7fELF')
    need(raw[4]==2 and raw[5] in (1,2) and raw[6]==1)
    endian='<' if raw[5]==1 else '>'
    def unpack(fmt,off):
        size=struct.calcsize(endian+fmt);need(0<=off<=len(raw)-size)
        return struct.unpack_from(endian+fmt,raw,off)
    phoff=unpack('Q',32)[0];entsize,count=unpack('HH',54);need(entsize==56 and 1<=count<=1024)
    segments=[];dynamic=None;interpreter=None
    for i in range(count):
        typ,flags,off,addr,physical,filesz,memsz,align=unpack('IIQQQQQQ',phoff+i*entsize)
        need(off+filesz<=len(raw));segments.append((typ,off,addr,filesz))
        if typ==2: need(dynamic is None);dynamic=(off,filesz)
        if typ==3:
            need(interpreter is None);interpreter=raw[off:off+filesz].rstrip(b'\0').decode('ascii');need(interpreter.startswith('/') and '..' not in interpreter.split('/'))
    if not dynamic: return {'interpreter':interpreter,'needed':[],'search_paths':[]}
    off,size=dynamic;need(size%16==0);entries=[];terminated=False
    for at in range(off,off+size,16):
        tag,value=unpack('qQ',at)
        if tag==0: terminated=True;break
        entries.append((tag,value))
    need(terminated)
    tables=[v for t,v in entries if t==5];sizes=[v for t,v in entries if t==10]
    need(len(tables)==1 and len(sizes)==1 and 0<sizes[0]<=1048576)
    mapped=[o+tables[0]-v for t,o,v,s in segments if t==1 and v<=tables[0] and tables[0]+sizes[0]<=v+s]
    need(len(mapped)==1);start=mapped[0];end=start+sizes[0]
    def string(offset):
        need(offset<sizes[0]);nul=raw.find(b'\0',start+offset,end);need(nul>=0)
        text=raw[start+offset:nul].decode('ascii');need(0<len(text)<=4096 and '\n' not in text and '\r' not in text);return text
    needed=[string(v) for t,v in entries if t==1]
    need(len(set(needed))==len(needed) and all('/' not in x and x not in ('.','..') for x in needed))
    search=[string(v) for t,v in entries if t in (15,29)]
    return {'interpreter':interpreter,'needed':needed,'search_paths':search}

def inventory_tree(root,relative_roots):
    """Explicit immutable package roots only; all files included, no symlinks.

    Root ownership is a deployment requirement, independently checked by Node.
    This assembler can inspect caller-owned synthetic packaging fixtures offline.
    """
    root=Path(root);need(root.is_absolute() and not root.is_symlink())
    found=[];total=0
    for item in relative_roots:
        rel=Path(item);need(not rel.is_absolute() and '..' not in rel.parts and '.' not in rel.parts)
        paths=[root/rel]
        while paths:
            path=paths.pop();s=path.lstat();need(not stat.S_ISLNK(s.st_mode))
            if stat.S_ISDIR(s.st_mode):
                children=sorted(path.iterdir(),key=lambda x:x.name);need(len(children)<=32768);paths.extend(reversed(children));continue
            need(stat.S_ISREG(s.st_mode) and s.st_nlink==1 and 0<s.st_size<=134217728 and s.st_mode&0o022==0)
            fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
            try:
                before=os.fstat(fd);need((s.st_dev,s.st_ino)==(before.st_dev,before.st_ino))
                digest=hashlib.sha256();used=0
                while True:
                    block=os.read(fd,65536)
                    if not block:break
                    used+=len(block);need(used<=s.st_size);digest.update(block)
                after=os.fstat(fd);need((before.st_size,before.st_mtime_ns,before.st_ctime_ns)==(after.st_size,after.st_mtime_ns,after.st_ctime_ns) and used==s.st_size)
            finally:os.close(fd)
            total+=1;need(total<=32768)
            found.append({'path':str(path),'sha256':digest.hexdigest(),'bytes':s.st_size,'uid':s.st_uid,'mode':s.st_mode&0o777,'type':'file'})
    need(len({x['path'] for x in found})==len(found));return sorted(found,key=lambda x:x['path'])
