import test from 'node:test';
import assert from 'node:assert/strict';
import {isMobileDevice,readMobileHoldMs,writeMobileHoldMs,normalizeMobileHoldMs} from '../web/mobile-settings.js';
import {installDocumentPinch} from '../web/mobile-editor.js';
import {createHoldDrag} from '../studio/plugin/touch-selection.ts';

test('모바일 시간은 0.1~2초, 0.1초 단위로 저장·복원하고 저장소 차단 때도 현재 세션에 적용한다',()=>{
  const values=new Map();const view={localStorage:{getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)}};
  assert.equal(readMobileHoldMs(view),400);
  for(const [value,expected] of [[100,100],[2000,2000],[800,800],[-1,100],[3000,2000],[450,500],['bad',400]]){
    assert.equal(writeMobileHoldMs(value,view),expected);assert.equal(readMobileHoldMs(view),expected);
  }
  const blocked={get localStorage(){throw Error('blocked');}};
  writeMobileHoldMs(1200,blocked);assert.equal(readMobileHoldMs(blocked),1200);
  assert.equal(normalizeMobileHoldMs(null),400);
});
test('모바일 조건은 화면 폭만으로 데스크톱을 바꾸지 않는다',()=>{
  const view={matchMedia:()=>({matches:false}),navigator:{userAgent:'Windows',platform:'Win32',maxTouchPoints:0}};
  assert.equal(isMobileDevice(view),false);
  view.navigator.userAgent='Android';assert.equal(isMobileDevice(view),true);
});
test('선택을 시작하는 길게 누르기도 설정 시간에 맞추고 스크롤하면 취소한다',()=>{
  let ms=100,timer=null;const delays=[],events=[];
  const hold=createHoldDrag({delay:()=>ms,schedule:(fn,delay)=>{delays.push(delay);timer=fn;return 1;},clear:()=>timer=null,start:()=>events.push('start'),move(){},end(){}});
  hold.start({x:0,y:0});assert.deepEqual(delays,[100]);hold.move({x:0,y:20});assert.equal(timer,null);
  ms=2000;hold.start({x:0,y:0});assert.deepEqual(delays,[100,2000]);timer();assert.deepEqual(events,['start']);hold.end();
});
test('두 손가락은 문서 배율을 변경하고 한 손가락 스크롤·남은 손가락·해제 상태를 구분한다',()=>{
  const handlers=new Map();let raf=null,zoom=1;const calls=[];
  const doc={defaultView:{requestAnimationFrame:fn=>{raf=fn;return 1;},cancelAnimationFrame:()=>raf=null},
    addEventListener:(type,fn)=>handlers.set(type,fn),removeEventListener:type=>handlers.delete(type)};
  const container={ownerDocument:doc,style:{touchAction:''},contains:t=>t===container,getBoundingClientRect:()=>({left:0,top:0,width:400,height:600})};
  const vm={getZoom:()=>zoom,setZoom:(value,anchor)=>{zoom=value;calls.push({value,anchor});}};
  const off=installDocumentPinch(container,()=>vm);
  const points=span=>[{identifier:1,clientX:200-span/2,clientY:200},{identifier:2,clientX:200+span/2,clientY:200}];
  const emit=(type,touches)=>{const e={type,target:container,touches,cancelable:true,preventDefault(){this.prevented=true;},stopPropagation(){}};handlers.get(type)(e);return e;};
  assert.equal(emit('touchstart',[points(100)[0]]).prevented,undefined);
  emit('touchstart',points(100));emit('touchmove',points(200));raf();assert.equal(zoom,2);assert.deepEqual(calls[0].anchor,{x:.5,y:1/3});
  assert.equal(emit('touchend',[points(200)[0]]).prevented,true);
  assert.equal(emit('touchmove',[points(200)[0]]).prevented,true);assert.equal(zoom,2);
  emit('touchend',[]);assert.equal(emit('touchmove',[points(200)[0]]).prevented,undefined);
  off();assert.equal(handlers.size,0);assert.equal(container.style.touchAction,'');
});
