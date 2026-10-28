import type pg from 'pg';
import type {S3Client,S3ClientConfig} from '@aws-sdk/client-s3';
import type {DocumentConfig,S3StorageConfig} from '../config/documents.js';
import type {ProcessingConfig,RetrievalConfig} from './config.js';
import type {DocumentProcessor} from './worker.js';
import type {OriginalStorage} from '../documents/original-reader.js';
import type {SystemCredentialBundle} from '../stage-c/system-credentials.js';
import {target} from '../integration/guards.js';
import {OperationalError,type OperationalResources} from './operational-runtime.js';
export interface ResourcePolicy {processing:ProcessingConfig;retrieval:RetrievalConfig;documents:DocumentConfig;}
export interface ResourceDrivers {pool(options:pg.PoolConfig):pg.Pool;client(options:S3ClientConfig):S3Client;original(config:S3StorageConfig,client:S3Client):OriginalStorage;}
// Constructors only, selected explicitly by the trusted composition. No imports,
// client creation, sockets or credential loading at module import/factory creation.
export function operationalResourceFactory(input:ResourcePolicy,processor:DocumentProcessor,injected?:ResourceDrivers){
 let policy:ResourcePolicy;try{policy=structuredClone({processing:input.processing,retrieval:input.retrieval,documents:input.documents});}catch{throw new OperationalError();}
 return async(credentials:SystemCredentialBundle,signal:AbortSignal):Promise<OperationalResources>=>{
  let pool:pg.Pool|undefined,client:S3Client|undefined;
  try{
   signal.throwIfAborted();const db=await credentials.databaseOptions();
   if(db.host!=='127.0.0.1'||db.port!==5433||db.database!=='ai_health_wallet'||db.user!=='health_wallet_app')throw new OperationalError();
   const storage=policy.documents.storage;
   if(!storage||storage.bucket!==target.bucket||storage.region!==target.region||storage.ownerAccountId!==target.account||storage.prefix!==target.prefix||storage.encryption!=='AES256'||storage.kmsKeyId)throw new OperationalError();
   let drivers=injected;
   if(!drivers){const [{default:pg},{S3Client},{createS3Storage}]=await Promise.all([import('pg'),import('@aws-sdk/client-s3'),import('../documents/storage.js')]);drivers={pool:o=>new pg.Pool(o),client:o=>new S3Client(o),original:(c,client)=>createS3Storage(c,{client})};}
   signal.throwIfAborted();
   pool=drivers.pool({...db,max:4,connectionTimeoutMillis:3000,idleTimeoutMillis:30000,statement_timeout:3000,query_timeout:5000,keepAlive:true,keepAliveInitialDelayMillis:1000,ssl:false,options:'',application_name:'health-wallet-operational'});
   client=drivers.client({region:target.region,credentials:()=>credentials.awsCredentials(),endpoint:'https://s3.'+target.region+'.amazonaws.com',ignoreConfiguredEndpointUrls:true,followRegionRedirects:false,useFipsEndpoint:false,useDualstackEndpoint:false,maxAttempts:2,requestHandler:{connectionTimeout:3000,requestTimeout:10000}});
   const original=drivers.original(storage,client);signal.throwIfAborted();let closed=false;
   return {...structuredClone(policy),pool,processor,storage:{bucket:original.bucket,prefix:original.prefix,readOriginal:i=>original.readOriginal(i)},closeStorage(){if(!closed){closed=true;client!.destroy();}}};
  }catch{try{client?.destroy();await pool?.end();}catch{}throw new OperationalError();}
 };
}
