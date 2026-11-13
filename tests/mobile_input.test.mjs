import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {installHoldToEdit} from '../web/hold-to-edit.js';
import {coworkBuildPlugins} from '../studio/build/patches.mjs';

class Events {
  listeners = new Map();
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type,new Set()); this.listeners.get(type).add(fn); }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  emit(type, event={}) { for (const fn of this.listeners.get(type)||[]) fn(event); }
}
function fixture({mobile=true, ios=false, textarea=true, holdMillis=null, native=false}={}) {
  const doc=new Events(); doc.activeElement=null; const media=new Events(); media.matches=mobile;
  doc.defaultView={matchMedia:()=>media,navigator:{userAgent:ios?'iPhone':'test',platform:'test',maxTouchPoints:mobile?1:0}};
  doc.defaultView.localStorage={getItem:()=>holdMillis};
  const attributes=new Map(ios?[['contenteditable','true'],['inputmode','text']]:[]);
  const input=new Events(); input.ownerDocument=doc; input.isConnected=true;
  if(textarea) input.readOnly=false;
  input.getAttribute=n=>attributes.get(n)??null; input.setAttribute=(n,v)=>attributes.set(n,String(v)); input.removeAttribute=n=>attributes.delete(n);
  input.contains=t=>t===input; let focuses=0;
  input.focus=function(){ focuses++; doc.activeElement=input; input.emit('focus'); };
  const nativeFocus=input.focus;
  input.blur=()=>{doc.activeElement=null;input.emit('blur');};
  const canvas={}; const surface=native?input:{contains:t=>t===canvas};
  const delays=[];
  let timer=null; const dispose=installHoldToEdit(input,{surface,schedule(fn,ms){delays.push(ms);timer=fn;return 1;},clear(){timer=null;}});
  const touch=(x=10,y=10,id=1)=>({identifier:id,clientX:x,clientY:y});
  const event=(target,touches)=>({target,touches,cancelable:true,preventDefault(){this.prevented=true;}});
  return {doc,input,canvas,surface,media,dispose,nativeFocus,delays,focuses:()=>focuses,tick(){const fn=timer;timer=null;fn?.();},
    start(target=canvas,touches=[touch()]){doc.emit('touchstart',event(target,touches));},
    move(x,y){doc.emit('touchmove',event(canvas,[touch(x,y)]));},end(){doc.emit('touchend',event(canvas,[]));},cancel(){doc.emit('touchcancel');}};
}

test('모바일 짧은 탭·자동 이동·직접 native focus는 편집 입력을 활성화하지 않는다',()=>{
  const f=fixture();f.input.focus();assert.equal(f.focuses(),0);
  f.start();f.end();f.tick();f.input.focus();assert.equal(f.doc.activeElement,null);assert.equal(f.focuses(),0);
  f.nativeFocus();assert.equal(f.doc.activeElement,null);assert.equal(f.input.readOnly,true);
});

test('입력 타이머는 저장된 0.1초·2초 옵션과 기본 0.4초를 사용한다',()=>{
  for(const [value,expected] of [[100,100],[2000,2000],[null,400]]){
    const f=fixture({holdMillis:value});f.start();assert.deepEqual(f.delays,[expected]);f.dispose();
  }
});
test('보이는 메모·AI 입력은 네이티브 터치 포커스와 길게 누르기를 막지 않는다',()=>{
  for (const ios of [false,true]) {
    const f=fixture({native:true,ios});
    assert.equal(f.input.readOnly,false);
    assert.notEqual(f.input.getAttribute('inputmode'),'none');
    f.input.focus();assert.equal(f.focuses(),0,'자동 포커스로 키보드를 열지 않음');
    f.start(f.input);f.nativeFocus();f.tick();f.end();
    assert.equal(f.doc.activeElement,f.input);
    assert.equal(f.input.readOnly,false);
    assert.equal(f.focuses(),1,'touchend에서 중복 포커스하지 않음');
    assert.deepEqual(f.delays,[]);
    f.dispose();
  }
});
test('길게 누른 뒤 실제 touchend에서만 입력을 열고, 밖을 누른 뒤에는 다시 길게 눌러야 한다',()=>{
  const f=fixture();f.start();f.tick();assert.equal(f.focuses(),0);f.end();
  assert.equal(f.doc.activeElement,f.input);assert.equal(f.input.readOnly,false);
  f.start();f.end();assert.equal(f.doc.activeElement,f.input,'입력 중 캐럿 이동은 유지');
  f.start({});f.input.focus();assert.equal(f.doc.activeElement,null);assert.equal(f.input.readOnly,true);
});
test('스크롤·핀치·취소된 터치·제거된 입력 칸은 키보드를 열지 않는다',()=>{
  const scroll=fixture();scroll.start();scroll.move(10,35);scroll.tick();scroll.end();assert.equal(scroll.focuses(),0);
  const pinch=fixture();pinch.start();pinch.start(pinch.canvas,[{identifier:1},{identifier:2}]);pinch.tick();pinch.end();assert.equal(pinch.focuses(),0);
  const cancel=fixture();cancel.start();cancel.cancel();cancel.tick();cancel.end();assert.equal(cancel.focuses(),0);
  const gone=fixture();gone.start();gone.tick();gone.input.isConnected=false;gone.end();assert.equal(gone.focuses(),0);
});
test('iOS contenteditable도 길게 누르기 전에는 잠기고 종료 때 원래 속성을 복원한다',()=>{
  const f=fixture({ios:true,textarea:false});assert.equal(f.input.getAttribute('contenteditable'),'false');assert.equal(f.input.getAttribute('inputmode'),'none');
  f.start();f.tick();f.end();assert.equal(f.input.getAttribute('contenteditable'),'true');assert.equal(f.doc.activeElement,f.input);
  f.dispose();assert.equal(f.input.getAttribute('contenteditable'),'true');assert.equal(f.input.getAttribute('inputmode'),'text');assert.equal(f.input.focus,f.nativeFocus);
});
test('데스크톱 포커스·입력 속성은 그대로이며 정리 후에는 타이머가 남지 않는다',()=>{
  const f=fixture({mobile:false});f.input.focus();assert.equal(f.doc.activeElement,f.input);assert.equal(f.input.readOnly,false);assert.equal(f.input.getAttribute('inputmode'),null);
  const m=fixture();m.start();m.dispose();m.tick();m.end();assert.equal(m.focuses(),0);assert.equal(m.input.focus,m.nativeFocus);
});
test('엔진 InputHandler가 cowork 플러그인과 무관하게 같은 모바일 정책을 설치하고 해제한다',()=>{
  const root=path.resolve('vendor/rhwp/rhwp-studio');const file=path.join(root,'src/engine/input-handler.ts');
  const transformed=coworkBuildPlugins({studioSrc:root})[0].transform(fs.readFileSync(file,'utf8'),file).code;
  assert.match(transformed,/this\.disposeHoldToEdit = installHoldToEdit\(this\.textarea, \{ surface: this\.container \}\)/);
  assert.match(transformed,/this\.disposeHoldToEdit\?\.\(\);\s+this\.disposeHoldToEdit = null;\s+this\.textarea\.remove\(\)/);
});
