// Development-only in-memory mailbox; no outbound mail, persistence or payload logging.
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
export function createSecurityEmailSandbox(){
const messages=new Map<string,{reference:string;created:number;message:unknown}>();
const server=createServer(async(req,res)=>{
 res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
 if(req.method==='GET'&&req.url==='/messages'){
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify([...messages.values()].map(x=>({id:x.reference,...x.message as object}))));return;
 }
 if(req.method!=='POST'||req.url!=='/security-email'){res.writeHead(404).end();return;}
 let size=0;const chunks:Buffer[]=[];
 try{
  for await(const chunk of req){size+=chunk.length;if(size>4096){res.writeHead(413).end();return;}chunks.push(chunk);}
  const m=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if(Object.keys(m).sort().join(',')!=='from,idempotencyKey,subject,text,to'||typeof m.to!=='string'||!m.to.endsWith('@example.invalid')
    ||typeof m.idempotencyKey!=='string'||!/^[a-f0-9-]{36}$/.test(m.idempotencyKey)||req.headers['idempotency-key']!==m.idempotencyKey
    ||typeof m.subject!=='string'||typeof m.text!=='string'||m.text.length>2048){res.writeHead(422).end();return;}
  for(const [key,value]of messages)if(Date.now()-value.created>86400000)messages.delete(key);
  let record=messages.get(m.idempotencyKey);
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
