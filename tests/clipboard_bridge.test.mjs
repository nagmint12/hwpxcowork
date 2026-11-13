import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {createClipboardBridge} from '../server/clipboard-bridge.js';

function fakeProcess() {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stdin = new PassThrough();
  child.stdin.once('finish', () => child.emit('exit', 0));
  child.kill = () => child.emit('exit', 1);
  return child;
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('클립보드 연결은 설정한 Windows PC에서만 시작하고 중복 실행하지 않는다', async () => {
  for (const options of [{enabled:false,platform:'win32'}, {enabled:true,platform:'linux'}]) {
    const bridge = createClipboardBridge({...options,launch:()=>assert.fail('disabled bridge spawned')});
    bridge.start(); assert.equal(bridge.status().enabled,false); await bridge.stop();
  }
  let count=0;const child=fakeProcess();
  const bridge=createClipboardBridge({enabled:true,platform:'win32',launch:(_file,args,options)=>{count++;assert.ok(args.includes('--watch'));assert.equal(options.windowsHide,true);return child;}});
  bridge.start();bridge.start();assert.equal(count,1);await bridge.stop();
});

test('연결 상태에는 문서 내용 없이 버전과 성공 횟수만 기록한다', async () => {
  const child=fakeProcess(),bridge=createClipboardBridge({enabled:true,platform:'win32',launch:()=>child});bridge.start();
  child.stdout.write('{"event":"ready","ok":true}\n{"event":"enriched","ok":true,"sourceVersion":2018,"native":"must-not-appear-in-status"}\n');
  await tick();const status=bridge.status();assert.equal(status.running,true);assert.equal(status.copies,1);assert.equal(status.lastSourceVersion,2018);
  assert.doesNotMatch(JSON.stringify(status),/must-not-appear/);status.copies=999;assert.equal(bridge.status().copies,1);await bridge.stop();
});

test('연결 프로세스가 비정상 종료되면 재시작하고 정상 중지 뒤에는 다시 켜지지 않는다', async () => {
  const children=[];const bridge=createClipboardBridge({enabled:true,platform:'win32',retryMs:5,launch:()=>{const c=fakeProcess();children.push(c);return c;}});
  bridge.start();children[0].emit('exit',1);await new Promise(resolve=>setTimeout(resolve,30));assert.equal(children.length,2);
  children[1].stdout.write('{"event":"ready","ok":true}\n');await tick();assert.equal(bridge.status().running,true);await bridge.stop();await new Promise(resolve=>setTimeout(resolve,30));assert.equal(children.length,2);assert.equal(bridge.status().running,false);
});

test('같은 사용자에게 이미 연결이 있으면 경쟁하는 연결을 계속 만들지 않는다', async () => {
  let count=0;const child=fakeProcess(),bridge=createClipboardBridge({enabled:true,platform:'win32',retryMs:5,launch:()=>{count++;return child;}});bridge.start();
  child.stdout.write('{"ok":false,"reason":"ALREADY_RUNNING"}\n');await tick();child.emit('exit',0);await new Promise(resolve=>setTimeout(resolve,30));assert.equal(count,1);assert.equal(bridge.status().reason,'ALREADY_RUNNING');await bridge.stop();
});
