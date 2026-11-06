// Development-only in-memory mailbox; no outbound mail, persistence or payload logging.
// Serves two private synthetic endpoints with the same rules as a strict real relay would apply:
//   /security-email         identity mail (verification, reset, guardian invitation, doctor code)
//   /guardian-medical-email non-clinical demonstration mail to a guardian (digest, serious-rule alert)
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const CONTROL=/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;   // text may contain \n and \t; headers may not contain any line break
type Stored={reference:string;created:number;message:Record<string,string>};
const endpoints={
 '/security-email':{maxBody:4096,maxText:2048,to:/^[^\s@]+@example\.invalid$/,from:null as string|null,subject:null as string|null,textStart:null as string|null},
 '/guardian-medical-email':{maxBody:131072,maxText:65536,to:/^[^\s@]+@[^\s@]+\.invalid$/,from:'guardian-demo@example.invalid',subject:'SYNTHETIC ONLY — ',textStart:'NON-CLINICAL DEMONSTRATION.'},
} as const;
export function createSecurityEmailSandbox(){
const messages=new Map<string,Stored>();
const server=createServer(async(req,res)=>{
 res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
 if(req.method==='GET'&&req.url==='/messages'){
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify([...messages.values()].map(x=>({id:x.reference,...x.message}))));return;
 }
 const rules=req.method==='POST'&&req.url&&Object.hasOwn(endpoints,req.url)?endpoints[req.url as keyof typeof endpoints]:undefined;
 if(!rules){res.writeHead(404).end();return;}
 let size=0;const chunks:Buffer[]=[];
 try{
  for await(const chunk of req){size+=chunk.length;if(size>rules.maxBody){res.writeHead(413).end();return;}chunks.push(chunk);}
  const m=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if(!m||typeof m!=='object'||Array.isArray(m)||Object.keys(m).sort().join(',')!=='from,idempotencyKey,subject,text,to'
    ||[m.to,m.from,m.subject,m.text,m.idempotencyKey].some(v=>typeof v!=='string')
    ||!rules.to.test(m.to)||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(m.from)||(rules.from!==null&&m.from!==rules.from)
    ||!/^[a-f0-9-]{36}$/.test(m.idempotencyKey)||req.headers['idempotency-key']!==m.idempotencyKey
    ||!m.subject||m.subject.length>200||(rules.subject!==null&&!m.subject.startsWith(rules.subject))
    ||!m.text||m.text.length>rules.maxText||(rules.textStart!==null&&!m.text.startsWith(rules.textStart))
    // A line break in any header field would let a caller add recipients or headers.
    ||[m.to,m.from,m.subject].some(v=>/[\r\n]/.test(v)||CONTROL.test(v))||CONTROL.test(m.text)){res.writeHead(422).end();return;}
  for(const [key,value]of messages)if(Date.now()-value.created>86400000)messages.delete(key);
  let record=messages.get(m.idempotencyKey);
  // Reusing a key with different content is a caller bug (or an attack); it must never overwrite or silently succeed.
  if(record&&JSON.stringify(record.message)!==JSON.stringify(m)){res.writeHead(409).end();return;}
  if(!record){if(messages.size>=1000){res.writeHead(503).end();return;}record={reference:'sandbox-'+randomUUID(),created:Date.now(),message:m};messages.set(m.idempotencyKey,record);}
  res.writeHead(202,{'Content-Type':'application/json'}).end(JSON.stringify({message_id:record.reference}));
 }catch{res.writeHead(400).end();}
});
server.once('close',()=>messages.clear());
return server;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
if(process.argv.slice(2).join(' ')!=='--local-synthetic-only')throw Error('Explicit --local-synthetic-only required.');
const server=createSecurityEmailSandbox();
server.listen(8026,'127.0.0.1',()=>console.log('Synthetic security-email sandbox listening on 127.0.0.1:8026; mailbox is memory-only.'));
server.on('error',()=>{console.error('Synthetic email sandbox unavailable.');process.exitCode=1;});
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{server.closeAllConnections();server.close();});
}
