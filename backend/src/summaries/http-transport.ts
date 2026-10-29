import {summaryServicePath,type SummaryTransport} from './client.js';
// Explicit loopback-only implementation of the existing injectable transport.
export function privateSummaryTransport(endpoint:string):SummaryTransport{
 const u=new URL(endpoint);
 if(u.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(u.hostname)||u.pathname!==summaryServicePath||u.search||u.hash||u.username||u.password)throw Error('Invalid private summary endpoint.');
 return async request=>{
  const response=await fetch(u,{method:'POST',redirect:'error',headers:request.headers,body:Buffer.from(request.body),signal:request.signal});
  return {status:response.status,body:(async function*(){
   const reader=response.body?.getReader();let bytes=0;
   try{if(reader)while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.length;if(bytes>request.maxResponseBytes)throw Error('Summary response exceeded limit.');yield part.value;}}
   finally{await reader?.cancel().catch(()=>{});}
  })()};
 };
}
