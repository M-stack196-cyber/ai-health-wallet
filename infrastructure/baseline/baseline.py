"""B01 source/test inventory and credential-free snapshot; no application imports.

Explicit maintenance CLI only. Never executes tests, migrations, workers or models.
Pins detect drift; reviewed manifest hashes/version control supply the trust root.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import stat

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = 'docs/baselines/B01_SOURCE_MANIFEST.json'
RECEIPT = 'docs/baselines/B01_VALIDATION_RECEIPT.json'
SRS = 'docs/AI_Health_Wallet_Final_SRS_v3.docx'
SRS_SHA256 = 'e401b0aaa64f0a8ef4f393eb1a8f41dd8b029c7166728b34aa6c2e478c19c591'
ROOTS = ('ai-service','backend/src','backend/migrations','docs','infrastructure','shared','mobile','web')
EXPLICIT = ('.gitignore','backend/package.json','backend/package-lock.json','backend/tsconfig.json')
IGNORE_DIRS = frozenset(('.git','.private-evidence','.aws','.ssh','node_modules','dist',
                        '__pycache__','.venv','.pytest_cache','coverage'))
SUFFIXES = frozenset(('.py','.ts','.sql','.json','.md','.mjs','.js','.yml','.yaml','.docx','.txt'))
OUTPUTS = frozenset((MANIFEST, RECEIPT))


class BaselineRefusal(Exception):
    def __init__(self): super().__init__('B01_BASELINE_REFUSED')


def canonical(value):
    return json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False,allow_nan=False).encode()


def digest(raw): return hashlib.sha256(raw).hexdigest()


def eligible(name):
    return (not name.startswith('.') and not name.endswith(('.pem','.key','.log'))
            and (Path(name).suffix in SUFFIXES or name == 'Dockerfile'))


def read_regular(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_size > 16777216:
            raise BaselineRefusal()
        parts = []
        while True:
            b = os.read(fd, 65536)
            if not b: break
            parts.append(b)
            if sum(map(len,parts)) > 16777216: raise BaselineRefusal()
        after = os.fstat(fd)
        if (before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns) != (
                after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns):
            raise BaselineRefusal()
        return b''.join(parts)
    finally: os.close(fd)


def inventory(root=ROOT):
    root = Path(root)
    if root.is_symlink(): raise BaselineRefusal()
    paths = set()
    for base in ROOTS:
        scope = root / base
        at = root
        for part in Path(base).parts:
            at = at / part
            if at.is_symlink(): raise BaselineRefusal()
        if not scope.exists(): continue
        for directory, dirs, files in os.walk(scope, followlinks=False):
            dirs[:] = sorted(d for d in dirs if d not in IGNORE_DIRS and not d.startswith('.'))
            for d in dirs:
                if (Path(directory)/d).is_symlink(): raise BaselineRefusal()
            for name in sorted(files):
                rel = (Path(directory)/name).relative_to(root).as_posix()
                # Secrets/output paths rejected before reading or following links.
                if eligible(name) and rel not in OUTPUTS:
                    paths.add(rel)
    paths.update(p for p in EXPLICIT if (root/p).exists() or (root/p).is_symlink())
    rows = []
    for rel in sorted(paths):
        data = read_regular(root/rel)
        rows.append({'path':rel,'bytes':len(data),'sha256':digest(data)})
    return rows


def make_manifest(root=ROOT):
    files = inventory(root)
    by_path = {r['path']:r for r in files}
    if SRS not in by_path or by_path[SRS]['sha256'] != SRS_SHA256:
        raise BaselineRefusal()
    tests = [r['path'] for r in files if (r['path'].startswith('ai-service/tests/test_')
        or '/baseline/test_' in r['path'] or r['path'].endswith(('.test.ts','.check.ts','.unit.ts','.service.ts','.canary.ts')))]
    return {'schema_version':1,'kind':'health-wallet-b01-source-test-baseline',
        'authority':{'path':SRS,'sha256':SRS_SHA256},'source_tree_sha256':digest(canonical(files)),
        'files':files,'test_files':tests,'primary_requirements':44,'tracked_clauses':88,
        'policy':{'paid_ai_api_usage_allowed':False,'hosted_ai_fallback_allowed':False,
            'development_ai_direction':'local-inference','real_generation_authorized':False,
            'srs_amendment_status':'pending_formal_resolution','workers_enabled':False,
            'disposable_database_execution_authorized':False,'live_operations_authorized':False},
        'excluded_outputs':sorted(OUTPUTS),
        'excluded_capabilities':['credentials','developer-env-files','private-evidence','AWS','database','Ollama','systemd'],
        'note':'Source inventory only. Not a real-model, deployed-system or clinical acceptance receipt.'}


def verify(root=ROOT):
    expected = json.loads(read_regular(Path(root)/MANIFEST))
    if expected != make_manifest(root): raise BaselineRefusal()
    return expected


def write_new(path, value):
    fd = os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'wb') as f: f.write(json.dumps(value,sort_keys=True,indent=2,ensure_ascii=False).encode()+b'\n')


def snapshot(destination, root=ROOT):
    """Copy pinned public source only into a NEW private caller-owned directory.

    node_modules/runtime dependencies are deliberately NOT copied or resolved here.
    Tests may explicitly link the reviewed local dependencies after snapshot checks.
    """
    manifest = verify(root)
    destination = Path(destination)
    if destination.exists() or destination.is_symlink(): raise BaselineRefusal()
    # A relative path or destination within the source tree can pollute the ledger.
    if not destination.is_absolute() or destination.is_relative_to(Path(root).resolve()):
        raise BaselineRefusal()
    parent = destination.parent
    if parent.is_symlink() or not parent.is_dir() or parent.stat().st_uid != os.getuid() or parent.stat().st_mode & 0o077:
        raise BaselineRefusal()
    destination.mkdir(mode=0o700)
    for row in manifest['files']:
        data = read_regular(Path(root)/row['path'])
        if len(data) != row['bytes'] or digest(data) != row['sha256']: raise BaselineRefusal()
        path = destination/row['path']
        path.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
        fd = os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
        with os.fdopen(fd,'wb') as f: f.write(data)
    (destination/MANIFEST).parent.mkdir(mode=0o700,parents=True,exist_ok=True)
    write_new(destination/MANIFEST,manifest)
    # Detect drift during copying. Never clean up/delete on ambiguous failure.
    verify(root)
    verify(destination)
    return destination


def main():
    parser=argparse.ArgumentParser(description='Offline B01 inventory only; no processing or database mode')
    group=parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--check',action='store_true')
    group.add_argument('--prepare-manifest',type=Path)
    group.add_argument('--snapshot',type=Path)
    args=parser.parse_args()
    try:
        if args.prepare_manifest: write_new(args.prepare_manifest,make_manifest())
        elif args.snapshot: snapshot(args.snapshot)
        else: verify()
        print('PASS: B01 baseline'); return 0
    except Exception:
        print('B01_BASELINE_REFUSED'); return 1


if __name__=='__main__': raise SystemExit(main())
