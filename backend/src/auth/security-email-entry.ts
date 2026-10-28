// Explicit bounded security-email worker. No implicit production provider or scheduler.
import {pool,closeDatabasePool} from '../database/pool.js';
import {configuredSecurityEmail} from './security-email.js';
try {
 if(process.argv.slice(2).join(' ')!=='--drain-once')throw Error('Explicit --drain-once required.');
 const service=configuredSecurityEmail(pool);if(!service)throw Error('Security email is disabled.');
 console.log(JSON.stringify(await service.drain(10)));
}catch{console.error('Security email delivery unavailable; configuration or delivery failed.');process.exitCode=1;}
finally{await closeDatabasePool();}
