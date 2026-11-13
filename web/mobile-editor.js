import { isMobileDevice } from './mobile-settings.js';

export function installDocumentPinch(container, viewport, enabled = () => true) {
  const doc = container.ownerDocument; const view = doc.defaultView;
  const originalAction = container.style.touchAction;
  container.style.touchAction = 'pan-x pan-y';
  let pinch = null, active = false, frame = 0, pending = null;
  const flush = () => { frame = 0; if (pending !== null && pinch) viewport()?.setZoom(pending, pinch.anchor); pending = null; };
  // 같은 document의 입력/선택 처리기는 두 손가락 시작을 보고 자신의 대기 타이머를 취소해야 한다.
  const consume = event => { if (event.cancelable) event.preventDefault(); event.stopPropagation(); };
  const start = event => {
    if (!enabled() || event.touches.length !== 2 || !container.contains(event.target)) return;
    const vm = viewport(); if (!vm) return;
    const [a,b] = [...event.touches]; const distance = Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY);
    if (!distance) return;
    const r = container.getBoundingClientRect();
    pinch = {ids:[a.identifier,b.identifier],distance,zoom:vm.getZoom(),anchor:{
      x:Math.max(0,Math.min(1,((a.clientX+b.clientX)/2-r.left)/r.width)),
      y:Math.max(0,Math.min(1,((a.clientY+b.clientY)/2-r.top)/r.height))}};
    active = true; consume(event);
  };
  const move = event => {
    if (!active) return; consume(event);
    if (!pinch || event.touches.length !== 2) return;
    const [a,b] = pinch.ids.map(id => [...event.touches].find(t => t.identifier === id)); if (!a || !b) return;
    pending = Math.max(0.1,Math.min(4,pinch.zoom*Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY)/pinch.distance));
    if (!frame) frame = view.requestAnimationFrame(flush);
  };
  const end = event => {
    if (!active) return; consume(event);
    if (frame) view.cancelAnimationFrame(frame); flush(); pinch = null;
    // 핀치 뒤 남은 한 손가락은 모두 뗄 때까지 소비한다.
    if (!event.touches.length || event.type === 'touchcancel') active = false;
  };
  doc.addEventListener('touchstart',start,{capture:true,passive:false});
  doc.addEventListener('touchmove',move,{capture:true,passive:false});
  doc.addEventListener('touchend',end,{capture:true,passive:false});
  doc.addEventListener('touchcancel',end,{capture:true,passive:false});
  return () => {
    if (frame) view.cancelAnimationFrame(frame);
    doc.removeEventListener('touchstart',start,true);doc.removeEventListener('touchmove',move,true);
    doc.removeEventListener('touchend',end,true);doc.removeEventListener('touchcancel',end,true);
    container.style.touchAction=originalAction;
  };
}

const MOBILE_CSS = `
:root[data-hwpx-mobile="true"][data-toolbox-basic="hidden"] #style-bar,
:root[data-hwpx-mobile="true"] .rhwp-chrome-no-toolbar #style-bar,
:root[data-hwpx-mobile="true"] .rhwp-chrome-no-menu #style-bar { display:none !important; }
:root[data-hwpx-mobile="true"][data-toolbox-basic="hidden"] #ruler-corner,
:root[data-hwpx-mobile="true"][data-toolbox-basic="hidden"] #h-ruler,
:root[data-hwpx-mobile="true"][data-toolbox-basic="hidden"] #v-ruler,
:root[data-hwpx-mobile="true"] .rhwp-chrome-no-menu #ruler-corner,
:root[data-hwpx-mobile="true"] .rhwp-chrome-no-menu #h-ruler,
:root[data-hwpx-mobile="true"] .rhwp-chrome-no-menu #v-ruler { visibility:hidden;pointer-events:none; }
:root[data-hwpx-mobile="true"][data-toolbox-basic="hidden"] #editor-area,
:root[data-hwpx-mobile="true"] .rhwp-chrome-no-menu #editor-area { grid-template-columns:0 minmax(0,1fr);grid-template-rows:0 minmax(0,1fr); }
`;

export function installMobileEditorUI(editor, doc = document) {
  const view = doc.defaultView; const root = doc.documentElement;
  if (doc.getElementById('hwpx-mobile-editor-style')) return;
  const style=doc.createElement('style');style.id='hwpx-mobile-editor-style';style.textContent=MOBILE_CSS;doc.head.append(style);
  const format=doc.getElementById('style-bar'); const studio=doc.getElementById('studio-root');
  const toggle=doc.getElementById('toolbox-basic-toggle');
  const sync=()=>{
    const mobile=isMobileDevice(view); root.dataset.hwpxMobile=String(mobile);
    const collapsed=root.dataset.toolboxBasic==='hidden'||studio?.classList.contains('rhwp-chrome-no-toolbar')||studio?.classList.contains('rhwp-chrome-no-menu');
    if(format) format.inert=!!(mobile&&collapsed);
    if(toggle&&mobile){const label=root.dataset.toolboxBasic==='hidden'?'편집 도구 모두 펼치기':'편집 도구 모두 접기';toggle.setAttribute('aria-label',label);toggle.title=label;}
  };
  const observer=new view.MutationObserver(sync);observer.observe(root,{attributes:true,attributeFilter:['data-toolbox-basic']});
  if(studio)observer.observe(studio,{attributes:true,attributeFilter:['class']});
  const coarse=view.matchMedia('(pointer: coarse)');coarse.addEventListener('change',sync);sync();
  const container=doc.getElementById('scroll-container');
  const off=container?installDocumentPinch(container,()=>editor,()=>isMobileDevice(view)):()=>{};
  return()=>{off();observer.disconnect();coarse.removeEventListener('change',sync);style.remove();delete root.dataset.hwpxMobile;if(format)format.inert=false;};
}
