// 2026-11-12 부터 연습 문서의 요청은 늘 예시 답변이다 — 관리자 ChatGPT 튜토리얼 이벤트 경로는 예시 답변을 끈(examples:false) 설정에서 본다
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Service } from '../server/service.js';
import { Store } from '../server/store.js';
import { Hub } from '../server/hub.js';
import { createTutorial } from '../server/tutorial.js';
import { createMcpEvents, TUTORIAL_EVENT_NAME } from '../server/mcp-events.js';
import { startServer } from './helpers/server.mjs';

function setup(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hwpx-chatgpt-tutorial-'));
  const admin={name:'관리자',role:'admin',token:'admin-secret'};
  const other={name:'다른관리자',role:'admin',token:'other-secret'};
  const user={name:'test1',role:'editor',token:'test-secret'};
  const config={root:process.cwd(),dataDir:dir,publicUrl:'https://cowork.example',users:[admin,other,user],tutorial:{users:['test1'],shareChatGPT:[admin.name],restrictUsers:false,examples:false},agents:{othersCanTake:false}};
  const store=new Store(dir);const hub=new Hub();
  const service=new Service({store,hub,config,ai:{enabled:false}});
  const tutorial=createTutorial({service,config});const deliveries=[];
  const events=createMcpEvents({config,service,hub,autoStart:false,webhookFetch:async(url,opts)=>{
    const payload=JSON.parse(opts.body);deliveries.push(payload);
    return {ok:true,status:200,body:JSON.stringify(payload.type?{challenge:payload.challenge}:{})};
  }});
  service.tutorialChatGPTReady=()=>events.hasTutorialSubscriber();
  service.tutorialChatGPTDelivery=(...args)=>events.tutorialRequestStatus(...args);
  t.after(async()=>{await events.close();fs.rmSync(dir,{recursive:true,force:true});});
  const params={name:TUTORIAL_EVENT_NAME,arguments:{},delivery:{mode:'webhook',url:'https://receiver.example/tutorial',secret:'whsec_'+crypto.randomBytes(32).toString('base64')}};
  return {admin,other,user,config,store,service,tutorial,events,deliveries,params};
}

test('shared tutorial: event → administrator claim → proposal → complete; ordinary documents and other accounts excluded',async t=>{
  const s=setup(t);
  assert.equal(s.events.list(s.admin).events.length,2);
  assert.equal(s.events.list(s.user).events.length,1);
  for(const user of [s.user,s.other])await assert.rejects(s.events.subscribe({user},s.params),e=>e.code===-32024);
  await s.events.subscribe({user:s.admin},s.params);
  assert.equal(s.events.hasTutorialSubscriber(),true);
  const {docId}=await s.tutorial.start(s.user,{tutorialId:'overview'});
  const request=(await s.service.createRequest(docId,{kind:'instruct',instruction:'표현 검토',target:{ref:'s0/p0'}},s.user)).request;
  assert.equal(request.route,'queue');
  await s.events.flush();const delivered=s.deliveries.filter(p=>!p.type);
  assert.equal((await s.service.listRequests(docId,{},s.user))[0].automation.state,'delivered');
  assert.equal(delivered.length,1);assert.equal(delivered[0].name,TUTORIAL_EVENT_NAME);
  assert.equal(delivered[0].data.document_id,docId);
  await assert.rejects(s.service.startRequest(docId,request.rid,s.other,'ChatGPT',{session:'other'}),{status:403});
  await s.service.startRequest(docId,request.rid,s.admin,'ChatGPT',{session:'chatgpt'});
  await assert.rejects(s.service.startRequest(docId,request.rid,s.admin,'Claude',{session:'claude'}),{status:409});
  const actor={...s.admin,agentSession:'chatgpt',agentAttempt:1};
  await s.service.propose(docId,{ref:'s0/p0',find:'',replace:'검토 제안',rid:request.rid},actor,'ChatGPT');
  await s.service.completeRequest(docId,request.rid,{summary:'검토 완료',session:'chatgpt'},actor,'ChatGPT');
  const meta=s.store.readMeta(docId);assert.equal(meta.requests[0].status,'done');assert.equal(meta.proposals.length,1);assert.equal(meta.proposals[0].status,'pending');
  const ordinary=s.store.create({fileName:'normal.hwpx',bytes:fs.readFileSync(path.join(process.cwd(),'tests/fixtures/tool_memo_tracked.hwpx')),by:s.user.name});
  ordinary.requests=[{...meta.requests[0],rid:88,status:'pending',route:'queue',tutorial:false,at:new Date().toISOString()}];s.store.saveMeta(ordinary);
  assert.equal(s.service._tutorialChatGPTTakes(s.admin,ordinary.requests[0]),false);
  await s.events.flush();assert.equal(s.deliveries.filter(p=>!p.type).length,1);
  s.config.tutorial.shareChatGPT=[];assert.equal(s.events.hasTutorialSubscriber(),false);
  assert.equal(s.events.status(s.admin).activeSubscriptions,0);
});

