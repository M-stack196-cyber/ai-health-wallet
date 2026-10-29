import {createSummaryJobRepository,type SummaryDatabase} from './jobs.js';
import {createSummaryClient} from './client.js';
import {createSummaryExecutor,defaultSummaryExecutorConfig} from './executor.js';
import {privateSummaryTransport} from './http-transport.js';
import {sourceCatalogue} from './catalogue.js';
// Explicit composition only. API/server startup never enables a provider or
// spawns a worker. No hosted SDK, URL override or implicit model selection.
export function createOfflineSummaryRuntime(db:SummaryDatabase,patientId:string,env:NodeJS.ProcessEnv){
 if(env.SUMMARY_PROVIDER!=='synthetic-offline'||!env.SUMMARY_SERVICE_URL||!env.SUMMARY_SERVICE_TOKEN)throw Error('Explicit offline summary configuration required.');
 const transport=privateSummaryTransport(env.SUMMARY_SERVICE_URL);
 const client=createSummaryClient({enabled:true,token:env.SUMMARY_SERVICE_TOKEN,timeoutMs:5000},transport);
 const repository=createSummaryJobRepository(db,patientId);
 const executor=createSummaryExecutor({...defaultSummaryExecutorConfig,enabled:true,patientId,attemptMs:6000},{repository,client});
 return {api:{enabled:true,database:db,catalogue:sourceCatalogue},repository,executor};
}
