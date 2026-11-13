import {DOORAY_PROJECT,discover,discoverHttp} from './helpers/drive.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {serverUrl} from '../extensions/drive-bridge/shared.js';
import {runDooray,personalTab} from '../extensions/drive-bridge/runner.js';
import {doorayAction} from '../extensions/drive-bridge/dooray.js';
import {driveImportTargets,defaultDriveImportTarget,driveDocumentChoices} from '../web/drive-library.js';
import {startServer,fixture} from './helpers/server.mjs';

const target={provider:'dooray',projectId:DOORAY_PROJECT,folderId:'root'};
test('Brave: 선택한 사내망 주소만 HTTP 허용',()=>{
 for(const addr of ['http://192.168.1.9:8787','http://10.1.2.3:8787','http://192.168.0.10:8787','http://[::1]:8787'])assert.equal(serverUrl(addr),addr);
 for(const addr of ['http://172.32.1.9:8787','http://192.169.1.9','http://example.com','https://u:p@example.com','https://server.test/path'])assert.throws(()=>serverUrl(addr));
});
test('Brave: 주입 함수가 실패하면 오류 이유를 결과로 보존',async()=>{
 const ctx=vm.createContext({location:{origin:'https://team.gov-dooray.com',pathname:'/drive/other'}});
 const result=await vm.runInContext('('+doorayAction.toString()+')('+JSON.stringify({target,action:'list',transport:true})+')',ctx);
 assert.equal(result.ok,false);assert.match(result.error,/로그인/);
 const calls=[];const api={storage:{local:{get:async()=>({doorayOrigin:'https://team.gov-dooray.com'})}},permissions:{contains:async()=>true},tabs:{query:async()=>[{id:1,url:'https://team.gov-dooray.com/drive/'+DOORAY_PROJECT}]},scripting:{executeScript:async args=>{calls.push(args);return [{result:{ok:false,error:'두레이 로그인 또는 파일 권한을 확인하세요.'}}];}}};
 await assert.rejects(runDooray({target,action:'list'},null,api),/두레이 로그인 또는 파일 권한/);assert.equal(calls[0].args[0].transport,true);
 api.scripting.executeScript=async()=>[{result:{ok:true,value:{items:[]}}}];assert.deepEqual(await runDooray({target,action:'list'},null,api),{items:[]});
 const count=calls.length;await assert.rejects(runDooray({target:{...target,projectId:'other'},action:'list'},null,api),/개인 프로젝트 밖/);assert.equal(calls.length,count);
 api.permissions.contains=async()=>false;await assert.rejects(personalTab(api),/접근을 허용/);
});
test('두레이 로그인 열기는 연결된 브라우저의 개인 프로젝트 주소만 사용',async()=>{
 const tabs=[];const api={storage:{local:{get:async()=>({doorayOrigin:'https://team.gov-dooray.com'})}},permissions:{contains:async()=>true},tabs:{create:async options=>{tabs.push(options);return {id:1};}}};
 assert.deepEqual(await runDooray({target,action:'login'},null,api),{opened:true});assert.deepEqual(tabs,[{url:'https://team.gov-dooray.com/drive/',active:true}]);
 await assert.rejects(runDooray({target:{...target,projectId:'other'},action:'login'},null,api),/개인 프로젝트 밖/);assert.equal(tabs.length,1);
});
test('문서함 연결 화면: 작성 가능한 폴더만 제시하고 기본은 내 개인 문서함',()=>{
 const me={name:'가',role:'editor'},lib={publicRoot:{perms:['read','write']},folders:[{id:'fpublic1',name:'공유',space:'public',owner:null,parentId:null,perms:['read','write']},{id:'fprivate1',name:'초안',space:'private',owner:'가',parentId:null,perms:['read','write']},{id:'freadonly1',name:'읽기',space:'public',owner:null,parentId:null,perms:['read']}],docs:[{id:'d1',title:'기준 문서',space:'private',spaceOwner:'가',folderId:'fprivate1'}]};
 const targets=driveImportTargets(lib,me);assert.ok(!targets.some(t=>t.location.folderId==='freadonly1'));
 assert.match(targets.find(t=>t.location.folderId==='fprivate1').label,/개인 문서함 › 초안/);
 assert.equal(defaultDriveImportTarget(targets,me).location.space,'private');assert.equal(defaultDriveImportTarget(targets,me,{space:'public',folderId:'fpublic1'}).location.folderId,'fpublic1');
 assert.equal(defaultDriveImportTarget(targets,me,{space:'public',folderId:'freadonly1'}).location.space,'private');assert.equal(defaultDriveImportTarget([],me),null);
 assert.equal(driveDocumentChoices(lib,me)[0].label,'개인 문서함 › 초안 › 기준 문서');
});
test('드라이브 ↔ 문서함: 비공개 기본값·선택 폴더·권한 재검사·전송 준비 접근 제어',async t=>{
 const srv=await startServer();t.after(()=>srv.stop());const A=srv.api('a'),B=srv.api('b'),Admin=srv.api('admin');
 const file=await A('/api/drive/files',{method:'POST',raw:true,body:fs.readFileSync(fixture('tool_memo_tracked.hwpx')),headers:{'x-file-name':encodeURIComponent('가져온 문서.hwpx')}});
 const own=await A('/api/drive/files/'+file.id+'/open',{method:'POST'});assert.equal(own.space,'private');assert.equal(own.spaceOwner,srv.users.a.name);assert.equal((await B.res('/api/docs/'+own.id)).status,404);
 const privateFolder=await A('/api/folders',{method:'POST',body:{name:'개인 초안',space:'private'}});
 const privateDoc=await A('/api/drive/files/'+file.id+'/open',{method:'POST',body:{location:{folderId:privateFolder.id}}});assert.equal(privateDoc.folderId,privateFolder.id);assert.equal(privateDoc.space,'private');assert.equal((await B.res('/api/docs/'+privateDoc.id)).status,404);
 const publicFolder=await Admin('/api/folders',{method:'POST',body:{name:'검토 자료',space:'public'}});
 const publicDoc=await A('/api/drive/files/'+file.id+'/open',{method:'POST',body:{location:{folderId:publicFolder.id}}});assert.equal(publicDoc.space,'public');assert.equal((await B('/api/docs/'+publicDoc.id)).folderId,publicFolder.id);
 await Admin('/api/folders/'+publicFolder.id+'/access',{method:'PUT',body:{inherit:false,acl:[{name:srv.users.a.name,perms:['read']}]}});
 const before=(await A('/api/docs')).length;
 assert.equal((await A.res('/api/drive/files/'+file.id+'/open',{method:'POST',body:{location:{folderId:publicFolder.id}}})).status,403);assert.equal((await A('/api/docs')).length,before);
 assert.equal((await A.res('/api/drive/files/'+file.id+'/open',{method:'POST',body:{location:{space:'private',owner:srv.users.b.name}}})).status,403);
 assert.equal((await A.res('/api/drive/files/'+file.id+'/open',{method:'POST',body:{location:{folderId:'fdoesnotexist'}}})).status,404);
 const prepared=await A('/api/drive/documents/'+privateDoc.id+'/stage',{method:'POST'});assert.equal(prepared.source.docId,privateDoc.id);assert.equal(prepared.source.location.folderId,privateFolder.id);assert.equal(prepared.source.location.space,'private');
 assert.equal((await B.res('/api/drive/documents/'+privateDoc.id+'/stage',{method:'POST'})).status,404);assert.equal((await B.res('/api/drive/files/'+prepared.id)).status,404);
 assert.equal((await B.res('/api/drive/files/'+file.id+'/open',{method:'POST',body:{location:{space:'public'}}})).status,404);
});
