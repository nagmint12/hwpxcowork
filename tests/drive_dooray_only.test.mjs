import {DOORAY_PROJECT,discover,discoverHttp} from './helpers/drive.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import JSZip from 'jszip';
import {DriveService} from '../server/drive.js';
import {createDrivePackage} from '../server/drive-package.js';
import {createBridgeWorker} from '../extensions/drive-bridge/worker.js';
import {startServer,root} from './helpers/server.mjs';

test('비활성 공급자: API·AI 문맥·이전 제안 차단, 기존 보관 파일 유지',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cowork-dooray-only-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const drive=new DriveService({config:{dataDir:dir},aiEnabled:true}),user={name:'테스트'},disabled={provider:'google',projectId:'my-drive',folderId:'root'};
  const token=drive.pair(drive.pairCode(user).code).token;drive.bridge(token);
  const file=drive.stage(user,Buffer.from('preserved copy'),'기존 사본.txt','text/plain',disabled);
  const legacy=drive.read(user);legacy.context={...disabled,aiAllowed:true,items:[]};legacy.proposals=[{id:'legacy',target:disabled,status:'pending',stagedId:file.id}];drive.save(user,legacy);
  for(const action of ['projects','list','login','download','upload'])assert.throws(()=>drive.create(user,{...disabled,action,fileId:'remote',stagedId:file.id}),e=>e.code==='DRIVE_PROVIDER_DISABLED'&&e.status===403);
  assert.deepEqual(drive.status(user).providers.map(p=>p.id),['dooray']);assert.equal(drive.status(user).context,null);assert.deepEqual(drive.status(user).proposals,[]);
  assert.equal(drive.aiContext(user).context,null);assert.throws(()=>drive.allowAi(user,true));
  assert.throws(()=>drive.propose(user,{stagedId:file.id,reason:'disabled'}),e=>e.code==='DRIVE_PROVIDER_DISABLED');
  assert.throws(()=>drive.resolveProposal(user,'legacy',true));
  assert.equal(drive.bytes(user,file.id).bytes.toString(),'preserved copy');assert.deepEqual(drive.read(user),legacy,'보관한 파일·이전 상태를 자동 삭제하지 않는다');
  drive.jobs.set('old',{id:'old',owner:drive.owner(user),action:'list',target:disabled,status:'pending',created:Date.now()});
  assert.equal(drive.claim(user).job,null);assert.deepEqual(drive.status(user).jobs,[]);
});
test('HTTP: 두레이만 게시하고 분리한 공급자의 모든 새 작업은 403',async t=>{
  const s=await startServer();t.after(()=>s.stop());const A=s.api('a');
  assert.deepEqual((await A('/api/drive')).providers.map(p=>p.id),['dooray']);
  for(const action of ['projects','list','login','download','upload']){
    const r=await A.res('/api/drive/jobs',{method:'POST',body:{provider:'google',projectId:'my-drive',folderId:'root',action}});
    assert.equal(r.status,403);assert.equal(r.data.error,'DRIVE_PROVIDER_DISABLED');
  }
});
test('배포 ZIP은 두레이만 포함하고 identity·Google 호스트 권한을 요청하지 않는다',async()=>{
  const zip=await JSZip.loadAsync(await createDrivePackage(root)),manifest=JSON.parse(await zip.file('manifest.json').async('string'));
  assert.equal(manifest.version,'0.7.0');assert.ok(!manifest.permissions.includes('identity'));
  assert.deepEqual(manifest.host_permissions,[]);assert.equal(zip.file('google.js'),null);
  for(const [name,file] of Object.entries(zip.files)){
    assert.ok(!name.includes('google'));assert.doesNotMatch(await file.async('string'),/Google|google|구글/,'활성 확장에 분리한 기능이 섞이지 않아야 한다: '+name);
  }
});
test('확장은 이전 클라이언트가 보낸 비활성 로그인·업로드 작업도 외부 접속 전에 거절',async t=>{
  const storage={connection:{server:'http://127.0.0.1:8787',token:'a'.repeat(64)}},replies=[];let network=0,opened=0;
  const api={storage:{local:{get:async()=>({...storage}),set:async o=>Object.assign(storage,o)}},runtime:{getManifest:()=>({version:'0.3.1'})},alarms:{get:async()=>({}),clear:async()=>{}},tabs:{create:async()=>{opened++;}},action:{setBadgeText:async()=>{}}};
  class Socket{close(){}}
  const queue=['login','upload'].map((action,i)=>({id:String(i),claim:'claim',target:{provider:'google',projectId:'my-drive'},action}));
  const worker=createBridgeWorker({api,Socket,request:async()=>{network++;throw Error('unexpected bytes');},json:async(c,route,opts)=>{if(route.endsWith('/result')){replies.push(JSON.parse(opts.body));return {};}return {job:queue.shift()||null};}});t.after(()=>worker.stop(false));
  await worker.ensure(true);for(let i=0;i<50&&replies.length<2;i++)await new Promise(r=>setTimeout(r,10));await worker.drain();
  assert.equal(replies.length,2);assert.ok(replies.every(r=>r.error.includes('지원하지 않는')));assert.equal(opened,0);assert.equal(network,0);
});
