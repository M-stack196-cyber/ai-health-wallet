import {mkdir,copyFile,cp,readFile,writeFile,lstat,readdir,realpath,chmod} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {dirname,join} from 'node:path';
import {createHash} from 'node:crypto';

// Dependency-only rootfs: explicit tools, their shared libraries and public OCR
// data. Never copies an OS/home directory, credentials or application data.
export async function offlineImage(build,project){
 const root=join(build,'rootfs'),copied=new Set(),fingerprints={};await mkdir(root,{recursive:true});
 async function file(source,destination=source){
  const real=await realpath(source);const target=join(root,destination);if(copied.has(target))return;copied.add(target);
  await mkdir(dirname(target),{recursive:true});await copyFile(real,target);
  fingerprints[destination]=createHash('sha256').update(await readFile(real)).digest('hex');
 }
 async function libraries(binary){
  const result=spawnSync('ldd',[binary],{encoding:'utf8',timeout:10000});
  for(const path of (result.stdout??'').match(/\/[^\s()]+/g)??[]){
   if(path.startsWith(project+'/backend/node_modules/'))continue;
   try{if((await lstat(path)).isFile()||(await lstat(path)).isSymbolicLink())await file(path);}catch{throw Error('Dependency library unavailable');}
  }
 }
 const tools=['/bin/sh','/usr/bin/cp','/usr/bin/env','/usr/bin/git','/usr/bin/tesseract','/usr/bin/pdftoppm','/usr/bin/prlimit'];
 for(const path of tools){await file(path);await libraries(path);}
 await file(process.execPath,'/usr/bin/node');await libraries(process.execPath);
 const npmRoot=dirname(dirname(await realpath(join(dirname(process.execPath),'npm'))));
 await cp(npmRoot,join(root,'opt/npm'),{recursive:true,verbatimSymlinks:true});
 await writeFile(join(root,'usr/bin/npm'),"#!/usr/bin/node\nrequire('/opt/npm/bin/npm-cli.js');\n",{mode:0o755});
 for(const path of ['/usr/share/tesseract-ocr/5/tessdata','/usr/share/fonts/truetype/dejavu','/etc/fonts','/usr/share/git-core/templates'])await cp(path,join(root,path),{recursive:true,dereference:true});
 const walk=async directory=>{for(const item of await readdir(directory,{withFileTypes:true})){const path=join(directory,item.name);if(item.isDirectory())await walk(path);else if(/\.node$|\.so(?:\.|$)/.test(item.name))await libraries(path);}};
 await walk(project+'/backend/node_modules');
 await cp(project+'/backend/node_modules',join(root,'opt/deps/node_modules'),{recursive:true,verbatimSymlinks:true});
 await mkdir(join(root,'etc'),{recursive:true});await mkdir(join(root,'tmp'),{recursive:true,mode:0o1777});await mkdir(join(root,'home/node'),{recursive:true});
 await chmod(join(root,'tmp'),0o1777);
 await writeFile(join(root,'etc/passwd'),'root:x:0:0:root:/root:/bin/sh\nnode:x:1000:1000:node:/home/node:/bin/sh\n');
 await writeFile(join(root,'etc/group'),'root:x:0:\nnode:x:1000:\n');await writeFile(join(root,'etc/nsswitch.conf'),'hosts: files\npasswd: files\ngroup: files\n');
 await writeFile(join(build,'Dockerfile'),'FROM scratch\nCOPY rootfs /\nENV PATH=/usr/bin:/bin HOME=/home/node LANG=C.UTF-8\nUSER 1000:1000\nWORKDIR /work/backend\n');
 await writeFile(join(build,'dependencies.json'),JSON.stringify({node:process.version,lockfileSha256:createHash('sha256').update(await readFile(project+'/backend/package-lock.json')).digest('hex'),fingerprints},null,2)+'\n',{mode:0o600});
}
