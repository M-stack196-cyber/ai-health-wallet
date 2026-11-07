import type {PatientDatabase} from '../patients/repository.js';

/**
 * The only door a future physical-deletion step may use (records, files, chunks, embeddings, summaries).
 * While the CFG-12/CFG-18 policy is pending the database function always raises, so the action never runs.
 * Fail closed: any problem asking the database counts as "blocked". Nothing in this phase calls it to delete data.
 */
export class PhysicalDeletionBlockedError extends Error {
 constructor(){super('Physical deletion is blocked: the deletion policy is pending (CFG-12/CFG-18).');this.name='PhysicalDeletionBlockedError';}
}

export async function assertPhysicalDeletionAllowed(db:Pick<PatientDatabase,'query'>):Promise<void> {
 try {await db.query('SELECT public.assert_physical_deletion_allowed()',[]);}
 catch {throw new PhysicalDeletionBlockedError();}
}

/** Runs `action` only after the policy gate passes. The action is never started while the policy is pending. */
export async function runPhysicalDeletion<T>(db:Pick<PatientDatabase,'query'>,action:()=>Promise<T>):Promise<T> {
 await assertPhysicalDeletionAllowed(db);
 return action();
}
