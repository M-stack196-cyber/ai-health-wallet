import {requireLive,RunRegistry,type Options,type Preflight,type Scenario,type ScenarioScope} from './guards.js';
export interface ScenarioPorts {
  prepare():Promise<void>;
  register(scenario:Scenario):Promise<string>;
  upload(scenario:Scenario,patientId:string):Promise<string>;
  process(scope:ScenarioScope,registry:RunRegistry):Promise<void>;
  verify(scope:ScenarioScope,patients:ReadonlyMap<Scenario,string>):Promise<void>;
  preserve():Promise<void>;
  close():Promise<void>;
}
export async function executeScenarios(options:Options,report:Preflight,ports:ScenarioPorts){
  requireLive(options,report); // No port is touched before both explicit execution approval and successful preflight.
  const registry=new RunRegistry(),patients=new Map<Scenario,string>();
  try{
    await ports.prepare();
    for(const scenario of ['A','B','C'] as const){const patient=await ports.register(scenario);registry.register(scenario,patient);patients.set(scenario,patient);}
    for(const scenario of ['A','B','C'] as const){
      const document=await ports.upload(scenario,patients.get(scenario)!);
      const scope=registry.attach(scenario,document);await ports.process(scope,registry);await ports.verify(scope,patients);
    }
  }finally{try{await ports.preserve();}finally{await ports.close();}}
}
