import {DOORAY_PROJECT,discover,discoverHttp} from './helpers/drive.mjs';
// 드라이브 개인정보 정책(2026-10-30): 폴더 목록은 요청한 화면에만 한 번 — 서버 디스크·작업 목록·AI 에 남지 않는다.
// AI 경로(문맥·허용·제안)는 꺼져 있고, 쓰기(업로드·삭제·이름 바꾸기)는 개인 프로젝트에서만, 삭제·이름 바꾸기는 확장 0.4.0 이상.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {DriveService,DRIVE_AI_ENABLED} from '../server/drive.js';
import {doorayAction} from '../extensions/drive-bridge/dooray.js';
import {runDooray} from '../extensions/drive-bridge/runner.js';
import {startServer} from './helpers/server.mjs';

const target={provider:'dooray',projectId:DOORAY_PROJECT,folderId:'root'};
const a={name:'가'};
function setup(t){const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'cowork-drive-priv-'));t.after(()=>fs.rmSync(dataDir,{recursive:true,force:true}));const drive=new DriveService({config:{dataDir}});return {drive,dataDir};}
function paired(drive,version='0.6.0'){const p=drive.pair(drive.pairCode(a).code);drive.bridge(p.token,version);if(version==='0.6.0')discover(drive,a);return p.token;}
const items=[{id:'123',name:'비밀 계획.hwpx',type:'file',size:10,revision:'7'}];

