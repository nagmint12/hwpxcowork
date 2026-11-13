import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Service } from '../server/service.js';
import { Store } from '../server/store.js';
import { HwpxDoc } from '../engine/doc.js';
import { fixture } from './helpers/server.mjs';

const user={name:'FIFO test',role:'admin'};
async function setup(t,settings={editMode:'realtime',track:'final'}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hwpx-fifo-'));
  t.after(()=>{const resolved=fs.realpathSync(dir);assert.equal(path.dirname(resolved).toLowerCase(),fs.realpathSync(os.tmpdir()).toLowerCase());assert.ok(path.basename(resolved).startsWith('hwpx-fifo-'));fs.rmSync(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:50});});
  const doc=await(await HwpxDoc.load(fs.readFileSync(fixture('tool_memo_tracked.hwpx')))).flattened();
  doc.mergeParagraphText('s0/p2','반복 반복 반복 끝',{author:'fixture'});doc.acceptAll();
  const store=new Store(dir);const service=new Service({store,config:{root:dir,dataDir:dir,tutorial:{enabled:false}},hub:{broadcast(){},broadcastAll(){}},ai:{enabled:false}});
  const id=store.create({fileName:'fifo.hwpx',bytes:Buffer.from(await doc.save()),by:user.name,extra:{settings}}).id;
  const request=(await service.createRequest(id,{kind:'instruct',target:{scope:'document'},instruction:'순서 검증',route:'queue'},user)).request;
  const calls=[];const original=service._applyCore;
  service._applyCore=function(ctx,p,...args){calls.push(p.pid);return original.call(this,ctx,p,...args);};
  return{store,service,id,request,calls,propose:body=>service.propose(id,{rid:request.rid,...body},user),apply:()=>service.resolveRequest(id,request.rid,{apply:'rest'},user)};
}

test('모두 반영은 실제 등록 순서대로 적용하고 반복된 원문이 새로 생겨도 처음 선택한 대상을 유지한다',async t=>{
  for(const settings of [{editMode:'realtime',track:'final'},{editMode:'approval',track:'changes'}]){
    const s=await setup(t,settings);const props=[];
    props.push(await s.propose({ref:'s0/p2',find:'반복',replace:'반복 반복',occurrence:1}));
    props.push(await s.propose({ref:'s0/p2',find:'반복',replace:'둘째',occurrence:2}));
    props.push(await s.propose({ref:'s0/p2',find:'반복',replace:'셋째',occurrence:3}));
    const out=await s.apply();assert.equal(out.counts.failed,0);assert.equal(out.counts.applied,3);
    assert.deepEqual(s.calls,props.map(p=>p.pid));assert.deepEqual(out.results.map(r=>r.pid),s.calls);
    assert.equal((await s.store.doc(s.id)).text('s0/p2','final'),'반복 반복 둘째 셋째 끝');
  }
});

test('같은 자리 문단·표 추가를 등록 순서로 쌓고, 중간에 밀린 원래 문단도 수정한다',async t=>{
  const s=await setup(t);const props=[];
  props.push(await s.propose({afterRef:'s0/p0',text:'첫 추가'}));
  props.push(await s.propose({afterRef:'s0/p0',text:'둘째 추가\n둘째 계속'}));
  props.push(await s.propose({ref:'s0/p2',find:'끝',replace:'완료'}));
  props.push(await s.propose({type:'table',afterRef:'s0/p0',table:{rows:[['머리','값'],['가','1']],caption:'FIFO 표'}}));
  props.push(await s.propose({afterRef:'s0/p0',text:'마지막 추가'}));
  const out=await s.apply();assert.equal(out.counts.failed,0,JSON.stringify(out.results));
  assert.deepEqual(s.calls,props.map(p=>p.pid));
  const d=await s.store.doc(s.id);const ps=d.paragraphs({view:'final',nested:true});const texts=ps.map(p=>p.text);
  const indices=['첫 추가','둘째 추가','둘째 계속','FIFO 표','마지막 추가'].map(v=>texts.findIndex(text=>text.includes(v)));
  assert.ok(indices.every((v,i)=>v>=0&&(i===0||v>indices[i-1])),JSON.stringify(texts));
  assert.ok(texts.includes('반복 반복 반복 완료'));
});

test('앞선 수정과 겹친 대상은 다른 동일 문구로 옮겨 적용하지 않고 실패로 남긴다',async t=>{
  const s=await setup(t);
  const first=await s.propose({ref:'s0/p2',find:'반복',replace:'바뀜'});
  const second=await s.propose({ref:'s0/p2',find:'반복 반복',replace:'합침'});
  const out=await s.apply();assert.equal(out.counts.applied,1);assert.equal(out.counts.failed,1);
  assert.deepEqual(s.calls,[first.pid]);assert.equal(out.results.find(r=>r.pid===second.pid).code,'STALE');
  assert.equal((await s.store.doc(s.id)).text('s0/p2','final'),'바뀜 반복 반복 끝');
  const retry=await s.apply();assert.equal(retry.counts.applied,0);assert.equal(retry.counts.failed,1);
  assert.equal((await s.store.doc(s.id)).text('s0/p2','final'),'바뀜 반복 반복 끝');
  await s.service.undoProposal(s.id,first.pid,user);
  const restored=await s.apply();assert.equal(restored.counts.failed,0);assert.equal(restored.counts.applied,1);
});

test('첫 수정이 문단을 나누면 뒤 원문의 수정 대상도 새 문단으로 옮겨 FIFO 적용한다',async t=>{
  const s=await setup(t);
  const a=await s.propose({ref:'s0/p2',find:'반복',replace:'첫줄\n둘째줄'});
  const b=await s.propose({ref:'s0/p2',find:'반복',occurrence:2,replace:'원래둘째'});
  const out=await s.apply();assert.equal(out.counts.failed,0,JSON.stringify(out.results));assert.deepEqual(s.calls,[a.pid,b.pid]);
  const texts=(await s.store.doc(s.id)).paragraphs({view:'final'}).map(p=>p.text);
  assert.ok(texts.includes('첫줄'));assert.ok(texts.includes('둘째줄 원래둘째 반복 끝'));
});

test('명시적으로 거꾸로 전달한 제안 목록도 등록 순으로 처리한다',async t=>{
  const s=await setup(t);const a=await s.propose({ref:'s0/p2',find:'끝',replace:'완료'});const b=await s.propose({afterRef:'s0/p0',text:'추가'});
  const out=await s.service.resolveRequest(s.id,s.request.rid,{apply:[b.pid,a.pid]},user);
  assert.equal(out.counts.failed,0);assert.deepEqual(s.calls,[a.pid,b.pid]);assert.deepEqual(out.results.map(r=>r.pid),[a.pid,b.pid]);
});

test('지워진 대상의 기존 GONE 오류를 유지하면서 다음 등록 제안은 처리한다',async t=>{
  const s=await setup(t);const a=await s.propose({ref:'s0/p2',find:'반복',replace:'앞'});const b=await s.propose({afterRef:'s0/p0',text:'독립 추가'});
  const meta=s.store.readMeta(s.id);meta.proposals.find(p=>p.pid===a.pid).lost=true;s.store.saveMeta(meta);
  const out=await s.apply();assert.equal(out.results.find(r=>r.pid===a.pid).code,'GONE');assert.equal(out.counts.applied,1);assert.equal(out.counts.failed,1);
  assert.deepEqual(s.calls,[a.pid,b.pid]);
});
