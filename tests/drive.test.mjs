import {DOORAY_PROJECT,discover,discoverHttp} from './helpers/drive.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import JSZip from 'jszip';
import {DriveService,validateTarget} from '../server/drive.js';
import {doorayAction} from '../extensions/drive-bridge/dooray.js';
import {serverUrl} from '../extensions/drive-bridge/shared.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {startServer,uploadDoc,fixture} from './helpers/server.mjs';

const target={provider:'dooray',projectId:DOORAY_PROJECT,folderId:'root'};
const a={name:'가'},b={name:'나'};
function setup(t,opts={}){const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'cowork-drive-'));t.after(()=>fs.rmSync(dataDir,{recursive:true,force:true}));let now=1000000;const drive=new DriveService({config:{dataDir,attachments:{maxBytes:1024}},now:()=>now,...opts});return {drive,tick:ms=>now+=ms,dataDir};}
function paired(drive,user=a){const p=drive.pair(drive.pairCode(user).code);drive.bridge(p.token,'0.6.0');discover(drive,user);return p.token;}
function completeList(drive,user=a,items=[]){const j=drive.create(user,{...target,action:'list'});const {job}=drive.claim(user);drive.finish(user,j.id,job.claim,{result:{items,folderName:'개인 프로젝트'}});}

test('개인 프로젝트 차단·잘못된 파일/서버 경로 거절',()=>{
 for(const projectId of ['other','../test'])assert.throws(()=>validateTarget({...target,projectId}),e=>e.code==='DRIVE_SCOPE'||e.code==='DRIVE_TARGET');
 assert.throws(()=>validateTarget({...target,folderId:'../../x'}));
 for(const url of ['http://example.com','https://user:pass@server.test/','https://server.test/path','https://server.test/?x=1'])assert.throws(()=>serverUrl(url));
 assert.equal(serverUrl('http://localhost:8787'),'http://localhost:8787');assert.equal(serverUrl('https://server.test'),'https://server.test');
});
test('단일 사용 연결 코드·사용자 분리·재연결/해제·만료',t=>{
 const {drive,tick}=setup(t);const code=drive.pairCode(a).code;const token=drive.pair(code).token;assert.throws(()=>drive.pair(code));assert.equal(drive.bridge(token).name,a.name);
 assert.equal(drive.status(b).connected,false);const newToken=paired(drive);assert.throws(()=>drive.bridge(token));assert.equal(drive.status(a).connected,true);drive.disconnect(a);assert.throws(()=>drive.bridge(newToken));
 const exp=drive.pairCode(a).code;tick(300001);assert.throws(()=>drive.pair(exp));
});
test('서버를 다시 켜도 브라우저 연결 유지(토큰 해시만 저장)·해제·지운 사용자는 되살리지 않음',t=>{
 const {drive,dataDir}=setup(t);const token=paired(drive);
 const saved=fs.readFileSync(path.join(dataDir,'drive',drive.owner(a),'index.json'),'utf8');assert.ok(!saved.includes(token),'확장 토큰 원문은 저장하지 않는다');
 const users=[{name:'가',role:'editor',token:'x'},{name:'나',role:'admin',token:'y'}];
 const restarted=new DriveService({config:{dataDir,users}});assert.equal(restarted.bridge(token).name,'가');assert.equal(restarted.status(a).bridge.paired,true);
 users[0].role='viewer';assert.equal(restarted.bridge(token).role,'viewer','역할은 지금 설정을 따른다');
 restarted.disconnect(a);assert.throws(()=>new DriveService({config:{dataDir,users}}).bridge(token));
 const t2=paired(restarted);users.splice(0,1);const again=new DriveService({config:{dataDir,users}});assert.throws(()=>again.bridge(t2),e=>e.code==='DRIVE_BRIDGE_AUTH');
});
test('작업 선점은 한 번·재실행 금지·종료 후 바이트 거절·타임아웃',t=>{
 const {drive,tick}=setup(t);paired(drive);const pending=drive.create(a,{...target,action:'download',fileId:'123'});const {job}=drive.claim(a);assert.equal(drive.claim(a).job,null);assert.throws(()=>drive.job(b,pending.id));
 assert.throws(()=>drive.finish(a,job.id,'wrong',{result:{}}));assert.throws(()=>drive.finish(a,job.id,job.claim,{result:{}}),e=>e.code==='DRIVE_BYTES');
 const file=drive.receive(a,job.id,job.claim,Buffer.from('test'),'검증.txt','text/plain');assert.equal(drive.bytes(a,file.id).bytes.toString(),'test');assert.throws(()=>drive.bytes(b,file.id));assert.throws(()=>drive.receive(a,job.id,job.claim,Buffer.from('x'),'x'));
 drive.finish(a,job.id,job.claim,{result:{}});assert.equal(drive.job(a,job.id).status,'done');assert.equal(drive.claim(a).job,null);assert.throws(()=>drive.finish(a,job.id,job.claim,{result:{}}));
 const second=drive.create(a,{...target,action:'list'});drive.claim(a);tick(180001);assert.equal(drive.job(a,second.id).status,'failed');assert.equal(drive.claim(a).job,null);
});
test('파일명·크기·쿼터·전송 중 삭제 방지·개인 보관 영속성',t=>{
 const {drive,dataDir}=setup(t);paired(drive);for(const name of ['../secret','a/b','a\\b','x\n',''])assert.throws(()=>drive.stage(a,Buffer.from('x'),name));assert.throws(()=>drive.stage(a,Buffer.alloc(1025),'x'),e=>e.code==='DRIVE_SIZE');
 const f=drive.stage(a,Buffer.from('{"n":1}'),'자료.json','application/json');assert.equal(drive.bytes(a,f.id).bytes.toString(),'{"n":1}');const restored=new DriveService({config:{dataDir}});assert.equal(restored.status(a).files[0].id,f.id);
 const j=drive.create(a,{...target,action:'upload',stagedId:f.id});assert.throws(()=>drive.deleteFile(a,f.id),e=>e.code==='DRIVE_BUSY');const {job}=drive.claim(a);drive.finish(a,j.id,job.claim,{error:'test'});drive.deleteFile(a,f.id);assert.equal(drive.status(a).files.length,0);
});
test('(AI 기능을 켰을 때) AI는 허용한 현재 폴더만 읽고 제안만 가능·폴더 변경 뒤 실행 차단',t=>{
 const {drive}=setup(t,{aiEnabled:true});paired(drive);const f=drive.stage(a,Buffer.from('x'),'새 파일.txt');completeList(drive,a,[{id:'123',name:'원본.txt',revision:'1'}]);
 assert.equal(drive.aiContext(a).context,null);assert.throws(()=>drive.propose(a,{stagedId:f.id}));drive.allowAi(a,true);assert.equal(drive.aiContext(a).context.items.length,1);
 assert.throws(()=>drive.propose(a,{stagedId:f.id,replaceId:'different'}));const p=drive.propose(a,{stagedId:f.id,name:'원본.txt',replaceId:'123',reason:'수정 결과'});assert.equal(drive.claim(a).job,null);
 const changed=drive.create(a,{...target,folderId:'456',action:'list'});const {job}=drive.claim(a);drive.finish(a,changed.id,job.claim,{result:{items:[]}});assert.equal(drive.aiContext(a).context,null);assert.throws(()=>drive.resolveProposal(a,p.id,true));
 completeList(drive,a,[{id:'123',name:'원본.txt',revision:'1'}]);drive.allowAi(a,true);const out=drive.resolveProposal(a,p.id,true);assert.equal(out.job.status,'pending');assert.equal(drive.claim(a).job.replaceId,'123');assert.throws(()=>drive.resolveProposal(a,p.id,true));
});
test('두레이 어댑터: 외부 프로젝트/잘못된 부모/교체 revision 차단',async()=>{
 const calls=[];const base={target:{...target,folderId:'555'},action:'downloadStart',fileId:'123',expectedRevision:'1',maxBytes:100};
 const makeContext=(overrides={})=>vm.createContext({location:{origin:'https://team.gov-dooray.com',pathname:'/drive/'+DOORAY_PROJECT},fetch:async route=>{calls.push(route);const content=route==='/v2/wapi/drives/'+DOORAY_PROJECT?{id:'999',projectId:DOORAY_PROJECT,type:'private'}:route.endsWith('/555')?{id:'555',driveId:'999',projectId:DOORAY_PROJECT,type:'folder'}:{id:'123',driveId:'999',projectId:DOORAY_PROJECT,type:'file',revision:'2',parentFile:{id:'555'}};return {ok:true,text:async()=>JSON.stringify({result:{content}})};},AbortSignal,URLSearchParams,Map,Date,...overrides});
 const run=(arg,ctx)=>vm.runInContext('('+doorayAction.toString()+')('+JSON.stringify(arg)+')',ctx);
 await assert.rejects(run({...base,target:{...base.target,projectId:'other'}},makeContext()),/개인 프로젝트/);assert.equal(calls.length,0);
 await assert.rejects(run(base,makeContext()),/다른 곳에서 변경/);assert.ok(!calls.some(x=>x.includes('/downloads/')));
 await assert.rejects(run({...base,target:{...target,folderId:'666'}},makeContext()),/폴더가 아닙니다/);
 await assert.rejects(run(base,makeContext({location:{origin:'https://team.gov-dooray.com',pathname:'/drive/other'}})),/로그인/);
});
test('HTTP: 연결/바이너리 왕복/계정 격리/HWPX 공동 편집·첨부/확장 ZIP',async t=>{
 const srv=await startServer();t.after(()=>srv.stop());const A=srv.api('a'),B=srv.api('b');
 const code=(await A('/api/drive/pair',{method:'POST'})).code;const paired=await (await fetch(srv.base+'/api/drive/bridge/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code})})).json();
 const bridge=(route,options={})=>fetch(srv.base+'/api/drive/bridge'+route,{...options,headers:{Authorization:'Bearer '+paired.token,'x-cowork-drive-version':'0.6.0',...options.headers}});
 assert.equal((await A('/api/drive')).connected,false); // 코드 등록만으로 실행 창이 작동한다고 표시하지 않는다.
 await bridge('/jobs');await discoverHttp(A,bridge);assert.equal((await A('/api/drive')).connected,true);assert.equal((await B('/api/drive')).connected,false);
 assert.equal((await A.res('/api/drive/jobs',{method:'POST',body:{...target,projectId:'other',action:'list'}})).status,403);
 const original=Buffer.from('{"종류":"시험"}');const staged=await A('/api/drive/files',{method:'POST',raw:true,body:original,headers:{'x-file-name':encodeURIComponent('원본.json'),'x-file-mime':'application/json','Content-Type':'application/json'}});
 assert.deepEqual(Buffer.from(await A('/api/drive/files/'+staged.id)),original);assert.equal((await B.res('/api/drive/files/'+staged.id)).status,404);
 const j=await A('/api/drive/jobs',{method:'POST',body:{...target,action:'download',fileId:'123'}});const {job}=await (await bridge('/jobs')).json();assert.equal(job.id,j.id);
 const upload=await bridge('/jobs/'+job.id+'/file',{method:'POST',headers:{'x-drive-claim':job.claim,'Content-Type':'application/json','x-file-name':'result.json'},body:original});assert.equal(upload.status,200);
 assert.equal((await bridge('/jobs/'+job.id+'/result',{method:'POST',headers:{'x-drive-claim':job.claim,'Content-Type':'application/json'},body:JSON.stringify({result:{}})})).status,200);
 const f=await A('/api/drive/files',{method:'POST',raw:true,body:fs.readFileSync(fixture('tool_memo_tracked.hwpx')),headers:{'x-file-name':encodeURIComponent('공동.hwpx')}});
 const doc=await A('/api/drive/files/'+f.id+'/open',{method:'POST'});assert.ok(doc.id);assert.equal(doc.space,'private');assert.equal((await B.res('/api/docs/'+doc.id)).status,404);
 const attachment=await A('/api/drive/files/'+staged.id+'/attach',{method:'POST',body:{docId:doc.id}});assert.equal(attachment.name,'원본.json');
 const client=new Client({name:'drive-test',version:'1'});await client.connect(new StreamableHTTPClientTransport(new URL(srv.base+'/mcp'),{requestInit:{headers:{Authorization:'Bearer '+srv.tokens.a}}}));
 try {
   // AI 드라이브 기능은 꺼져 있다(DRIVE_AI_ENABLED=false): MCP 에 드라이브 도구가 없다
   const names=(await client.listTools()).tools.map(t=>t.name);for(const n of ['get_drive_context','prepare_drive_file','propose_drive_upload'])assert.ok(!names.includes(n),n);
 }finally{await client.close();}
 const zip=await JSZip.loadAsync(await A('/api/drive/extension.zip'));assert.ok(zip.file('manifest.json'));assert.ok(zip.file('dooray.js'));assert.ok(zip.file('runner.js'));assert.ok(zip.file('worker.js'));assert.equal(zip.file('google.js'),null);assert.equal(Object.keys(zip.files).length,12);
 await A('/api/drive/connection',{method:'DELETE'});assert.equal((await bridge('/jobs')).status,401);
});

