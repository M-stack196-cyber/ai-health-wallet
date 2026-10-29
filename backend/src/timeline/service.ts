import type {PatientDatabase} from '../patients/repository.js';
import type {DocumentFilters} from '../documents/validation.js';
import {createDocumentRepository,publicDocument} from '../documents/repository.js';
import {ApiError} from '../http/errors.js';
export interface TimelineScope {patientId:string;permittedDocumentIds?:readonly string[];}
// The server supplies a current authorization resolver; never accept a scope from
// a request body. M09 must implement its own doctor/OTP/current-grant resolver.
export function createTimelineService(db:PatientDatabase,resolveScope:()=>Promise<TimelineScope>){
 return {async list(options:DocumentFilters){
  const scope=await resolveScope(),fingerprint=JSON.stringify(scope);
  const result=await createDocumentRepository(db).list(scope.patientId,options,scope.permittedDocumentIds);
  if(JSON.stringify(await resolveScope())!==fingerprint)throw new ApiError(403,'TIMELINE_ACCESS_CHANGED','Timeline access changed.');
  return {entries:result.documents.map(row=>({source_document_id:row.id,event_date:row.sort_date,date_source:row.sort_date_source,document:publicDocument(row)})),
   pagination:{limit:options.limit,offset:options.offset,has_more:result.hasMore}};
 }};
}
