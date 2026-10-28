import {pathToFileURL} from 'node:url';
import {writeFile,lstat} from 'node:fs/promises';
import {dirname} from 'node:path';
import {guard} from '../processing/background-config.js';
import {inspectInside} from './inside-protection.js';
export async function insideEntry(path:string){
 guard(/^\/[a-zA-Z0-9/_.-]+$/.test(path));const parent=await lstat(dirname(path));guard(parent.isDirectory()&&!parent.isSymbolicLink()&&parent.uid===process.getuid!()&&(parent.mode&0o777)===0o700);
 const result=await inspectInside();await writeFile(path,JSON.stringify(result)+'\n',{mode:0o600,flag:'wx',flush:true});guard(result.protected);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){try{guard(process.argv.length===3);await insideEntry(process.argv[2]);}catch{process.exitCode=1;}}
