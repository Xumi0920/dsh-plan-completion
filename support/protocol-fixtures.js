import {complexFixtures} from './complex-fixtures.js';
export function protocolFixtures() {
  const fixtures=complexFixtures();
  for(const family of ['qq','workflow'])for(const mode of ['explicit-weak','revised']){
    const f=structuredClone(fixtures.find(f=>f.name===family+(mode==='revised'?'-complete':'-weak-contract')));
    f.name=family+'-'+mode;f.mode=mode;f.sessionId='synthetic-'+f.name;f.plan.sessionId=f.sessionId;
    if(mode==='explicit-weak')f.plan.steps[4].completion.expect={field:'accepted',equals:true};
    fixtures.push(f);
  }
  const expected={complete:['done','done','done','done','done','done'],partial:['done','done','done','todo','todo','todo'],
    failed:['done','done','blocked','blocked','blocked','blocked'],unknown:['done','done','done','done','doing','blocked'],
    'wrong-target':['done','done','done','done','todo','todo'],stale:['done','doing','blocked','blocked','blocked','blocked'],
    'intent-only':['todo','todo','todo','todo','todo','todo'],recovered:['done','done','done','doing','blocked','blocked'],
    'weak-contract':['done','done','done','done','blocked','blocked'],'explicit-weak':['done','done','done','done','blocked','blocked'],
    revised:['done','doing','blocked','blocked','blocked','blocked']};
  for(const f of fixtures) {
    f.expected=expected[f.mode];
    f.plan.steps.forEach((s,i)=>{s.acceptance={scope:['assertion','assertion','assertion','deployment','delivery','assertion'][i],revision:1,afterSeq:-1,dependsOn:i?[{stepId:f.plan.steps[i-1].id,revision:1}]:[]};});
    if(f.mode==='revised'){f.plan.steps[1].acceptance.revision=2;f.plan.steps[1].acceptance.afterSeq=f.events.length-1;}
  }
  return fixtures;
}
