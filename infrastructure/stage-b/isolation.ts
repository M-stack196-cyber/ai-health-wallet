import {readFile,stat} from 'node:fs/promises';
import {networkInterfaces} from 'node:os';
import pg from '../../backend/node_modules/pg/lib/index.js';
export async function assertIsolated(database=false){
 const id=process.env.STAGE_B_RUN_ID;if(!id||!/^stage-b-[a-f0-9]{24}$/.test(id))throw Error('Isolation marker missing');
 if((await readFile('/stage-b-identity','utf8')).trim()!==id)throw Error('Container identity mismatch');
 for(const [name,addresses]of Object.entries(networkInterfaces()))if(name!=='lo'&&addresses?.length)throw Error('External interface refused');
 const routes=(await readFile('/proc/net/route','utf8')).trim().split('\n').slice(1);if(routes.some(line=>line.trim()))throw Error('External route refused');
 const ipv6=(await readFile('/proc/net/ipv6_route','utf8')).trim().split('\n');if(ipv6.some(line=>line.trim()&&!line.trim().endsWith(' lo')))throw Error('External IPv6 route refused');
 for(const p of ['/var/run/docker.sock','/root/.aws','/home/node/.aws']){let exists=false;try{await stat(p);exists=true;}catch{}if(exists)throw Error('Forbidden mounted capability');}
 if(database){const client=new pg.Client({host:'127.0.0.1',port:5433,database:process.env.DB_NAME,user:process.env.DB_USER,password:process.env.DB_PASSWORD,connectionTimeoutMillis:3000});
  try{await client.connect();const row=(await client.query("SELECT current_database() AS db,current_user AS role,shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=current_database()")).rows[0];
   if(row.db!=='ai_health_wallet'||row.role!=='health_wallet_app'||row.marker!=='stage-b:'+id)throw Error('Disposable database marker mismatch');
  }finally{await client.end();}}
}
