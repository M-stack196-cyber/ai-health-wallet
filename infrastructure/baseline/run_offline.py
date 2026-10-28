"""Explicit B01 fake-regression runner in a pinned, credential-free snapshot.

No package install, Docker, AWS, PostgreSQL, model or service-management command.
Missing Python service dependencies are BLOCKED, not counted as passing tests.
"""
import argparse
import hashlib
from importlib import metadata
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

from baseline import ROOT, MANIFEST, RECEIPT, verify, snapshot, write_new, digest, read_regular


def file_digest(path):
    with open(path, "rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def dependency_versions():
    versions={}
    for name in ('fastapi','starlette','pydantic','httpx','jsonschema'):
        try: versions[name]=metadata.version(name)
        except metadata.PackageNotFoundError: versions[name]=None
    return versions


def clean_environment(scratch, source, deps, node):
    # Explicit allowlist: no inherited credentials, dotenv controls, proxy or PATH hooks.
    return {'PATH':str(node.parent)+':/usr/local/bin:/usr/bin:/bin',
        'LANG':'C.UTF-8','TMPDIR':str(scratch/'tmp'),
        'PYTHONDONTWRITEBYTECODE':'1','PYTHONNOUSERSITE':'1',
        'PYTHONPATH':os.pathsep.join(str(scratch/'snapshot'/p) for p in
            ('infrastructure/baseline/guards','ai-service','ai-service/tests','infrastructure/baseline')),
        'NODE_OPTIONS':'--import='+str(scratch/'snapshot/infrastructure/baseline/node-network-guard.mjs'),
        'SUMMARY_TEST_PYTHON':sys.executable,
        'PROCESSING_SERVICE_ENABLED':'false','SUMMARY_EXECUTOR_ENABLED':'false',
        'DOCUMENT_STORAGE_ENABLED':'false','AWS_EC2_METADATA_DISABLED':'true',
        'B01_SCRATCH_ROOT':str(scratch),'B01_SOURCE_ROOT':str(source),
        'B01_DEPENDENCY_ROOT':str(deps)}


def node_test_files(root):
    patterns=('backend/src/summary-checks/*.check.ts','backend/src/summary-checks/*.service.ts',
        'backend/src/summary-checks/*.unit.ts','backend/src/integration-checks/live-s3-ocr.check.ts',
        'backend/src/background-checks/*.check.ts','backend/src/canary-checks/*.check.ts')
    return sorted({str(p) for pattern in patterns for p in root.glob(pattern)})


def summarize_python(raw):
    m=re.search(r'Ran (\d+) tests?',raw)
    return {'tests':int(m[1]) if m else 0,'passed':bool(m and re.search(r'^OK\s*$',raw,re.M))}


def summarize_node(raw):
    def number(label):
        m=re.search(r'^# '+label+r' (\d+)$',raw,re.M);return int(m[1]) if m else 0
    return {k:number(k) for k in ('tests','pass','fail','cancelled','skipped')}


def run(output):
    original=verify()
    node_path=shutil.which('node')
    if not node_path: raise RuntimeError('B01_NODE_UNAVAILABLE')
    node=Path(node_path).resolve()
    deps=(ROOT/'backend/node_modules').resolve()
    if not (deps/'tsx/dist/cli.mjs').is_file(): raise RuntimeError('B01_NODE_DEPENDENCIES_UNAVAILABLE')
    scratch=Path(tempfile.mkdtemp(prefix='health-wallet-b01-'))
    os.chmod(scratch,0o700)
    (scratch/'tmp').mkdir(mode=0o700)
    target=snapshot(scratch/'snapshot')
    # Dependency code is reused explicitly, never the project's .env/home/evidence.
    (target/'backend/node_modules').symlink_to(deps,target_is_directory=True)
    env=clean_environment(scratch,ROOT,deps,node)
    versions=dependency_versions()
    required={'fastapi':'0.158.1','starlette':'1.9.0','pydantic':'2.14.1','httpx':'0.28.1','jsonschema':'4.10.3'}
    service_ready=all(versions[k]==v for k,v in required.items())
    suites=[('baseline-unit',[sys.executable,'-m','unittest','test_baseline'],target),
        ('python-regressions',[sys.executable,'-m','unittest',
          'test_contracts','test_evaluation','test_benchmark','test_ollama_local',
          *(['test_service'] if service_ready else [])],target)]
    node_args=[str(node),str(deps/'tsx/dist/cli.mjs'),'--test','--test-reporter=tap','--test-concurrency=1']
    if not service_ready:
        node_args+=['--test-name-pattern=^(?!mocked Node client and in-process FastAPI)']
    suites += [('typescript-fake-regressions',node_args+node_test_files(target),target/'backend'),
        ('contract-compatibility',[sys.executable,str(target/'ai-service/tools/generate_contracts.py'),'--check'],target),
        ('typecheck',[str(node),str(deps/'typescript/bin/tsc'),'--noEmit'],target/'backend'),
        ('build',[str(node),str(deps/'typescript/bin/tsc')],target/'backend'),
        ('disabled-ocr-entry',[str(node),str(target/'backend/dist/processing/background-entry.js')],target/'backend'),
        ('disabled-summary-entry',[str(node),str(target/'backend/dist/summaries/executor-entry.js')],target/'backend')]
    tool_versions={'python':sys.version.split()[0],'node':subprocess.check_output([str(node),'--version'],env=env,text=True).strip(),
                   'python_dependencies':versions,'node_sha256':file_digest(node)}
    results=[]
    for label,args,cwd in suites:
        try:
            p=subprocess.run(args,cwd=cwd,env=env,capture_output=True,timeout=300,check=False)
            raw=(p.stdout+p.stderr).decode(errors='replace')
            if len(raw.encode())>4194304: raise RuntimeError('OUTPUT_LIMIT')
            fd=os.open(scratch/(label+'.log'),os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
            with os.fdopen(fd,'w') as f:f.write(raw)
            row={'suite':label,'exit_code':p.returncode,'log_sha256':hashlib.sha256(raw.encode()).hexdigest()}
            if label in ('baseline-unit','python-regressions'): row.update(summarize_python(raw))
            elif label=='typescript-fake-regressions': row.update(summarize_node(raw))
            if label.startswith('disabled-'):
                expected='document-processing' if label=='disabled-ocr-entry' else 'medical-summary-executor'
                row['disabled_verified']=json.loads(raw)=={'service':expected,'event':'disabled'}
            results.append(row)
            if p.returncode or row.get('disabled_verified') is False: break
        except Exception:
            results.append({'suite':label,'exit_code':1,'failure':'B01_CHECK_REFUSED'});break
    source_unchanged=verify()==original
    blocked=[] if service_ready else ['python-fastapi-service-suite','node-client-asgi-parity-test']
    receipt={'schema_version':1,'kind':'health-wallet-b01-offline-validation',
        'source_tree_sha256':original['source_tree_sha256'],'toolchain':tool_versions,
        'suites':results,'all_executed_checks_passed':len(results)==len(suites) and all(r['exit_code']==0 for r in results),
        'full_851_regression_verified':not blocked and len(results)==len(suites) and all(r['exit_code']==0 for r in results) and any(r.get('suite')=='python-regressions' and r.get('tests')==341 and r.get('passed') for r in results) and any(r.get('suite')=='typescript-fake-regressions' and r.get('pass')==510 and not r.get('skipped') and not r.get('fail') for r in results),
        'blocked_checks':blocked,'blocked_dependency_versions':{k:v for k,v in required.items() if versions[k]!=v},
        'source_unchanged':source_unchanged,'snapshot_excludes_secrets':True,
        'generation_calls':0,'live_database_operations':0,'cloud_operations':0,
        'systemd_operations':0,'paid_ai_spend_microusd':0,
        'private_diagnostic_directory':str(scratch),
        'disposable_postgresql_suites':'not_authorized_not_run'}
    write_new(output,receipt)
    print(json.dumps({'checks_passed':receipt['all_executed_checks_passed'],
        'blocked_checks':blocked,'receipt':str(output)},sort_keys=True))
    return 0 if receipt['all_executed_checks_passed'] else 1


def main():
    p=argparse.ArgumentParser(description='Explicit offline fake checks only, never disposable/live DB or AI execution')
    p.add_argument('--run-offline',action='store_true',required=True)
    p.add_argument('--receipt',type=Path,required=True)
    args=p.parse_args()
    try:return run(args.receipt)
    except Exception:
        print('B01_OFFLINE_CHECKS_REFUSED');return 1


if __name__=='__main__':raise SystemExit(main())
