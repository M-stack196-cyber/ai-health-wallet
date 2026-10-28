import {composeBackground} from './background-runtime-core.js';
import pg from 'pg';
import {S3Client} from '@aws-sdk/client-s3';
import {getDatabaseConfig} from '../config/env.js';
import {getDocumentConfig} from '../config/documents.js';
import {getProcessingConfig,getRetrievalConfig,getDigitalPdfConfig,getOcrConfig} from './config.js';
import {createOcrProcessor} from './ocr-processor.js';
import {createS3Storage} from '../documents/storage.js';
import {loadPinnedProfile,awsReadFor} from '../integration/aws-preflight.js';
import {checkEnvironment,preflight} from '../integration/guards.js';
import {guard,verifyApproval,type BackgroundConfig} from './background-config.js';
import {logEvent} from './background-service.js';

// This module is dynamically imported only after the enabled configuration is
// fully validated. It never imports the API's module-level database pool.
export async function startRuntime(config:BackgroundConfig,shutdown?:AbortSignal){
  shutdown?.throwIfAborted();await verifyApproval(config);checkEnvironment(process.env);
  const processing=getProcessingConfig(),retrieval=getRetrievalConfig(),pdf=getDigitalPdfConfig(),ocr=getOcrConfig(),documents=getDocumentConfig();
  guard(documents.storage&&config.concurrency<=Math.min(retrieval.maxConcurrentRetrievals,pdf.maxConcurrentExtractions,ocr.maxConcurrency));
  const profile=await loadPinnedProfile();guard((await preflight(awsReadFor(profile))).passed);await verifyApproval(config);shutdown?.throwIfAborted();
  const pool=new pg.Pool({...getDatabaseConfig(),max:config.concurrency+3,connectionTimeoutMillis:3000,idleTimeoutMillis:30000,
    statement_timeout:3000,query_timeout:5000,keepAlive:true,keepAliveInitialDelayMillis:1000});
  const client=new S3Client({region:documents.storage.region,credentials:profile.credentials,maxAttempts:2,ignoreConfiguredEndpointUrls:true,
    requestHandler:{connectionTimeout:3000,requestTimeout:10000}});
  const storage=createS3Storage(documents.storage,{client});
  return composeBackground(config,{pool,processing,retrieval,documents,storage:{bucket:storage.bucket,prefix:storage.prefix,readOriginal:input=>storage.readOriginal(input)},
    processor:createOcrProcessor(ocr,pdf),profileUnchanged:profile.unchanged,closeStorage:()=>client.destroy(),shutdown,
    fault:()=>{process.exitCode=1;},log:event=>{if(event==='safety-stop')process.exitCode=1;logEvent(event);}});
}
