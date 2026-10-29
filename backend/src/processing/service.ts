import {validatePythonEvidence} from "./python-processor.js";
import {validateExtraction} from "./extraction.js";
import type { createProcessingRepository, Claim } from "./repository.js";
import { failureCodes, InvalidProcessingClaim, InvalidProcessingInput, ProcessingUnavailable, type FailureCode } from "./errors.js";
const uuid=(value:unknown)=>typeof value==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export function createProcessingService(repository:ReturnType<typeof createProcessingRepository>) {
  const valid=(claim:Claim)=>{
    if(!claim||!uuid(claim.documentId)||!uuid(claim.patientId)||!uuid(claim.token))throw new InvalidProcessingInput();
  };
  async function safe<T>(operation:()=>Promise<T>):Promise<T>{try{return await operation();}catch{throw new ProcessingUnavailable();}}
  return {
    async resolveOriginal(claim:Claim){
      valid(claim);
      const reference=await safe(()=>repository.resolveOriginal(claim));
      if(!reference)throw new InvalidProcessingClaim();
      return reference;
    },
    persistExtraction(claim:Claim,input:unknown){
      valid(claim);
      const value=input as {pipeline?:unknown};
      if(value?.pipeline){
        const {pipeline,...base}=value;const result=validateExtraction(base),evidence=validatePythonEvidence(pipeline);
        return safe(()=>repository.persistPythonExtraction(claim,result,evidence));
      }
      const result=validateExtraction(input);return safe(()=>repository.persistExtraction(claim,result));
    },
    completedForClaim(claim:Claim){valid(claim);return safe(()=>repository.completedForClaim(claim));},
    discover(limit=20){if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new InvalidProcessingInput();return safe(()=>repository.discover(limit));},
    claim(){return safe(()=>repository.claim());},
    recover(){return safe(()=>repository.recover());},
    heartbeat(claim:Claim){valid(claim);return safe(()=>repository.heartbeat(claim));},
    complete(claim:Claim){valid(claim);return safe(()=>repository.complete(claim));},
    fail(claim:Claim,code:FailureCode,retryable=true){
      valid(claim);if(!failureCodes.includes(code)||typeof retryable!=="boolean")throw new InvalidProcessingInput();
      return safe(()=>repository.fail(claim,code,retryable));
    },
  };
}
