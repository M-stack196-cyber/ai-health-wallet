// Owned disposable fixture command only; no normal .env import or production medical sender.
import {readFile,stat} from 'node:fs/promises';
import pg from 'pg';
import {guardianNotificationConfig} from './config.js';
import {createGuardianNotificationService} from './service.js';
import {syntheticGuardianEmailProvider} from './provider.js';
import {createGuardianNotificationExecutor} from './executor.js';
async function main(){
 if(process.argv.slice(2).join(' ')!=='--owned-synthetic-once')throw Error('Explicit owned synthetic invocation required.');
 const socket=process.env.GUARDIAN_SYNTHETIC_DB_SOCKET??'',patient=process.env.GUARDIAN_SYNTHETIC_PATIENT_ID??'',key=process.env.GUARDIAN_SYNTHETIC_REFERENCE_KEY??'';
 if(!/^\/tmp\/hw-phase1-pg-[a-zA-Z0-9]+$/.test(socket)||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(patient)||!/^[a-f0-9]{64}$/.test(key)||new Set(key).size<8)throw Error('Owned synthetic fixture configuration required.');
 if(((await stat(socket)).mode&0o777)!==0o700||await readFile(socket+'/phase1-owned','utf8')!=='identity-security-v1\n')throw Error('Owned disposable database required.');
 const config=guardianNotificationConfig(process.env,Buffer.from(key,'hex'));if(!config)throw Error('Synthetic notifications are disabled.');
 const provider=syntheticGuardianEmailProvider({mode:'sandbox',endpoint:process.env.GUARDIAN_SYNTHETIC_EMAIL_ENDPOINT??'',from:'guardian-demo@example.invalid',encryptionKey:config.referenceKey,timeoutMs:config.timeoutMs,retrySeconds:config.retrySeconds,maxAttempts:config.maxAttempts});
 const db=new pg.Pool({host:socket,port:55481,database:'hw_phase7',user:'health_wallet_app',max:4,connectionTimeoutMillis:2000});
 try{const executor=createGuardianNotificationExecutor(createGuardianNotificationService(db,config,provider),[patient]);const result=await executor.runOnce();await executor.stop();console.log(JSON.stringify({state:result.state,syntheticOnly:true}));}finally{await db.end();}
}
main().catch(()=>{console.error('Synthetic guardian notification command refused or failed.');process.exitCode=1;});
