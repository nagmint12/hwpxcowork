import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, root } from './helpers/server.mjs';
import { AI_SAMPLES, AI_B_INSTRUCTION } from '../server/tutorial-samples.js';
import { Service } from '../server/service.js';
import { TutorialStore } from '../server/tutorial-store.js';
import { createTutorial } from '../server/tutorial.js';
import { createPersonalAi } from '../server/personal-ai.js';

test('AI 튜토리얼 4장에 가상 자료를 실제 본문으로 넣고 예시 요청·메모의 수치도 일치시킨다', async () => {
  const server = await startServer();
  try {
    const call = server.api('a'); const {docId}=await call('/api/tutorial/start',{method:'POST',body:{tutorialId:'ai-requests'}});
    const paragraphs=await call(`/api/docs/${docId}/paragraphs`); const text=paragraphs.map(p=>p.text).join('\n');
    for(const key of ['A','B','C']) assert.ok(paragraphs.some(p=>p.text===AI_SAMPLES[key]),key);
    assert.ok(text.indexOf('4. AI에게 실제로 맡겨 볼 예시') < text.indexOf(AI_SAMPLES.A));
    const requests=await call(`/api/docs/${docId}/requests`);
    assert.equal(requests[1].instruction,AI_B_INSTRUCTION);
    assert.equal(requests[0].target.text,AI_SAMPLES.A);
    const memos=await call(`/api/docs/${docId}/memos`);
    assert.ok(memos.some(m=>m.text.includes('400명')&&m.text.includes('348명')));
  } finally {await server.stop();}
});

// 2026-11-12 부터 연습 문서의 요청은 늘 예시 답변이다(tests/tutorial_report_examples.test.mjs) — 이 시험은 예시 답변을 끈(examples:false) 예전 관리자 AI 경로를 본다
test('실제 요청 경로도 4장의 본문을 AI에 전달하고 정상 제안을 만든다(외부 호출 없이 가짜 API)', async t => {
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'hwpx-live-tutorial-'));
  t.after(()=>{assert.ok(temporary.startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(temporary,{recursive:true,force:true,maxRetries:5,retryDelay:50});});
  const admin={name:'검증 관리자',role:'admin',token:'fake-admin'}; const user={name:'검증 사용자',role:'editor',token:'fake-user'};
  const config={root,dataDir:path.join(temporary,'data'),configFile:path.join(temporary,'config.json'),users:[admin,user],ai:{maxProposals:10},agents:{othersCanTake:false},tutorial:{users:[user.name],shareFrom:[admin.name],restrictUsers:false,examples:false}};
  const store=new TutorialStore(config.dataDir); let received=''; let targetRef;
  const personal=createPersonalAi({config,fetchImpl:async (url,init)=>{
    received=String(init.body);
    const output={proposals:[{ref:targetRef,find:'실시하였으며',replace:'실시했으며',reason:'간결한 문체'}],alternatives:[],comments:[],inserts:[],tables:[],summary:'문체를 다듬었습니다.',instructionSummary:'문체 정리'};
    return new Response(JSON.stringify({status:'completed',model:'test-api',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(output)}]}]}),{headers:{'Content-Type':'application/json'}});
  }});
  const service=new Service({store,config,hub:{broadcast(){},broadcastAll(){}},ai:{enabled:false}}); service.personalAi=personal;
  personal.save(admin,{provider:'openai',model:'test-api',key:'fake-local-test-key-only'});
  const tutorial=createTutorial({service,config}); const made=await tutorial.start(user,{tutorialId:'ai-requests'});
  assert.equal(received,'','예시 준비는 유료 요청을 보내지 않는다');
  const paragraph=(await service.paragraphs(made.docId)).find(p=>p.text===AI_SAMPLES.A); targetRef=paragraph.ref;
  const body=paragraph.text.replace(/^예시 문단 A\s*—\s*/,''); const start=[...paragraph.text].length-[...body].length;
  const actual=await service.createRequest(made.docId,{kind:'instruct',instruction:'숫자는 유지하고 이 문단 전체를 보고서 문체로 다듬어 줘',target:{ref:targetRef,start,end:start+[...body].length,text:body}},user);
  assert.equal(actual.request.status,'done'); assert.equal(actual.request.target.text,body);
  assert.ok(received.includes('420명')&&received.includes('84%'));
  const proposals=store.readMeta(made.docId).proposals.filter(p=>p.rid===actual.request.rid);
  assert.equal(proposals.length,1); assert.equal(proposals[0].ref,targetRef); assert.equal(proposals[0].find,'실시하였으며');
});
