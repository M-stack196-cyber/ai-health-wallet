import {chmod, mkdtemp, open, rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pipeline} from 'node:stream/promises';
import type {Request, Response} from 'express';
import type {DocumentConfig} from '../config/documents.js';
import type {createDocumentRepository} from './repository.js';
import type {DocumentStorage} from './storage.js';
import {validStorageReference} from './storage-safety.js';
import {ApiError} from '../http/errors.js';
import {notFound, storageUnavailable} from './service.js';
import {assertCurrentPatient} from '../auth/middleware.js';
import type {PatientDatabase} from '../patients/repository.js';

// Private byte delivery; patient sessions or an explicitly supplied current-grant
// policy are checked before acquisition and again before response bytes.
export function createPatientFileAccess(repository:ReturnType<typeof createDocumentRepository>, storage:DocumentStorage|null, config:DocumentConfig, database?:PatientDatabase,policy?:{authorize:(req:Request,id:string)=>Promise<void>;disposition:'inline'|'attachment'}) {
  let active=0;
  return async (id:string, patientId:string, req:Request, res:Response):Promise<void> => {
    if(policy)await policy.authorize(req,id);
    const row=await repository.reference(id,patientId);
    if(!row)throw notFound();
    if(!storage?.readOriginal || !validStorageReference(storage,row.s3_bucket,row.s3_object_key)
      || !['pdf','jpg','jpeg','png'].includes(row.file_type) || !row.s3_object_key.endsWith('.'+row.file_type))throw storageUnavailable();
    if(active>=config.maxConcurrentUploads){
      res.set('Retry-After','5');
      throw new ApiError(503,'DOCUMENT_DOWNLOAD_BUSY','Document downloads are temporarily busy. Try again later.');
    }
    active++;
    const controller=new AbortController();
    const abort=()=>controller.abort();
    const closed=()=>{if(!res.writableFinished)abort();};
    req.once('aborted',abort);res.once('close',closed);
    if(req.aborted || res.destroyed)abort();
    const deadline=setTimeout(abort,config.uploadTimeoutMs);
    let directory:string|undefined;
    let file:Awaited<ReturnType<typeof open>>|undefined;
    try {
      controller.signal.throwIfAborted();
      directory=await mkdtemp(join(tmpdir(),'health-wallet-file-'));
      await chmod(directory,0o700);
      const destination=join(directory,'original.bin');
      const receipt=await storage.readOriginal({key:row.s3_object_key,type:row.file_type,destination,
        maxBytes:config.maxFileBytes,timeoutMs:config.uploadTimeoutMs,signal:controller.signal});
      controller.signal.throwIfAborted();
      file=await open(destination,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      const info=await file.stat();
      if(!info.isFile() || info.size<1 || info.size>config.maxFileBytes || info.size!==receipt.bytes
        || info.uid!==process.getuid?.() || (info.mode&0o077)!==0)throw storageUnavailable();
      if(row.size_bytes !== null && row.size_bytes !== undefined && Number(row.size_bytes)!==info.size)throw storageUnavailable();
      if(row.sha256){
        const hash=createHash('sha256');
        for await(const chunk of file.createReadStream({autoClose:false,start:0}))hash.update(chunk);
        if(hash.digest('hex')!==row.sha256)throw storageUnavailable();
      }
      // Recheck ownership and immutable storage identity after acquisition, before bytes.
      const current=await repository.reference(id,patientId);
      if(!current)throw notFound();
      if(current.s3_bucket!==row.s3_bucket || current.s3_object_key!==row.s3_object_key
        || current.file_type!==row.file_type || current.sha256!==row.sha256 || current.size_bytes!==row.size_bytes)throw storageUnavailable();
      controller.signal.throwIfAborted();
      if(!database)throw storageUnavailable();
      if(policy)await policy.authorize(req,id);else await assertCurrentPatient(req,database);
      const mime=row.file_type==='pdf'?'application/pdf':row.file_type==='png'?'image/png':'image/jpeg';
      const encoded=encodeURIComponent(row.original_filename).replace(/['()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
      res.status(200).set({'Content-Type':mime,'Content-Length':String(info.size),'Cache-Control':'private, no-store',
        'X-Content-Type-Options':'nosniff','Content-Disposition':`${policy?.disposition??'attachment'}; filename="document.${row.file_type}"; filename*=UTF-8''${encoded}`});
      await pipeline(file.createReadStream({autoClose:false,start:0}),res,{signal:controller.signal});
    } catch(error) {
      if(res.headersSent || res.destroyed){res.destroy();return;}
      if(error instanceof ApiError)throw error;
      throw storageUnavailable();
    } finally {
      clearTimeout(deadline);req.off('aborted',abort);res.off('close',closed);
      try {await file?.close();}
      finally {try {if(directory)await rm(directory,{recursive:true,force:true});}finally {active--;}}
    }
  };
}
