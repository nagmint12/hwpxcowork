import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import {startServer} from './helpers/server.mjs';
import {runDooray} from '../extensions/drive-bridge/runner.js';
import {createBridgeWorker} from '../extensions/drive-bridge/worker.js';

test('백그라운드 WebSocket: URL에 토큰 없이 개인 작업 도착·핑·연결 해제',async t=>{
 const srv=await startServer();t.after(()=>srv.stop());const A=srv.api('a');
 const code=(await A('/api/drive/pair',{method:'POST'})).code;
 const pair=await(await fetch(srv.base+'/api/drive/bridge/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code})})).json();
 const url=srv.base.replace('http:','ws:')+'/api/drive/bridge/events';
 const ws=new WebSocket(url,['cowork-drive-v1',pair.token,'v-0.6.0']);t.after(()=>ws.terminate());
 const messages=[];ws.on('message',raw=>messages.push(JSON.parse(String(raw))));await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j);});
 await new Promise(r=>setTimeout(r,10));assert.ok(messages.some(m=>m.type==='ready'));assert.ok(!ws.url.includes(pair.token));
 assert.equal((await A('/api/drive')).bridge.version,'0.6.0');
 await A('/api/drive/jobs',{method:'POST',body:{provider:'dooray',projectId:'personal',folderId:'root',action:'projects'}});
 for(let i=0;i<30&&!messages.some(m=>m.type==='work');i++)await new Promise(r=>setTimeout(r,10));assert.ok(messages.some(m=>m.type==='work'));
 ws.send(JSON.stringify({type:'ping'}));for(let i=0;i<30&&!messages.some(m=>m.type==='pong');i++)await new Promise(r=>setTimeout(r,10));assert.ok(messages.some(m=>m.type==='pong'));
 const closed=new Promise(r=>ws.once('close',(code)=>r(code)));await A('/api/drive/connection',{method:'DELETE'});assert.equal(await closed,4001);
});
test('자동 작업 탭은 뒤에서 열고 작업 뒤 닫으며 사용자가 연 탭은 유지',async()=>{
 let created=0,removed=0;const project='3641283642401141655';
 const api={storage:{local:{get:async()=>({doorayOrigin:'https://team.gov-dooray.com'})}},permissions:{contains:async()=>true},tabs:{query:async()=>[],create:async opts=>{assert.equal(opts.active,false);created++;return {id:7};},get:async()=>({id:7,url:'https://team.gov-dooray.com/drive/'+project,status:'complete',active:false}),remove:async id=>{assert.equal(id,7);removed++;}},scripting:{executeScript:async()=>[{result:{ok:true,value:{items:[]}}}]}};
 await runDooray({action:'list',target:{projectId:project,folderId:'root'}},null,api);assert.equal(created,1);assert.equal(removed,1);
 api.tabs.query=async()=>[{id:8,url:'https://team.gov-dooray.com/drive/'+project}];await runDooray({action:'list',target:{projectId:project,folderId:'root'}},null,api);assert.equal(created,1);assert.equal(removed,1);
 api.tabs.query=async()=>[];api.tabs.get=async()=>({url:'https://team.gov-dooray.com/login',status:'complete',active:false});
 await assert.rejects(runDooray({action:'list',target:{projectId:project,folderId:'root'}},null,api),/로그인/);assert.equal(removed,2);
});
test('실행 화면 없이 서비스 워커가 서버 작업을 선점하고 한 번만 처리',async()=>{
 const storage={doorayOrigin:'https://team.gov-dooray.com',connection:{server:'http://127.0.0.1:8787',token:'a'.repeat(64)}};let opened=0,posts=0,alarm=null;
 const api={permissions:{contains:async()=>true},storage:{local:{get:async()=>({...storage}),set:async obj=>Object.assign(storage,obj),remove:async k=>{delete storage[k];}}},runtime:{getManifest:()=>({version:'0.3.0'})},alarms:{get:async()=>alarm,create:async(n,a)=>{alarm=a;},clear:async()=>{alarm=null;}},tabs:{create:async()=>{opened++;return {id:1};}},action:{setBadgeText:async()=>{}}};
 class Socket{constructor(url,protocols){this.url=url;assert.ok(!url.includes('aaaa'));assert.equal(protocols[0],'cowork-drive-v1');}close(){}}
 let delivered=false;const worker=createBridgeWorker({api,Socket,json:async(c,route)=>{if(route.endsWith('/result')){posts++;return {status:'done'};}if(delivered)return {job:null};delivered=true;return {job:{id:'job',claim:'claim',target:{provider:'dooray',projectId:'3641283642401141655'},action:'login'}};}});
 await worker.ensure(true);for(let i=0;i<30&&!posts;i++)await new Promise(r=>setTimeout(r,10));await worker.drain();assert.equal(opened,1);assert.equal(posts,1);assert.equal(storage.driveStatus.connected,true);assert.equal(alarm.periodInMinutes,0.5);await worker.stop(false);
});
