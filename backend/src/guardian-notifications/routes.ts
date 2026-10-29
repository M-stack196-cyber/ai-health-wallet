import {Router} from 'express';
import type {PatientDatabase} from '../patients/repository.js';
import type {AuthenticationConfig} from '../config/auth.js';
import type {DocumentConfig} from '../config/documents.js';
import type {DocumentStorage} from '../documents/storage.js';
import {requirePatient,assertCurrentPatient,patientIdentity,requireJson,rejectQueryParameters,rejectRequestBody} from '../auth/middleware.js';
import {createTokenService} from '../auth/tokens.js';
import {createSecurityRepository,rateHash} from '../auth/security-repository.js';
import {getSecurityPolicy} from '../auth/security-policy.js';
import {createDocumentRepository} from '../documents/repository.js';
import {createPatientFileAccess} from '../documents/file-access.js';
import {createGuardianNotificationReader,guardianDenied} from './service.js';
import {ApiError} from '../http/errors.js';
export function createGuardianNotificationRoutes(db:PatientDatabase,auth:AuthenticationConfig,documents:DocumentConfig,storage:DocumentStorage|null){
 const r=Router(),reader=createGuardianNotificationReader(db);r.use((_req,res,next)=>{res.set('Cache-Control','no-store');next();});
 r.get('/patients/me/guardian-notifications',requirePatient(createTokenService(auth),db),rejectQueryParameters,rejectRequestBody,async(req,res)=>{const result=await reader.observe(patientIdentity(req));await assertCurrentPatient(req,db);res.json({success:true,mode:'synthetic-offline',...result,release_gates:['CFG-06','CFG-07','CFG-11','CFG-15']});});
 const deliver=createPatientFileAccess(createDocumentRepository(db),storage,documents,db,{authorize:async(req,id)=>{const current=await reader.resolveReference(req.body?.token);if(current.document_id!==id)throw guardianDenied();},disposition:'attachment'});
 r.post('/guardian-notifications/reports',rejectQueryParameters,requireJson,async(req,res)=>{
  const b=req.body;if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).join(',')!=='token'||typeof b.token!=='string'||b.token.length>160)throw guardianDenied();
  const rate=createSecurityRepository(db,getSecurityPolicy());if(!await rate.rate(rateHash(auth.jwtKey,'guardian_report',req.ip??'unknown'),60,3600))throw new ApiError(429,'GUARDIAN_REPORT_RATE_LIMIT','Too many report attempts.');
  const current=await reader.resolveReference(b.token);await deliver(current.document_id,current.patient_id,req,res);
 });return r;
}
