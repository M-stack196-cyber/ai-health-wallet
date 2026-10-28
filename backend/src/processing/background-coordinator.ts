import type {PoolClient} from 'pg';
import {guard} from './background-config.js';

// Fixed application/database-wide lock, independent of patient or cutoff. Never
// use pool.query for session locks or return this session to a pool while held.
export const coordinatorKey=Object.freeze([1095259980,2301] as const);
type Client=Pick<PoolClient,'query'|'on'|'removeListener'|'release'>;
export async function acquireCoordinator(client:Client,onLost:()=>void){
  let owned=false,closed=false,lost=false;
  const disconnect=()=>{if(!closed&&!lost){lost=true;owned=false;onLost();}};
  client.on('error',disconnect);client.on('end',disconnect);
  try{
    const result=await client.query<{owned:boolean}>('SELECT pg_try_advisory_lock($1::int,$2::int) AS owned',[...coordinatorKey]);
    guard(!lost&&result.rows[0]?.owned===true);owned=true;
  }catch{
    closed=true;client.removeListener('error',disconnect);client.removeListener('end',disconnect);client.release(true);throw new Error('Coordinator unavailable.');
  }
  return {
    assertOwned(){guard(owned&&!lost&&!closed);},
    async ping(){guard(owned&&!lost&&!closed);try{await client.query('SELECT 1');guard(!lost);}catch{disconnect();throw new Error('Coordinator unavailable.');}},
    async close(){
      if(closed)return;closed=true;
      try{if(owned&&!lost)await client.query('SELECT pg_advisory_unlock($1::int,$2::int)',[...coordinatorKey]);}
      finally{owned=false;client.release(true);client.removeListener('error',disconnect);client.removeListener('end',disconnect);}
    }
  };
}
