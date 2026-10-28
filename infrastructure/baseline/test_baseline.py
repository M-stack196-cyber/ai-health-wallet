"""Synthetic baseline-tool checks. No application imports, network or DB operations."""
import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from baseline import (ROOT, MANIFEST, RECEIPT, SRS, SRS_SHA256, BaselineRefusal,
                      make_manifest, inventory, verify, snapshot, write_new, read_regular)
from run_offline import clean_environment, dependency_versions, summarize_node, summarize_python


class BaselineTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.base=Path(self.temp.name)
        self.root=self.base/'source';self.root.mkdir(mode=0o700)
        (self.root/'docs').mkdir();(self.root/SRS).write_bytes((ROOT/SRS).read_bytes())
        (self.root/'backend/src').mkdir(parents=True)
        (self.root/'backend/src/example.ts').write_text('export const synthetic=true;\n')
        (self.root/'backend/package.json').write_text('{"private":true}')
        (self.root/'docs/baselines').mkdir()

    def tearDown(self): self.temp.cleanup()

    def pin(self):
        m=make_manifest(self.root);write_new(self.root/MANIFEST,m);return m

    def test_deterministic_inventory(self): self.assertEqual(make_manifest(self.root),make_manifest(self.root))

    def test_zero_spend_disabled_pending_policy(self):
        p=make_manifest(self.root)['policy']
        self.assertFalse(p['paid_ai_api_usage_allowed']);self.assertFalse(p['hosted_ai_fallback_allowed'])
        self.assertFalse(p['workers_enabled']);self.assertFalse(p['real_generation_authorized'])
        self.assertEqual(p['srs_amendment_status'],'pending_formal_resolution')

    def test_secret_and_generated_files_excluded_before_read(self):
        for name in ['backend/.env','backend/.env.migrations','docs/.env','docs/private.key','docs/output.log']:
            (self.root/name).write_text('SYNTHETIC_SECRET_SENTINEL')
        for name in ['docs/.aws','docs/.ssh','docs/.private-evidence','backend/src/node_modules']:
            p=self.root/name;p.mkdir(parents=True);(p/'secret.json').write_text('SYNTHETIC_SECRET_SENTINEL')
        calls=[];real=read_regular
        with patch('baseline.read_regular',side_effect=lambda p:(calls.append(str(p)),real(p))[1]):m=make_manifest(self.root)
        self.assertFalse(any('.env' in p or p.endswith('secret.json') for p in calls))
        self.assertNotIn('SYNTHETIC_SECRET',json.dumps(m))

    def test_source_and_lockfiles_pinned(self):
        (self.root/'backend/package-lock.json').write_text('{"lockfileVersion":3}')
        p={x['path'] for x in make_manifest(self.root)['files']}
        self.assertIn('backend/package-lock.json',p);self.assertIn('backend/src/example.ts',p)

    def test_symlink_source_file_refused(self):
        (self.root/'backend/src/linked.ts').symlink_to(self.root/'backend/src/example.ts')
        with self.assertRaises((BaselineRefusal,OSError)):make_manifest(self.root)

    def test_symlink_source_directory_refused(self):
        (self.root/'docs/linked').symlink_to(self.root/'backend/src',target_is_directory=True)
        with self.assertRaises(BaselineRefusal):make_manifest(self.root)

    def test_symlink_intermediate_scope_refused(self):
        import shutil
        shutil.rmtree(self.root/'backend')
        other=self.base/'other';(other/'src').mkdir(parents=True)
        (self.root/'backend').symlink_to(other,target_is_directory=True)
        with self.assertRaises(BaselineRefusal):make_manifest(self.root)

    def test_modified_source_refused(self):
        self.pin();(self.root/'backend/src/example.ts').write_text('changed')
        with self.assertRaises(BaselineRefusal):verify(self.root)

    def test_deleted_source_refused(self):
        self.pin();(self.root/'backend/src/example.ts').unlink()
        with self.assertRaises(BaselineRefusal):verify(self.root)

    def test_new_source_refused(self):
        self.pin();(self.root/'backend/src/new.ts').write_text('new')
        with self.assertRaises(BaselineRefusal):verify(self.root)

    def test_authority_pin_refused(self):
        (self.root/SRS).write_bytes(b'SYNTHETIC_WRONG_AUTHORITY')
        with self.assertRaises(BaselineRefusal):make_manifest(self.root)

    def test_generated_receipt_is_not_self_pinned(self):
        expected=self.pin();write_new(self.root/RECEIPT,{'synthetic':True})
        self.assertEqual(verify(self.root),expected)

    def test_snapshot_excludes_environment_and_private_evidence(self):
        (self.root/'backend/.env').write_text('SYNTHETIC_SECRET')
        self.pin();target=snapshot(self.base/'snapshot',self.root)
        self.assertFalse((target/'backend/.env').exists())
        self.assertFalse((target/'.private-evidence').exists())
        self.assertEqual(verify(target),verify(self.root))

    def test_snapshot_refuses_existing_destination(self):
        self.pin();target=self.base/'taken';target.mkdir()
        with self.assertRaises(BaselineRefusal):snapshot(target,self.root)

    def test_snapshot_refuses_source_destination(self):
        self.pin()
        with self.assertRaises(BaselineRefusal):snapshot(self.root/'snapshot',self.root)

    def test_snapshot_refuses_public_parent(self):
        self.pin();parent=self.base/'public';parent.mkdir(mode=0o755)
        with self.assertRaises(BaselineRefusal):snapshot(parent/'snapshot',self.root)

    def test_read_refuses_non_regular_and_oversize(self):
        with self.assertRaises(BaselineRefusal):read_regular(self.root/'docs')
        p=self.base/'huge';p.write_bytes(b'')
        with p.open('r+b') as f:f.truncate(16777217)
        with self.assertRaises(BaselineRefusal):read_regular(p)

    def test_read_detects_mutation(self):
        p=self.base/'mutable';p.write_bytes(b'original');real=os.read;changed=False
        def read(fd,n):
            nonlocal changed
            b=real(fd,n)
            if not changed:changed=True;p.write_bytes(b'modified contents')
            return b
        with patch('baseline.os.read',side_effect=read):
            with self.assertRaises(BaselineRefusal):read_regular(p)

    def test_output_refuses_overwrite_and_symlink(self):
        p=self.base/'receipt';write_new(p,{'synthetic':True})
        with self.assertRaises(FileExistsError):write_new(p,{})
        link=self.base/'link';link.symlink_to(p)
        with self.assertRaises(OSError):write_new(link,{})

    def test_child_environment_does_not_inherit_credentials_or_proxies(self):
        with patch.dict(os.environ,{'OPENAI_API_KEY':'SYNTHETIC_SECRET','AWS_SECRET_ACCESS_KEY':'SYNTHETIC_SECRET','HTTPS_PROXY':'SYNTHETIC_SECRET'}):
            env=clean_environment(self.base,self.root,self.base/'deps',Path('/usr/bin/node'))
        self.assertFalse(any(k in env for k in ('OPENAI_API_KEY','AWS_SECRET_ACCESS_KEY','HTTPS_PROXY','HOME')))
        self.assertEqual(env['PROCESSING_SERVICE_ENABLED'],'false')
        self.assertEqual(env['SUMMARY_EXECUTOR_ENABLED'],'false')

    def test_count_parsing_never_invents_passes(self):
        self.assertEqual(summarize_python('missing import'),{'tests':0,'passed':False})
        self.assertEqual(summarize_python('Ran 3 tests in 1s\n\nOK\n'),{'tests':3,'passed':True})
        self.assertEqual(summarize_node('# tests 4\n# pass 3\n# fail 0\n# skipped 1\n')['skipped'],1)

    def test_missing_dependencies_are_reported_as_none(self):
        from importlib.metadata import PackageNotFoundError
        with patch('run_offline.metadata.version',side_effect=PackageNotFoundError):
            self.assertTrue(all(x is None for x in dependency_versions().values()))

    def test_cli_rejects_live_or_model_arguments(self):
        p=subprocess.run([sys.executable,str(ROOT/'infrastructure/baseline/baseline.py'),'--run'],capture_output=True,timeout=5)
        self.assertEqual(p.returncode,2)

    def test_python_child_guards_refuse_network_and_credential_reads(self):
        env={'PATH':'/usr/bin:/bin','PYTHONNOUSERSITE':'1','PYTHONDONTWRITEBYTECODE':'1',
             'PYTHONPATH':str(ROOT/'infrastructure/baseline/guards'),
             'B01_SCRATCH_ROOT':str(self.base)}
        script="""import socket
from pathlib import Path
count=0
try: socket.create_connection(('127.0.0.1',11434))
except RuntimeError: count+=1
try: Path('/unowned/.aws/credentials').read_bytes()
except RuntimeError: count+=1
print(count)
"""
        p=subprocess.run([sys.executable,'-c',script],env=env,capture_output=True,timeout=5)
        self.assertEqual(p.returncode,0);self.assertEqual(p.stdout.strip(),b'2')

    def test_node_child_guards_refuse_generation_connection_and_credential_reads(self):
        import shutil
        node=shutil.which('node')
        self.assertIsNotNone(node)
        env={'PATH':str(Path(node).parent)+':/usr/bin:/bin','TMPDIR':str(self.base),
             'B01_SCRATCH_ROOT':str(self.base)}
        script="""import net from 'node:net';import fs from 'node:fs';
let count=0;
try{net.connect({host:'127.0.0.1',port:11434});}catch{count++;}
try{fs.readFileSync('/unowned/.aws/credentials');}catch{count++;}
console.log(count);
"""
        p=subprocess.run([node,'--import',str(ROOT/'infrastructure/baseline/node-network-guard.mjs'),
            '--input-type=module','-e',script],env=env,capture_output=True,timeout=5)
        self.assertEqual(p.returncode,0);self.assertEqual(p.stdout.strip(),b'2')


if __name__=='__main__':unittest.main()
