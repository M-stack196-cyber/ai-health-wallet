export const failureCodes=["PROCESSOR_FAILED","PROCESSOR_TIMEOUT","INTERRUPTED","INVALID_INPUT","LEASE_EXPIRED"] as const;
export type FailureCode=typeof failureCodes[number];
export class ProcessingUnavailable extends Error {
  constructor(){super("Document processing is temporarily unavailable.");}
}
export class InvalidProcessingInput extends Error {
  constructor(){super("Invalid document processing input.");}
}
export class ProcessorFailure extends Error {
  constructor(readonly code: Exclude<FailureCode,"LEASE_EXPIRED">="PROCESSOR_FAILED",readonly retryable=true){super("Document processor failed.");}
}

export class InvalidProcessingClaim extends Error {
  constructor(){super("The processing claim is no longer valid.");}
}
export class OriginalUnavailable extends ProcessorFailure {
  constructor(){super("PROCESSOR_FAILED",true);}
}

export class InvalidExtractionResult extends ProcessorFailure {
  constructor(){super("INVALID_INPUT",false);}
}
