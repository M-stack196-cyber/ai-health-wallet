import {guard} from '../processing/background-config.js';
import {createSystemdSupervisor,type Command} from './systemd-adapter.js';
import type {UnitPlan,Supervisor} from './supervision.js';
import type {InsideProtection} from './inside-protection.js';
import {createSystemManagerSupervisor,type SystemPlan,type SystemManagerPorts,type SystemManagerSupervisor} from './system-supervision.js';
export interface UserSelection {
  manager:'user';plan:UnitPlan;verifyLaunch():Promise<void>;saveInside(r:InsideProtection):Promise<void>;command?:Command;
}
export interface SystemSelection {manager:'system';plan:SystemPlan;ports:SystemManagerPorts;}
export interface UserManagerSupervisor {readonly manager:'user';readonly operations:Supervisor&{ownsHealth(port:number):Promise<void>};}
export function selectSupervision(selection:UserSelection):UserManagerSupervisor;
export function selectSupervision(selection:SystemSelection):SystemManagerSupervisor;
export function selectSupervision(selection:UserSelection|SystemSelection):UserManagerSupervisor|SystemManagerSupervisor {
  guard(selection&&['user','system'].includes(selection.manager));
  if(selection.manager==='user')return {manager:'user',operations:createSystemdSupervisor(selection.plan,selection.verifyLaunch,selection.saveInside,selection.command)};
  return createSystemManagerSupervisor(selection.plan,selection.ports);
}
// No environment switch, automatic selection, CLI registration or existing caller
// change. System selection cannot consume a user Command transport (and vice versa).
