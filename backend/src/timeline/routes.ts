import {Router} from 'express';
import type {PatientDatabase} from '../patients/repository.js';
import type {AuthenticationConfig} from '../config/auth.js';
import {createTokenService} from '../auth/tokens.js';
import {requirePatient,assertCurrentPatient,patientIdentity,rejectRequestBody} from '../auth/middleware.js';
import {createTimelineService} from './service.js';
import {filters} from '../documents/validation.js';
// Patient policy only. Future doctor callers must supply their own current grant
// intersection before querying; this route accepts no doctor/grant/document selectors.
export function createTimelineRoutes(db:PatientDatabase,auth:AuthenticationConfig){
 const router=Router();
 router.use((_req,res,next)=>{res.set('Cache-Control','no-store');next();},requirePatient(createTokenService(auth),db));
 router.get('/',rejectRequestBody,async(req,res)=>{
  const result=await createTimelineService(db,async()=>{
   await assertCurrentPatient(req,db);
   return {patientId:patientIdentity(req)};
  }).list(filters(req.query));
  res.json({success:true,...result});
 });return router;
}
