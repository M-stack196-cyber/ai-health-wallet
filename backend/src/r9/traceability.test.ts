// Phase R9: the requirements traceability audit as executable checks. No database, no network.
// Run: npm run r9:trace:test   (from backend/)
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync,readdirSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../../../',import.meta.url));
const matrix=readFileSync(join(root,'docs/R9_REQUIREMENTS_TRACEABILITY_MATRIX.md'),'utf8');
const trackerText=readFileSync(join(root,'docs/PRD_V2_MODULE_DELIVERY_TRACKER.md'),'utf8');
const statuses=['IMPLEMENTED','PARTIAL','MISSING','BLOCKED','NEEDS_REVERIFICATION'];
const rows=trackerText.split('\n').filter(l=>/^\| M\d\d-\d+ \|/.test(l)).map(l=>{const c=l.trim().replace(/^\||\|$/g,'').split(' | ').map(x=>x.trim());return {id:c[0],src:c[2],status:c[6]};});
const ids=(prefix:string,count:number,width:number)=>Array.from({length:count},(_,i)=>prefix+'-'+String(i+1).padStart(width,'0'));
const matrixRow=(id:string)=>matrix.split('\n').find(l=>l.startsWith('| '+id+' |'));

test('R9-TRACE-01 every FR, NFR, DEC and V item has a row, and the matrix matches the SRS and tracker it is built from',()=>{
  for(const id of [...ids('FR',55,3),...ids('NFR',8,2),...ids('DEC',22,2),...ids('V',34,2)])assert.ok(matrixRow(id),id+' is missing from the matrix');
  const run=spawnSync('python3',['infrastructure/r9/build_traceability.py','--check'],{cwd:root,encoding:'utf8'});
  assert.equal(run.status,0,'matrix is stale or the SRS register sizes changed: '+(run.stderr||run.stdout));
});

test('R9-TRACE-02 tracker: 232 unique rows, header totals and module table equal the row statuses',()=>{
  assert.equal(rows.length,232);assert.equal(new Set(rows.map(r=>r.id)).size,232);
  for(const r of rows)assert.ok(statuses.includes(r.status),r.id+' has an unknown status '+r.status);
  const total=Object.fromEntries(statuses.map(s=>[s,rows.filter(r=>r.status===s).length]));
  const header=trackerText.match(/^Status totals: (.*)\.$/m)![1];
  assert.equal(header,statuses.map(s=>s+'='+total[s]).join(', '),'header status totals differ from the rows');
  const tableRows=trackerText.split('\n').filter(l=>/^\| M\d\d \|/.test(l));
  assert.equal(tableRows.length,18);
  for(const line of tableRows){
    const c=line.trim().replace(/^\||\|$/g,'').split(' | ').map(x=>x.trim()),m=c[0],mine=rows.filter(r=>r.id.startsWith(m+'-'));
    assert.deepEqual(c.slice(2,8).map(Number),[mine.length,...statuses.map(s=>mine.filter(r=>r.status===s).length)],m+' module table row differs from its rows');
  }
});

test('R9-TRACE-03 every requirement cites real tracker rows or a module that inherits it, and every cited row exists',()=>{
  const known=new Set(rows.map(r=>r.id));
  for(const id of [...ids('FR',55,3),...ids('NFR',8,2),...ids('DEC',22,2)]){
    const cells=matrixRow(id)!.split(' | ');assert.ok(cells.length>=5,id+' row is malformed');
    const direct=cells[3].match(/M\d\d-\d+/g)??[];
    if(direct.length===0)assert.match(cells[4],/M\d\d/,id+' has neither direct rows nor an inheriting module');
    for(const r of direct)assert.ok(known.has(r),id+' cites unknown row '+r);
    assert.match(cells[2],/^(IMPLEMENTED|PARTIAL|MISSING|BLOCKED|NEEDS_REVERIFICATION)/,id+' has no roll-up');
  }
});

function sources(dir:string,out:string[]=[]){
  for(const name of readdirSync(dir)){
    if(['node_modules','.git','venv','dist','.expo'].includes(name))continue;
    const p=join(dir,name),s=statSync(p);
    if(s.isDirectory())sources(p,out);else if(/\.(ts|tsx|py)$/.test(name)&&/(test|check|unit|contract|browser|quality|workflows)/i.test(name))out.push(p);
  }return out;
}
test('R9-TRACE-04 every test ID cited for a V scenario exists in a test file',()=>{
  const files=['backend/src','frontend/tests','frontend/apps','ai-service'].flatMap(d=>sources(join(root,d)));
  const text=files.map(f=>readFileSync(f,'utf8')).join('\n');
  const section=matrix.split('## E. Verification scenarios')[1];assert.ok(section);
  const cited=new Set<string>();
  for(const line of section.split('\n').filter(l=>/^\| V-\d\d \|/.test(l))){
    const tests=line.split(' | ')[3];
    for(const part of tests.split(/[;,]/)){
      for(const token of part.match(/\b(?:P\d|R\d|M03)-[A-Z0-9-]*\d\b(?:\.\.(?:[A-Z]\d-)?[A-Z0-9-]*\d)?/g)??[]){
        const [first,last]=token.split('..');cited.add(first);
        if(last)cited.add(/^[A-Z]\d-/.test(last)?last:first.replace(/\d+$/,'')+last);
      }
    }
  }
  assert.ok(cited.size>40,'expected many cited test IDs, found '+cited.size);
  const missing=[...cited].filter(id=>!(new RegExp('(?<![A-Z0-9-])'+id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?![0-9])').test(text))&&!text.includes(id.slice(0,-1)+'${')&&!id.startsWith('R9-TRACE'));  // a title built from a template (R8-BUILD-0${n}) counts
  assert.deepEqual(missing,[],'cited test IDs not found in any test file');
});

test('R9-TRACE-05 V verdicts use the allowed words, VERIFIED_LOCAL always cites tests, and BLOCKED or PARTIAL always name the gap',()=>{
  const section=matrix.split('## E. Verification scenarios')[1];
  const lines=section.split('\n').filter(l=>/^\| V-\d\d \|/.test(l));assert.equal(lines.length,34);
  for(const line of lines){
    const c=line.split(' | '),id=c[0].replace('| ',''),verdict=c[2],tests=c[3],gap=c[4].replace(/ \|$/,'');
    assert.ok(['VERIFIED_LOCAL','PARTIAL','BLOCKED'].includes(verdict),id+' has verdict '+verdict);
    assert.ok(tests.trim().length>0&&tests.trim()!=='-',id+' cites no tests');
    if(verdict!=='VERIFIED_LOCAL')assert.ok(gap.trim().length>10&&gap.trim()!=='-',id+' must say what is not proven');
  }
  // Items that need an approval or resource that does not exist can never be verified.
  for(const id of ['V-17','V-20','V-33'])assert.match(matrixRow(id)!,/\| BLOCKED \|/,id+' must stay BLOCKED');
  assert.doesNotMatch(matrix,/RELEASE_ACCEPTED|ACCEPTED_FOR_RELEASE/);
});