test('기본값: AI 드라이브 기능 꺼짐, 쓰기는 개인 프로젝트만',()=>{
  assert.equal(DRIVE_AI_ENABLED,false);
});
test('폴더 목록은 한 번만 건네고 디스크·작업 목록·AI 에 남지 않는다',t=>{
  const {drive,dataDir}=setup(t);paired(drive);
  const old=drive.read(a);old.context={...target,items,aiAllowed:true};drive.save(a,old);
  const j=drive.create(a,{...target,action:'list'});const {job}=drive.claim(a);
  drive.finish(a,j.id,job.claim,{result:{items,folderName:'개인 프로젝트'}});
  assert.equal(drive.status(a).jobs.find(x=>x.id===j.id).result,null,'작업 목록에는 목록을 싣지 않는다');
  assert.equal(drive.status(a).context,null);assert.equal(drive.status(a).aiEnabled,false);
  const first=drive.deliver(a,j.id);assert.equal(first.result.items[0].name,'비밀 계획.hwpx');
  const again=drive.deliver(a,j.id);assert.equal(again.result,null);assert.equal(again.delivered,true);
  const disk=fs.readdirSync(path.join(dataDir,'drive'),{recursive:true}).filter(f=>String(f).endsWith('.json')).map(f=>fs.readFileSync(path.join(dataDir,'drive',String(f)),'utf8')).join('');
  assert.ok(!disk.includes('비밀 계획'),'서버 디스크에 파일 이름이 없다(옛 context 도 지움)');
  for(const fn of [()=>drive.aiContext(a),()=>drive.allowAi(a,true),()=>drive.propose(a,{stagedId:'x'}),()=>drive.resolveProposal(a,'x',true)])assert.throws(fn,e=>e.code==='DRIVE_AI_DISABLED'&&e.status===403);
});
test('삭제·이름 바꾸기: 인자·revision·확장 버전·개인 프로젝트',t=>{
  const {drive}=setup(t);paired(drive,'0.3.1');
  assert.throws(()=>drive.create(a,{...target,action:'delete',fileId:'123',expectedRevision:'7'}),e=>e.code==='DRIVE_BRIDGE_OLD');
  paired(drive,'0.6.0');
  assert.throws(()=>drive.create(a,{...target,action:'delete',fileId:'123'}),e=>e.code==='DRIVE_REVISION');
  assert.throws(()=>drive.create(a,{...target,action:'rename',fileId:'123',expectedRevision:'7',name:'a/b'}),e=>e.code==='DRIVE_NAME');
  const del=drive.create(a,{...target,action:'delete',fileId:'123',expectedRevision:'7'});let {job}=drive.claim(a);
  assert.equal(job.action,'delete');assert.equal(job.fileId,'123');drive.finish(a,del.id,job.claim,{result:{deleted:true}});assert.deepEqual(drive.deliver(a,del.id).result,{id:'123',deleted:true});
  const ren=drive.create(a,{...target,action:'rename',fileId:'123',expectedRevision:'7',name:'새 이름.hwpx'});({job}=drive.claim(a));assert.equal(job.name,'새 이름.hwpx');
  drive.finish(a,ren.id,job.claim,{result:{id:'123',name:'새 이름.hwpx',revision:'8'}});assert.equal(drive.deliver(a,ren.id).result.name,'새 이름.hwpx');
  for(const action of ['upload','delete','rename'])assert.throws(()=>drive.create(a,{...target,projectId:'999',action,fileId:'1',expectedRevision:'1',name:'x',stagedId:'s'}),e=>e.code==='DRIVE_SCOPE');
  drive.create(a,{...target,action:'list'});
});
test('확장: 개인 프로젝트 밖 쓰기 거절, 삭제 = 휴지통으로 옮김, 이름 바꾸기 = 같은 이름 없을 때',async()=>{
  await assert.rejects(runDooray({action:'delete',target:{...target,projectId:'invalid'}},null,{}),/개인 프로젝트/);
  const calls=[];
  const ctx=vm.createContext({location:{origin:'https://team.gov-dooray.com',pathname:'/drive/'+DOORAY_PROJECT},AbortSignal,URLSearchParams,Map,Date,JSON,
    fetch:async(route,opt={})=>{calls.push([opt.method||'GET',route,opt.body||null]);
      let content=null,extra={};
      if(route==='/v2/wapi/drives/'+DOORAY_PROJECT)content={id:'999',projectId:DOORAY_PROJECT,type:'private'};
      else if(route.includes('?')&&route.includes('name='))extra={totalCount:new URLSearchParams(route.split('?')[1]).get('name')==='있는 이름'?1:0};
      else if(route.startsWith('/v2/wapi/drives/999/files/123'))content={id:'123',name:'옛 이름.txt',driveId:'999',projectId:DOORAY_PROJECT,type:'file',revision:'7',parentFile:{path:'root'}};
      return {ok:true,text:async()=>JSON.stringify({header:{isSuccessful:true},result:content?{content}:extra})};}});
  const run=arg=>vm.runInContext('('+doorayAction.toString()+')('+JSON.stringify(arg)+')',ctx);
  const del=await run({action:'delete',target,fileId:'123',expectedRevision:'7'});assert.equal(JSON.stringify(del),JSON.stringify({id:'123',deleted:true}));
  assert.deepEqual(calls.find(c=>c[0]==='POST'),['POST','/drive/v1/drives/999/files/123/move',JSON.stringify({destinationFileId:'trash'})]);
  await assert.rejects(run({action:'delete',target,fileId:'123',expectedRevision:'6'}),/다른 곳에서 변경/);
  await assert.rejects(run({action:'rename',target,fileId:'123',expectedRevision:'7',name:'있는 이름'}),/같은 이름/);
  calls.length=0;await run({action:'rename',target,fileId:'123',expectedRevision:'7',name:'새 이름.txt'});
  assert.deepEqual(calls.find(c=>c[0]==='PUT'),['PUT','/drive/v1/drives/999/files/123?media=meta',JSON.stringify({name:'새 이름.txt'})]);
  await assert.rejects(run({action:'delete',target:{...target,projectId:'1'},fileId:'123',expectedRevision:'7'}),/개인 프로젝트/);
});
test('HTTP: AI 경로 403 · 작업 결과 한 번 · MCP 에 드라이브 도구 없음',async t=>{
  const s=await startServer();t.after(()=>s.stop());const A=s.api('a');
  const st=await A('/api/drive');assert.equal(st.aiEnabled,false);assert.deepEqual(st.writeProjects,[]);
  assert.equal((await A.res('/api/drive/ai-context',{method:'POST',body:{allowed:true}})).data.error,'DRIVE_AI_DISABLED');
  assert.equal((await A.res('/api/drive/proposals/x',{method:'POST',body:{accept:true}})).status,403);
});
