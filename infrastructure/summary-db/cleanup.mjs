// Exact-resource reconciliation for this disposable harness only. No broad Docker cleanup.
import {readFile,writeFile,lstat} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {dirname,join} from 'node:path';
if(process.argv.length!==5||process.argv[2]!=='--manifest'||process.argv[4]!=='--approve-test-cleanup')throw Error('Explicit test cleanup invocation required');
const path=process.argv[3],info=await lstat(path),parent=await lstat(dirname(path));
if(!info.isFile()||info.isSymbolicLink()||info.uid!==process.getuid()||(info.mode&0o777)!==0o600||parent.uid!==process.getuid()||(parent.mode&0o777)!==0o700)throw Error('Private owned manifest required');
const m=JSON.parse(await readFile(path,'utf8'));
if(!/^stage-b-[a-f0-9]{24}$/.test(m.run)||m.image!=='health-wallet-stage-b:'+m.run||!Array.isArray(m.existingContainerIds))throw Error('Run identity refused');
const receipts=[];
function command(args){const r=spawnSync('docker',args,{encoding:'utf8',timeout:60000,maxBuffer:2*1024*1024});return r;}
function inspect(kind,id){const args=kind==='container'?['inspect',id]:[kind,'inspect',id];const r=command(args);if(r.status===0)return JSON.parse(r.stdout)[0];if(/No such (?:object|container|volume|image)/i.test(r.stderr??''))return undefined;throw Error('Exact resource inspection unavailable');}
try{
 for(const id of [...m.containers].reverse()){
  if(!/^[a-f0-9]{64}$/.test(id)||m.existingContainerIds.includes(id))throw Error('Container identity refused');
  const c=inspect('container',id);
  if(c){if(c.Id!==id||c.Config.Labels?.['health-wallet.stage-b']!==m.run)throw Error('Container ownership refused');
   if(c.State.Running&&command(['stop','-t','15',id]).status!==0)throw Error('Owned stop incomplete');
   const r=command(['rm',id]);if(r.status!==0&&inspect('container',id))throw Error('Owned removal incomplete');
  }
  if(inspect('container',id))throw Error('Owned container remains');receipts.push({kind:'container',absent:true});
 }
 for(const name of m.volumes){if(name!=='health-wallet-'+m.run+'-data')throw Error('Volume identity refused');const v=inspect('volume',name);
  if(v){if(v.Name!==name||v.Labels?.['health-wallet.stage-b']!==m.run)throw Error('Volume ownership refused');if(command(['volume','rm',name]).status!==0)throw Error('Owned volume removal incomplete');}
  if(inspect('volume',name))throw Error('Owned volume remains');receipts.push({kind:'volume',absent:true});
 }
 const image=inspect('image',m.image);
 if(image){if(image.Config.Labels?.['health-wallet.stage-b']!==(m.dependencyImageRun??m.run)||(m.dependencyImageId&&image.Id!==m.dependencyImageId))throw Error('Image ownership refused');if(command(['image','rm',m.image]).status!==0)throw Error('Owned image removal incomplete');}
 if(inspect('image',m.image))throw Error('Owned image remains');receipts.push({kind:'image',absent:true});
}catch{process.exitCode=1;}
const out={version:1,cleanup_verified:!process.exitCode,receipts};
await writeFile(join(dirname(path),'reconciled-cleanup.json'),JSON.stringify(out,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(out));
