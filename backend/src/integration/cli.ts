import {pathToFileURL} from 'node:url';
import {parseFlags,checkEnvironment,preflight,VerificationFailure,insist} from './guards.js';
import {loadPinnedProfile,awsReadFor} from './aws-preflight.js';

export async function main(args:string[]):Promise<number>{
  try{
    const options=parseFlags(args); // Reject incomplete/unknown/write flags before loading any application module.
    await import('../config/env.js');checkEnvironment(process.env);
    const profile=await loadPinnedProfile();
    const report=await preflight(awsReadFor(profile));
    console.log(JSON.stringify({mode:'preflight',...report}));
    if(!report.passed)return 2;
    if(options.mode==='preflight')return 0;
    insist(options.liveWrites,'WRITES_DISABLED');
    // This branch requires separate Gate 2 approval. Gate 1 invokes --preflight only.
    const {runLiveScenarios}=await import('./live-run.js');
    await profile.unchanged();await runLiveScenarios(options,report,profile.credentials);return 0;
  }catch(error){
    console.error(JSON.stringify({passed:false,code:error instanceof VerificationFailure?error.code:'VERIFICATION_FAILED'}));return 1;
  }
}
// Importing this module never starts a runner, opens a DB connection or calls AWS.
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){process.exitCode=await main(process.argv.slice(2));}
