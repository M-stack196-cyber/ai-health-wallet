import {guard} from '../processing/background-config.js';
export function isBackgroundCommand(cmdline:string){
 return cmdline.split('\0').some(arg=>/(^|\/)processing\/background-entry\.(js|ts)$/.test(arg));
}
// EnvironmentFile double quotes escape quotes/backslashes. systemd does not
// perform shell/variable/specifier expansion of these values. No shell is used.
export function serializeEnvironment(values:Record<string,string>){
 const lines=Object.entries(values).map(([key,value])=>{
  guard(/^[A-Z_][A-Z0-9_]*$/.test(key)&&typeof value==='string'&&!/[\r\n\0]/.test(value));
  return key+'="'+value.replace(/\\/g,'\\\\').replace(/"/g,'\\"')+'"';
 });const text=lines.join('\n')+'\n';guard(Buffer.byteLength(text)<=65536);return text;
}
