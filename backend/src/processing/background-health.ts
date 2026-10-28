import {createServer} from 'node:http';
export interface Metrics {active:number;completed:number;failed:number;lost:number;unavailable:number;idle:number;queue:number;}
export interface Status {live:boolean;ready:boolean;metrics:Metrics;}
export function publicStatus(status:Status):Status {
  const count=(n:number)=>Number.isSafeInteger(n)&&n>=0?n:0;
  const m=status.metrics;
  return {live:status.live===true,ready:status.ready===true,metrics:{active:count(m.active),completed:count(m.completed),failed:count(m.failed),lost:count(m.lost),unavailable:count(m.unavailable),idle:count(m.idle),queue:count(m.queue)}};
}
export async function startBackgroundHealth(port:number,status:()=>Status){
  const server=createServer((req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','application/json');
    if(req.method!=='GET'){res.writeHead(405);res.end('{}');return;}
    const snapshot=publicStatus(status());
    const route=req.url;
    if(route==='/live'){res.writeHead(snapshot.live?200:503);res.end(JSON.stringify({live:snapshot.live}));}
    else if(route==='/ready'){res.writeHead(snapshot.ready?200:503);res.end(JSON.stringify({ready:snapshot.ready}));}
    else if(route==='/metrics'){res.writeHead(200);res.end(JSON.stringify(snapshot.metrics));}
    else{res.writeHead(404);res.end('{}');}
  });
  server.requestTimeout=3000;server.headersTimeout=3000;server.keepAliveTimeout=1000;server.maxConnections=8;
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>{server.removeListener('error',reject);resolve();});});
  return {address:server.address(),async close(){server.closeIdleConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}};
}
