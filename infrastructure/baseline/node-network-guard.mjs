// B01 test-process guard. No production import; not a substitute for an OS sandbox.
import net from 'node:net';
import dgram from 'node:dgram';
import {syncBuiltinESMExports} from 'node:module';
import {resolve,sep} from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const ports=new Set();
const temporary=process.env.TMPDIR;
const refuse=()=>{throw Error('B01_TEST_NETWORK_REFUSED');};
function privateIpc(path){return typeof path==='string'&&temporary&&resolve(path).startsWith(resolve(temporary)+sep);}
const listen=net.Server.prototype.listen;
net.Server.prototype.listen=function(...args){
 const first=args[0];
 const path=typeof first==='object'?first.path:typeof first==='string'?first:undefined;
 if(!privateIpc(path)){
  const port=typeof first==='object'?first.port:first;
  const host=typeof first==='object'?first.host:args[1];
  if(port!==0||host!=='127.0.0.1')refuse();
  let ownedPort;
  this.once('listening',()=>{const a=this.address();if(a&&typeof a==='object'){ownedPort=a.port;ports.add(ownedPort);}});
  this.once('close',()=>{if(ownedPort!==undefined)ports.delete(ownedPort);});
 }
 return listen.apply(this,args);
};
const connect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){
 const normalized=Array.isArray(args[0])?args[0]:args;
 const first=normalized[0];
 const options=typeof first==='object'?first:{port:first,host:normalized[1]};
 if(!privateIpc(options.path)){
  const port=Number(options.port);
  if((options.host??'localhost')!=='127.0.0.1'||!ports.has(port)||[11434,5432,5433,5000,5001].includes(port))refuse();
 }
 return connect.apply(this,args);
};
dgram.createSocket=refuse;
function protectRead(path){
 if(typeof path==='number'||path===undefined)return;
 const p=resolve(path instanceof URL?fileURLToPath(path):String(path));
 const scratch=process.env.B01_SCRATCH_ROOT;
 if(scratch&&p.startsWith(resolve(scratch)+sep))return;
 if(p.split(sep).some(x=>['.aws','.ssh','.env','.env.migrations'].includes(x)))throw Error('B01_CREDENTIAL_READ_REFUSED');
 const source=process.env.B01_SOURCE_ROOT, deps=process.env.B01_DEPENDENCY_ROOT;
 if(source&&p.startsWith(resolve(source)+sep)&&!(deps&&p.startsWith(resolve(deps)+sep)))throw Error('B01_SOURCE_FALLBACK_REFUSED');
}
for(const key of ['readFile','readFileSync','open','openSync']){
 const original=fs[key];fs[key]=function(path,...args){protectRead(path);return original.call(this,path,...args);};
}
for(const key of ['readFile','open']){
 const original=fsp[key];fsp[key]=function(path,...args){protectRead(path);return original.call(this,path,...args);};
}
syncBuiltinESMExports();
