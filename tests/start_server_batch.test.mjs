// Explorer double-click uses CMD: exercise that entry point with isolated data.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {stopManagedServer} from '../server/control-cli.js';
const root=fileURLToPath(new URL('../',import.meta.url));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,ms=15000){for(const end=Date.now()+ms;Date.now()<end;){const value=await fn();if(value)return value;await delay(100);}throw Error('Batch startup/restart timed out');}

test('Windows double-click entry starts, avoids duplicates, and supports managed restart', {skip:process.platform!=='win32',timeout:60000}, async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hwpx-batch-'));
 const probe=net.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(r=>probe.close(r));
 const config=path.join(dir,'config.json'),data=path.join(dir,'data');
 fs.writeFileSync(config,JSON.stringify({host:'127.0.0.1',port,dataDir:data,users:[{name:'batch-admin',role:'admin',token:'batch-test-only'}],ai:{enabled:false}}));
 const configBefore=fs.readFileSync(config);
 const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^HWPX_COWORK_/i.test(key)));
 Object.assign(env,{HWPX_COWORK_CONFIG:config,HWPX_COWORK_DATA_DIR:data,HWPX_COWORK_PORT:String(port),HWPX_COWORK_AI_MOCK:'1',HWPX_COWORK_NO_BROWSER:'1'});
 const start=()=>{
  const child=spawn(process.env.ComSpec||'cmd.exe',['/d','/c',path.join(root,'start-server.bat')],{cwd:root,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
  const output={stdout:'',stderr:''};child.stdout.on('data',b=>output.stdout+=b);child.stderr.on('data',b=>output.stderr+=b);child.stdin.end('\r\n');return {child,output};
 };
 const {child,output}=start();
 t.after(async()=>{
  try{await stopManagedServer({root,env});}finally{
   if(child.exitCode===null)await Promise.race([once(child,'exit'),delay(5000)]);
   assert.notEqual(child.exitCode,null,'owned batch must exit after graceful shutdown');
   const resolved=fs.realpathSync(dir);assert.equal(path.dirname(resolved).toLowerCase(),fs.realpathSync(os.tmpdir()).toLowerCase());assert(path.basename(resolved).startsWith('hwpx-batch-'));
   fs.rmSync(resolved,{recursive:true,force:true});
  }
 });
 const base=`http://127.0.0.1:${port}`,headers={Authorization:'Bearer batch-test-only','Content-Type':'application/json'};
 const get=async(url,options={})=>{const r=await fetch(base+url,{...options,signal:AbortSignal.timeout(1500)});assert(r.ok,`HTTP ${r.status}`);return r.json();};
 const initial=await until(async()=>{try{return await get('/api/config');}catch{if(child.exitCode!==null)throw Error(JSON.stringify(output));return null;}});
 await t.test('starts through the real batch without malformed CMD commands',()=>{
  assert.match(output.stdout,/hwpx-cowork/);assert(!/not recognized|не является|인식되지|내부 또는 외부 명령/i.test(output.stdout+output.stderr),JSON.stringify(output));
 });
 await t.test('double-clicking again preserves the active server',async()=>{
  const duplicate=start();await once(duplicate.child,'exit');assert.equal(duplicate.child.exitCode,0);assert.match(duplicate.output.stdout,/Already running/);
  assert.equal((await get('/api/config')).nonce,initial.nonce);
 });
 await t.test('admin restart changes identity and preserves config',async()=>{
  const state=await get('/api/admin/server',{headers});assert(state.restart.supported&&!state.restart.busy);
  const accepted=await get('/api/admin/restart',{method:'POST',headers,body:JSON.stringify({revision:state.revision})});assert(accepted.accepted);
  const after=await until(async()=>{try{const s=await get('/api/config');return s.nonce!==initial.nonce?s:null;}catch{return null;}});
  assert.notEqual(after.nonce,initial.nonce);assert.deepEqual(fs.readFileSync(config),configBefore);
  const ready=await get('/api/admin/server',{headers});assert(ready.restart.supported&&!ready.restart.busy);
 });
});