test('shared tutorial queue persists without subscription; examples and tutorial 6 never reach shared ChatGPT',async t=>{
  const s=setup(t);
  const normal=s.store.create({fileName:'normal.hwpx',bytes:fs.readFileSync(path.join(process.cwd(),'tests/fixtures/tool_memo_tracked.hwpx')),by:s.admin.name});
  await s.service.createRequest(normal.id,{kind:'instruct',instruction:'일반 문서 요청',route:'queue',target:{ref:'s0/p0'}},s.admin);
  const {docId}=await s.tutorial.start(s.user,{tutorialId:'overview'});
  const out=await s.service.createRequest(docId,{kind:'instruct',instruction:'검토',target:{ref:'s0/p0'}},s.user);assert.equal(out.route,'queue');
  assert.equal(s.service._tutorialChatGPTTakes(s.admin,{tutorial:true,example:true}),false);
  assert.equal(s.service._tutorialChatGPTTakes(s.admin,{tutorial:true,ownAi:true}),false);
  await s.events.subscribe({user:s.admin},s.params);
  // Older queued requests are handled manually once; subscription delivers only new occurrences.
  const claimed=await s.service.claimNextRequest(s.admin,'ChatGPT','session',undefined,{tutorialOnly:true});assert.equal(claimed.claimed,true);
  assert.equal(s.store.readMeta(docId).requests[0].status,'working');
  assert.equal(s.store.readMeta(normal.id).requests[0].status,'pending');
  assert.deepEqual(await s.service.claimNextRequest(s.admin,'ChatGPT','session',undefined,{tutorialOnly:true}),{none:true});
  assert.equal(s.service.tutorialAiStatus(s.user.name).method,'mcp-events');
});

test('HTTP MCP administrator can discover tutorial event and process another user tutorial through real tools',async t=>{
  const srv=await startServer({config:{publicUrl:'https://cowork.example',tutorial:{shareChatGPT:['관리자'],restrictUsers:false,examples:false}}});t.after(()=>srv.stop());
  const rpc=async(method,params={},token=srv.tokens.admin)=>{
    const r=await fetch(srv.base+'/mcp',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','MCP-Protocol-Version':'2026-07-28','Mcp-Method':method,...(method==='tools/call'?{'Mcp-Name':params.name}:{})},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params:{...params,_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientInfo':{name:'chatgpt',version:'test'},'io.modelcontextprotocol/clientCapabilities':{}}}})});
    return r.json();
  };
  assert.ok((await rpc('events/list')).result.events.some(e=>e.name===TUTORIAL_EVENT_NAME));
  assert.ok(!(await rpc('events/list',{},srv.tokens.a)).result.events.some(e=>e.name===TUTORIAL_EVENT_NAME));
  const api=srv.api('a');const {docId}=await api('/api/tutorial/start',{method:'POST',body:{tutorialId:'overview'}});
  const out=await api(`/api/docs/${docId}/requests`,{method:'POST',body:{kind:'instruct',instruction:'표현 검토',target:{ref:'s0/p0'}}});
  assert.match(out.hint,/ChatGPT/);
  const target={doc_id:docId,request_id:out.request.rid};
  const tool=async(name,args)=>{const result=(await rpc('tools/call',{name,arguments:args})).result;assert.ok(!result.isError,JSON.stringify(result));return result;};
  await tool('get_request',target);await tool('start_request',target);
  await tool('propose_changes',{...target,expected_attempt:1,proposals:[{ref:'s0/p0',find:'',replace:'연결 점검 제안'}]});
  await tool('complete_request',{...target,summary:'튜토리얼 연결 점검 완료'});
  const requests=await api(`/api/docs/${docId}/requests`);assert.equal(requests[0].status,'done');
  assert.equal((await api(`/api/docs/${docId}/proposals`)).length,1);
});

test('tutorial Codex channel takes priority over Work events and excludes ordinary requests',async t=>{
  const s=setup(t);s.config.tutorial.shareAgent='hwpx-tutorial-codex-worker';s.config.tutorial.shareFrom=[s.admin.name];
  s.service.agents={sessions:()=>[{channel:true,session:'codex',agent:'관리자 Codex',client:'hwpx-tutorial-codex-worker'}],sendSession:()=>true};
  await s.events.subscribe({user:s.admin},s.params);
  const {docId}=await s.tutorial.start(s.user,{tutorialId:'overview'});
  const r=await s.service.createRequest(docId,{kind:'instruct',instruction:'표현 검토',target:{ref:'s0/p0'}},s.user);
  assert.equal(r.route,'agent');assert.equal(r.request.delivery.agent,'관리자 Codex');
  assert.equal(s.service.tutorialAiStatus(s.user.name).method,'codex-worker');
  assert.equal(s.service._tutorialAgent(s.user.name,{tutorial:true,tutorialSession:false}),null);
  await s.events.flush();assert.equal(s.deliveries.filter(p=>!p.type).length,0);
});
