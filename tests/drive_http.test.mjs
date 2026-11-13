import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {serverFetch,serverJson} from '../extensions/drive-bridge/shared.js';

const warning='<!DOCTYPE html><html><body>ngrok ERR_NGROK_6024 example-private-content</body></html>';
test('ngrok: 코드 등록·대기 작업·결과·바이너리 전송 모두 안내 제외 헤더 사용',async t=>{
 const requests=[];const bytes=Buffer.from([0,1,2,60,255,10]);
 const server=http.createServer((req,res)=>{
   requests.push({url:req.url,headers:req.headers});
   if(req.headers['ngrok-skip-browser-warning']!=='1'){res.setHeader('Content-Type','text/html');res.end(warning);return;}
   if(req.url.endsWith('/file')){res.setHeader('Content-Type','application/octet-stream');res.end(bytes);return;}
   res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.url.endsWith('/pair')?{token:'bridge-test',user:'시험 사용자'}:{job:null}));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections();}));
 const connection={server:`http://127.0.0.1:${server.address().port}`,token:'existing-bridge-token'};
 const pair=await serverJson({server:connection.server},'/api/drive/bridge/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"code":"test"}'});assert.equal(pair.token,'bridge-test');assert.equal(requests[0].headers.authorization,undefined);
 assert.deepEqual(await serverJson(connection,'/api/drive/bridge/jobs'),{job:null});
 await serverFetch(connection,'/api/drive/bridge/jobs/job/result',{method:'POST',headers:{'Content-Type':'application/json','x-drive-claim':'claim'},body:'{"result":{}}'});
 assert.deepEqual(Buffer.from(await (await serverFetch(connection,'/api/drive/bridge/jobs/job/file',{headers:{'x-drive-claim':'claim'}})).arrayBuffer()),bytes);
 await serverFetch(connection,'/api/drive/bridge/jobs/job/file',{method:'POST',headers:{'Content-Type':'application/octet-stream','x-drive-claim':'claim'},body:bytes});
 for(const req of requests){assert.equal(req.headers['ngrok-skip-browser-warning'],'1');if(!req.url.endsWith('/pair'))assert.equal(req.headers.authorization,'Bearer existing-bridge-token');}
 assert.equal(requests[1].headers.accept,'application/json');assert.equal(requests[2].headers['x-drive-claim'],'claim');assert.equal(requests[4].headers['content-type'],'application/octet-stream');
});
test('HTML·오류·손상된 JSON을 SyntaxError 대신 명확한 연결 오류로 표시',async t=>{
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});const connection={server:'https://test.ngrok-free.dev',token:'never-print-this'};
 for(const type of ['text/html','text/plain','application/json']){
   globalThis.fetch=async()=>new Response(warning,{headers:{'Content-Type':type}});
   await assert.rejects(serverJson(connection,'/api/drive/bridge/jobs'),e=>e.code==='BRIDGE_HTML_RESPONSE'&&e.message.includes('ERR_NGROK_6024')&&!e.message.includes('example-private-content')&&!e.message.includes(connection.token));
 }
 globalThis.fetch=async()=>new Response('<html>Other upstream</html>',{status:502,headers:{'Content-Type':'text/html'}});
 await assert.rejects(serverFetch(connection,'/api/drive/bridge/jobs/job/file'),e=>e.code==='BRIDGE_HTML_RESPONSE'&&e.status===502);
 globalThis.fetch=async()=>new Response('invalid-json',{headers:{'Content-Type':'application/json'}});
 await assert.rejects(serverJson(connection,'/api/drive/bridge/jobs'),e=>e.code==='BRIDGE_BAD_JSON'&&!e.message.includes('Unexpected token'));
 globalThis.fetch=async()=>Response.json({error:'DRIVE_BRIDGE_AUTH',message:'다시 연결하세요.'},{status:401});
 await assert.rejects(serverJson(connection,'/api/drive/bridge/jobs'),e=>e.status===401&&e.code==='DRIVE_BRIDGE_AUTH'&&e.message==='다시 연결하세요.');
 await assert.rejects(serverFetch(connection,'https://another.example/api/drive/jobs'),/허용되지 않은/);
});
