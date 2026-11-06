import {createGuardianRepository} from '../guardians/repository.js';
import {Router, type Request} from 'express';
import {rateLimit} from 'express-rate-limit';
import type {AuthenticationConfig} from '../config/auth.js';
import {ApiError} from '../http/errors.js';
import {createPatientRepository, type PatientDatabase, type PatientConnection} from '../patients/repository.js';
import {validateLogin,validateRegistration,validateProfilePatch,normalizeEmail,password} from '../patients/validation.js';
import {patientIdentity,rejectRequestBody,rejectQueryParameters,requireJson,requirePatient} from './middleware.js';
import {createPasswordService} from './passwords.js';
import {createTokenService} from './tokens.js';
import {createSecurityRepository,rateHash,type ChallengePurpose,type SessionIdentity} from './security-repository.js';
import {getSecurityPolicy,type SecurityPolicy} from './security-policy.js';
import {createDeletionRepository} from '../deletion/repository.js';

/** Transport receives secrets only in memory. It must not log payloads or persist plaintext.
 * No real email provider or live sends are enabled by default. */
export interface SecurityMailMessage {to:string;purpose:ChallengePurpose|'guardian_invitation'|'doctor_share_otp';token:string;expiresIn:number;}
export interface SecurityMailer {
 send(message:SecurityMailMessage):Promise<void>;
 enqueue?(message:SecurityMailMessage,client:PatientConnection):Promise<void>;
}
export interface IdentityOptions {mailer?:SecurityMailer;policy?:SecurityPolicy;}
const denied=()=>new ApiError(401,'INVALID_CREDENTIALS','Invalid credentials or authorization.');
const badChallenge=()=>new ApiError(400,'INVALID_AUTHORIZATION','Authorization is invalid or expired.');
function fields(value:unknown,allowed:string[]):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!allowed.includes(k)))
  throw new ApiError(400,'INVALID_INPUT','Request fields are missing, invalid or not permitted.');
 return value as Record<string,unknown>;
}
function tokenField(value:unknown):string {
 if(typeof value!=='string'||value.length>160)throw badChallenge();return value;
}
function identity(req:Request):SessionIdentity {
 if(!req.auth?.sessionId)throw denied();return {patientId:patientIdentity(req),sessionId:req.auth.sessionId};
}
export function createPatientRoutes(database:PatientDatabase,config:AuthenticationConfig,options:IdentityOptions={}) {
 const patients=createPatientRepository(database),passwords=createPasswordService(config),tokens=createTokenService(config);
 const policy=options.policy??getSecurityPolicy(),security=createSecurityRepository(database,policy),deletion=createDeletionRepository(database);
 const auth=Router(),profile=Router();
 const limiter=rateLimit({windowMs:config.rateLimitWindowMs,limit:config.rateLimitMax,standardHeaders:'draft-8',legacyHeaders:false,
  validate:{xForwardedForHeader:false},message:{success:false,error:{code:'RATE_LIMITED',message:'Too many authentication attempts. Try again later.'}}});
 auth.use(limiter,rejectQueryParameters);
 const authorize=requirePatient(tokens,database);
 async function rate(req:Request,scope:string,subject?:string,challenge=false) {
  const max=challenge?policy.challengeRateMax:config.rateLimitMax;
  // Persisted IP and subject buckets work across API instances; neither stores raw IP/email.
  const keys=[rateHash(config.jwtKey,scope+':ip',req.ip??'unknown')];
  if(subject)keys.push(rateHash(config.jwtKey,scope+':subject',subject));
  for(const key of keys)if(!await security.rate(key,max,policy.rateWindowSeconds))throw new ApiError(429,'RATE_LIMITED','Too many authentication attempts. Try again later.');
 }
 function mailReady(){if(!options.mailer)throw new ApiError(503,'IDENTITY_DELIVERY_UNAVAILABLE','Identity email delivery is temporarily unavailable.');}
 async function send(email:string,purpose:ChallengePurpose) {
  const message=await security.issueChallenge(email,purpose,options.mailer?.enqueue?.bind(options.mailer));
  if(message && !options.mailer?.enqueue){
   try {await options.mailer!.send({to:message.email,purpose,token:message.token,expiresIn:message.expiresIn});}
   catch {await security.audit('delivery_failed',message.patientId);}
  }
 }
 async function sessionResponse(session:{patientId:string;sessionId:string;refreshToken:string;refreshExpiresIn:number}) {
  return {success:true,access_token:await tokens.issue(session.patientId,session.sessionId),token_type:'Bearer',expires_in:config.jwtLifetimeSeconds,
   refresh_token:session.refreshToken,refresh_expires_in:session.refreshExpiresIn};
 }
 auth.post('/register',requireJson,async(req,res)=>{
  const input=validateRegistration(req.body);mailReady();await rate(req,'register',input.email);
  const patient=await patients.register(input,await passwords.hash(input.password));
  await send(input.email,'verify_email');
  res.status(201).json({success:true,patient});
 });
 auth.post('/login',requireJson,async(req,res)=>{
  const input=validateLogin(req.body);await rate(req,'login',input.email);
  const credentials=await patients.credentials(input.email);
  const valid=await passwords.verify(input.password,credentials?.password_hash);
  if(!credentials||!valid){await security.audit('login_failed',credentials?.id);throw denied();}
  const session=await security.login(credentials.id,credentials.password_hash);
  if(!session)throw denied();res.status(200).json(await sessionResponse(session));
 });
 for(const [path,purpose] of [['/verification/resend','verify_email'],['/forgot-password','reset_password']] as const){
  auth.post(path,requireJson,async(req,res)=>{
   const input=fields(req.body,['email']),email=normalizeEmail(input.email);mailReady();await rate(req,purpose+':issue',email,true);
   try {await send(email,purpose);}
   catch {await security.audit('delivery_failed').catch(()=>{});}
   // Identical status/body for unknown, ineligible, throttled-by-cooldown and eligible users.
   res.status(202).json({success:true,message:'If eligible, an email will be sent.'});
  });
 }
 auth.post('/verify-email',requireJson,async(req,res)=>{
  const input=fields(req.body,['token']),token=tokenField(input.token);await rate(req,'verify:consume',undefined,true);
  if(!await security.consumeChallenge(token,'verify_email'))throw badChallenge();
  if(options.mailer?.enqueue){
   try{await createGuardianRepository(database,policy,options.mailer).registrationIntent(token);}
   catch{await security.audit('delivery_failed').catch(()=>{});}
  }
  res.json({success:true});
 });
 auth.post('/reset-password',requireJson,async(req,res)=>{
  const input=fields(req.body,['token','new_password']),token=tokenField(input.token),replacement=password(input.new_password,true);
  await rate(req,'reset:consume',undefined,true);
  if(!await security.consumeChallenge(token,'reset_password',await passwords.hash(replacement)))throw badChallenge();
  res.json({success:true});
 });
 auth.post('/refresh',requireJson,async(req,res)=>{
  const input=fields(req.body,['refresh_token']),token=tokenField(input.refresh_token);await rate(req,'refresh');
  const session=await security.refresh(token);if(!session)throw denied();res.json(await sessionResponse(session));
 });
 auth.post('/logout',authorize,requireJson,async(req,res)=>{
  fields(req.body,[]);await security.logout(identity(req));res.json({success:true});
 });
 auth.post('/change-password',authorize,requireJson,async(req,res)=>{
  const input=fields(req.body,['current_password','new_password']);await rate(req,'password-change',patientIdentity(req));
  const current=password(input.current_password,false),replacement=password(input.new_password,true);
  const p=await patients.get(patientIdentity(req)),credentials=await patients.credentials(p.email);
  if(!credentials||!await passwords.verify(current,credentials.password_hash))throw denied();
  if(!await security.changePassword(identity(req),credentials.password_hash,await passwords.hash(replacement)))throw denied();
  res.json({success:true});
 });
 profile.use(authorize,rejectQueryParameters);
 profile.get('/me',rejectRequestBody,async(req,res)=>res.json({success:true,patient:await patients.get(patientIdentity(req))}));
 profile.patch('/me',requireJson,async(req,res)=>{
  const changes=validateProfilePatch(req.body);res.json({success:true,patient:await patients.update(patientIdentity(req),changes)});
 });
 profile.post('/me/deletion-request',requireJson,async(req,res)=>{
  const input=fields(req.body,['current_password','confirmation']);await rate(req,'account-deletion',patientIdentity(req));
  const current=password(input.current_password,false);
  if(input.confirmation!=='DELETE_MY_ACCOUNT')throw new ApiError(400,'CONFIRMATION_REQUIRED','Confirmation text is missing or incorrect.');
  const p=await patients.get(patientIdentity(req)),credentials=await patients.credentials(p.email);
  if(!credentials||!await passwords.verify(current,credentials.password_hash))throw denied();
  const result=await deletion.request(identity(req),credentials.password_hash);if(!result)throw denied();
  // Honest outcome: access is ended now; nothing has been physically deleted yet.
  res.status(202).json({success:true,deletion_request:result,access_revoked:true,physical_deletion:'not_performed'});
 });
 return {auth,profile};
}
