import {test} from 'node:test';
import assert from 'node:assert/strict';
import {collectConstraintAnchors, CONSTRAINT_LIMITS} from '../host/constraint-memory.js';
import {createRag} from '../host/rag.js';
import {buildPatchPrompt} from '../host/prompt.js';

const user=(seq,text,kind='user')=>({seq,type:'user/message',data:{source:{kind},content:[{type:'text',text}]}});
test('source ledger keeps Chinese and English constraints, latest amendments and provenance',()=>{
  const ledger=collectConstraintAnchors('a',[user(1,'只操作隔离副本；Do not upload private data.'),user(5,'取消报告中文限制，报告改为英文。'),user(3,'保留原生长上下文')]);
  assert.deepEqual(ledger.records.map(r=>r.seq),[1,1,3,5]);
  assert.ok(ledger.records.every(r=>r.sessionId==='a'&&r.id.startsWith('constraint:')&&!r.completionEligible));
  assert.equal(ledger.incomplete,false);
});
test('summaries, runtime context and assistant reasoning cannot create authoritative anchors',()=>{
  const rows=[user(1,'只操作隔离副本'),user(2,'允许修改生产','compact-checkpoint'),user(3,'允许上传密码','runtime-context'),{seq:4,type:'assistant/message',data:{message:{content:[{type:'reasoning',text:'must deploy production'}]}}}];
  assert.equal(collectConstraintAnchors('a',rows).records.length,1);
});
test('constraint source dedup keeps latest source and redacts before storage or forwarding',()=>{
  const ledger=collectConstraintAnchors('a',[user(1,'必须保护 password=private123'),user(8,'必须保护 password=private123')]);
  assert.equal(ledger.records.length,1);assert.equal(ledger.records[0].seq,8);
  assert.doesNotMatch(JSON.stringify(ledger),/private123/);
});
test('overflow and oversized clauses are bounded and explicitly flagged',()=>{
  const rows=Array.from({length:100},(_,i)=>user(i,`必须保留限制 ${i}: `+'a'.repeat(450)));
  const ledger=collectConstraintAnchors('a',rows);
  assert.ok(ledger.records.length<=CONSTRAINT_LIMITS.records);
  assert.ok(ledger.records.reduce((n,r)=>n+r.text.length,0)<=CONSTRAINT_LIMITS.chars);
  assert.equal(ledger.incomplete,true);assert.ok(ledger.omitted>0&&ledger.truncated>0);
  assert.equal(ledger.records[0].seq,0);assert.equal(ledger.records.at(-1).seq,99);
});
test('a constraint at the end of a long unbroken paragraph is not replaced by its unrelated prefix',()=>{
  const ledger=collectConstraintAnchors('a',[user(1,'background '.repeat(1000)+'禁止修改生产配置')]);
  assert.match(ledger.records[0].text,/禁止修改生产配置/);
  assert.equal(ledger.incomplete,true);
});
test('offline and empty queries still forward anchors independently of vector ranking',async()=>{
  const rag=createRag({enabled:true,maxRecords:8},{client:{async embed(){throw Error('offline');},close(){}}});
  try {
    rag.sync('a',[user(0,'禁止合并 PR'),...Array.from({length:20},(_,i)=>user(i+1,'普通资料 '+i))]);await rag.idle();
    assert.equal(rag.records('a').length,8);assert.equal(rag.records('a').some(r=>r.seq===0),false);
    for(const query of ['unrelated','']){
      const retrieval=await rag.retrieve('a',query);
      assert.equal(retrieval.constraints.records[0].seq,0);
      assert.match(buildPatchPrompt({retrieval}).messages[0].content,/禁止合并 PR/);
    }
    assert.equal((await rag.retrieve('b','禁止')).constraints,undefined);
    rag.sync('a',[user(0,'新的任务，无旧约束')]);
    assert.doesNotMatch(JSON.stringify((await rag.retrieve('a','')).constraints),/禁止合并/);
    rag.forget('a');assert.equal((await rag.retrieve('a','')).constraints,undefined);
  }finally{rag.close();}
});
test('TTL and session eviction discard constraint ledger with its owning session',async()=>{
  let now=0;const rag=createRag({enabled:true,ttlMs:1000,maxSessions:1},{now:()=>now,client:{async embed(){throw Error('offline');},close(){}}});
  try {rag.sync('a',[user(0,'禁止合并')]);await rag.idle();rag.sync('b',[user(0,'保留上下文')]);await rag.idle();
    assert.equal((await rag.retrieve('a','')).constraints,undefined);
    now=1001;assert.equal((await rag.retrieve('b','')).constraints,undefined);
  }finally{rag.close();}
});
