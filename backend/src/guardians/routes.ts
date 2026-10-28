import {Router,type Request} from 'express';
import {rateLimit} from 'express-rate-limit';
import type {PatientDatabase} from '../patients/repository.js';
import type {AuthenticationConfig} from '../config/auth.js';
import type {IdentityOptions} from '../auth/routes.js';
import {getSecurityPolicy} from '../auth/security-policy.js';
import {createTokenService} from '../auth/tokens.js';
import {requirePatient,patientIdentity,requireJson,rejectQueryParameters,rejectRequestBody} from '../auth/middleware.js';
import {normalizeEmail} from '../patients/validation.js';
import {ApiError} from '../http/errors.js';
import {createGuardianRepository,type GuardianRow} from './repository.js';
const publicState=(g:GuardianRow|undefined)=>g?{id:g.id,email:g.email,status:g.status,accepted_at:g.accepted_at,invitation_expires_at:g.expires_at}:{status:'NONE'};
function fields(value:unknown,allowed:string[]){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!allowed.includes(k)))throw new ApiError(400,'INVALID_INPUT','Request fields are invalid.');return value as Record<string,unknown>;}
export function createGuardianRoutes(db:PatientDatabase,auth:AuthenticationConfig,options:IdentityOptions={}){
 const router=Router(),repo=createGuardianRepository(db,options.policy??getSecurityPolicy(),options.mailer);
 const who=(req:Request)=>({patientId:patientIdentity(req),sessionId:req.auth!.sessionId!});
 router.use((_req,res,next)=>{res.set('Cache-Control','no-store');next();},rejectQueryParameters);
 // Acceptance is deliberately POST-only: email scanners/prefetchers cannot accept an invite.
 router.post('/guardian-invitations/accept',rateLimit({windowMs:900000,limit:20,legacyHeaders:false,standardHeaders:'draft-8'}),requireJson,async(req,res)=>{
  const v=fields(req.body,['token']);if(typeof v.token!=='string'||v.token.length>160)throw new ApiError(400,'INVALID_GUARDIAN_INVITATION','Invitation is invalid or expired.');
  await repo.accept(v.token);res.json({success:true});
 });
 router.use('/patients/me/guardian',requirePatient(createTokenService(auth),db));
 router.get('/patients/me/guardian',rejectRequestBody,async(req,res)=>res.json({success:true,guardian:publicState(await repo.status(who(req)))}));
 for(const method of ['post','put'] as const)router[method]('/patients/me/guardian',requireJson,async(req,res)=>{
  const v=fields(req.body,['email']);const email=v.email===undefined?undefined:normalizeEmail(v.email);
  res.status(method==='post'?201:200).json({success:true,guardian:publicState(await repo.nominate(who(req),email,method==='put'))});
 });
 router.post('/patients/me/guardian/resend',requireJson,async(req,res)=>{fields(req.body,[]);res.json({success:true,guardian:publicState(await repo.resend(who(req)))});});
 router.delete('/patients/me/guardian',rejectRequestBody,async(req,res)=>res.json({success:true,guardian:publicState(await repo.remove(who(req)))}));
 return router;
}
