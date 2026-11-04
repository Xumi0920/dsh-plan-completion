import {test} from 'node:test';
import assert from 'node:assert/strict';
import {collectRetrievalRecords} from '../host/rag-evidence.js';
import {validateProgress} from '../host/progress.js';

function receipt(value,extra={}) {
 return collectRetrievalRecords('payload-test',[
  {seq:1,type:'tool/call',data:{turn:1,name:'read_file',callId:'r',arguments:{path:'src/ledger.mjs'}}},
  {seq:2,type:'tool/result',data:{turn:1,message:{toolCallId:'r',...extra,content:[{type:'text',text:JSON.stringify(value)}]}}},
 ]).find(r=>r.kind==='tool_result');
}
test('successful structured file reads ignore status words and failure examples inside content',()=>{
 for(const content of ['throw Error("Task is not in progress");','exit code 1; 2 tests failed','Process running with session ID 7','等待回执；pending']){
  const r=receipt({ok:true,content});assert.equal(r.outcome,'success');assert.equal(r.completionEligible,true);
 }
});
test('read payload cannot hide an explicit failure or pending execution status',()=>{
 for(const value of [{ok:false,content:'success'},{ok:true,exitCode:1,content:'success'},{ok:true,error:'failure',content:'success'}])assert.equal(receipt(value).outcome,'failure');
 assert.equal(receipt({ok:true,content:'success'},{isError:true}).outcome,'failure');
 for(const value of [{ok:true,pending:true,content:'success'},{ok:true,status:'in_progress',content:'success'},{ok:true,output:'Process running with session ID 7'}])assert.equal(receipt(value).outcome,'unknown');
});
test('text in a read payload cannot create a missing successful execution result',()=>{
 const r=receipt({content:'exit code 0'});assert.equal(r.outcome,'unknown');assert.equal(r.completionEligible,false);
});

test('large source writes retain exact path identity and complete only after readback and tests',()=>{
 const content='// in progress; exit code 1 example\n'+'x'.repeat(6000),path='src/ledger.mjs',events=[];
 for(const [tool,args,value]of[
  ['write_file',{content,path},{ok:true}],['read_file',{path},{ok:true,content}],['exec',{command:'node --test'},{exitCode:0}],
 ]){const callId='c'+events.length;events.push({seq:events.length,type:'tool/call',data:{turn:1,callId,name:tool,arguments:args}});events.push({seq:events.length,type:'tool/result',data:{turn:1,message:{toolCallId:callId,content:[{type:'text',text:JSON.stringify(value)}]}}});}
 const rows=collectRetrievalRecords('payload-test',events),write=rows.find(r=>r.kind==='tool_call'&&r.tool==='write_file');
 assert.deepEqual(write.args,{path});assert.doesNotMatch(write.text,/x{100}/);
 const plan={sessionId:'payload-test',steps:[{id:'s1',title:'修改、回读并测试',status:'todo',completion:{all:[{tool:'write_file',args:{path}},{tool:'read_file',args:{path}},{tool:'exec',args:{command:'node --test'}}]}}]};
 const proposal={op:'patch',changes:[{id:'s1',status:'done',evidence:rows.filter(r=>r.kind==='tool_result').map(r=>r.id)}]};
 assert.equal(validateProgress(proposal,plan,rows).output.changes[0].status,'done');
 assert.notEqual(validateProgress(proposal,plan,rows.slice(0,-1)).output.changes[0].status,'done');
});
