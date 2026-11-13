// [hwpx-cowork] 2026-11-11 옛 Safari(15.0~15.3, macOS 10.15 Catalina 의 기본 판) 보완.
// 맥 Safari 15.2 에서 편집기(studio)가 시작하자마자 `Object.hasOwn is not a function` 으로 멈춰 '편집기를 불러오는 중…' 이
// 끝나지 않았다(운영 client-log, 2026-11-11 23:16). 편집기 묶음과 웹 앱이 쓰는 15.4 이후 API 만 '없을 때만' 채운다.
// 웹 앱(index.html)은 이 파일을 <script> 로, 편집기(studio)는 빌드 때 index.html 머리와 작업자(worker) 청크 앞에 넣는다
// (scripts/build-studio.mjs). 작업자에서도 돌므로 DOM 부분은 document 가 있을 때만 한다. 일반 스크립트(모듈 아님)로 쓴다.
(function () {
  'use strict';
  var G = typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : window);
  function def(obj, name, value) {
    if (!obj || Object.prototype.hasOwnProperty.call(obj, name)) return;
    try { Object.defineProperty(obj, name, { value: value, writable: true, configurable: true, enumerable: false }); } catch (e) { /* 무시 */ }
  }
  function toInt(n) { n = Math.trunc(Number(n)) || 0; return n; }

  // Array/String/TypedArray .at (Safari 15.4)
  function at(i) { var len = this.length >>> 0; var k = toInt(i); if (k < 0) k += len; return k < 0 || k >= len ? undefined : this[k]; }
  function strAt(i) { var s = String(this); var k = toInt(i); if (k < 0) k += s.length; return k < 0 || k >= s.length ? undefined : s.charAt(k); }
  var TA = typeof Int8Array !== 'undefined' ? Object.getPrototypeOf(Int8Array.prototype) : null;
  if (!Array.prototype.at) def(Array.prototype, 'at', at);
  if (!String.prototype.at) def(String.prototype, 'at', strAt);
  if (TA && !TA.at) def(TA, 'at', at);

  // findLast / findLastIndex (Safari 15.4)
  function findLastIndex(fn, thisArg) { for (var i = (this.length >>> 0) - 1; i >= 0; i--) if (fn.call(thisArg, this[i], i, this)) return i; return -1; }
  function findLast(fn, thisArg) { var i = findLastIndex.call(this, fn, thisArg); return i < 0 ? undefined : this[i]; }
  [Array.prototype, TA].forEach(function (P) { if (P && !P.findLast) { def(P, 'findLast', findLast); def(P, 'findLastIndex', findLastIndex); } });

  // Object.hasOwn (Safari 15.4)
  if (!Object.hasOwn) def(Object, 'hasOwn', function (o, k) { if (o == null) throw new TypeError('Cannot convert undefined or null to object'); return Object.prototype.hasOwnProperty.call(Object(o), k); });

  // structuredClone (Safari 15.4) — 구조화 복제 알고리즘의 흔한 형태만(순환 참조·Map·Set·Date·RegExp·ArrayBuffer·형식화 배열·Blob/File·Error)
  if (typeof G.structuredClone !== 'function') {
    def(G, 'structuredClone', function (value) {
      var seen = new Map();
      function fail(what) { var E = G.DOMException; throw E ? new E(what + ' could not be cloned.', 'DataCloneError') : new TypeError(what + ' could not be cloned.'); }
      function clone(v) {
        if (v === null || (typeof v !== 'object' && typeof v !== 'function')) {
          if (typeof v === 'symbol') fail('Symbol');
          return v;
        }
        if (typeof v === 'function') fail('function');
        if (seen.has(v)) return seen.get(v);
        var tag = Object.prototype.toString.call(v), out;
        if (tag === '[object Date]') out = new Date(v.getTime());
        else if (tag === '[object RegExp]') out = new RegExp(v.source, v.flags);
        else if (tag === '[object Boolean]' || tag === '[object Number]' || tag === '[object String]') out = Object(v.valueOf());
        else if (tag === '[object ArrayBuffer]') out = v.slice(0);
        else if (ArrayBuffer.isView(v)) {
          var buf = clone(v.buffer);
          out = tag === '[object DataView]' ? new DataView(buf, v.byteOffset, v.byteLength) : new v.constructor(buf, v.byteOffset, v.length);
        } else if ((G.Blob && v instanceof G.Blob) || (G.ImageBitmap && v instanceof G.ImageBitmap) || (G.ImageData && v instanceof G.ImageData)) {
          out = v; // 바꿀 수 없는 값이라 같은 것을 쓴다
        } else if (tag === '[object Map]') {
          out = new Map(); seen.set(v, out);
          v.forEach(function (val, key) { out.set(clone(key), clone(val)); });
          return out;
        } else if (tag === '[object Set]') {
          out = new Set(); seen.set(v, out);
          v.forEach(function (val) { out.add(clone(val)); });
          return out;
        } else if (tag === '[object Error]') {
          out = new (G[v.name] || Error)(v.message); if (v.stack) out.stack = v.stack;
        } else if (Array.isArray(v)) {
          out = new Array(v.length); seen.set(v, out);
          for (var i = 0; i < v.length; i++) if (i in v) out[i] = clone(v[i]);
          return out;
        } else if (tag === '[object Object]' || tag === '[object Arguments]' || Object.getPrototypeOf(v) === null) {
          out = {}; seen.set(v, out);
          Object.keys(v).forEach(function (k) { out[k] = clone(v[k]); });
          return out;
        } else if (typeof Node !== 'undefined' && v instanceof Node) {
          fail('Node');
        } else {
          // 클래스 인스턴스: 구조화 복제처럼 자기 열거 속성만 평범한 객체로
          out = {}; seen.set(v, out);
          Object.keys(v).forEach(function (k) { out[k] = clone(v[k]); });
          return out;
        }
        seen.set(v, out);
        return out;
      }
      return clone(value);
    });
  }

  // crypto.randomUUID (Safari 15.4)
  var C = G.crypto;
  if (C && typeof C.getRandomValues === 'function' && typeof C.randomUUID !== 'function') {
    var uuid = function () {
      var b = C.getRandomValues(new Uint8Array(16));
      b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
      var h = []; for (var i = 0; i < 16; i++) h.push((b[i] + 0x100).toString(16).slice(1));
      return h.slice(0, 4).join('') + '-' + h.slice(4, 6).join('') + '-' + h.slice(6, 8).join('') + '-' + h.slice(8, 10).join('') + '-' + h.slice(10).join('');
    };
    try { def(Object.getPrototypeOf(C), 'randomUUID', uuid); } catch (e) { /* 무시 */ }
    if (typeof C.randomUUID !== 'function') def(C, 'randomUUID', uuid);
  }

  // AbortSignal.timeout / AbortSignal.any (Safari 16 / 17.4)
  if (G.AbortSignal && G.AbortController) {
    if (typeof G.AbortSignal.timeout !== 'function') {
      def(G.AbortSignal, 'timeout', function (ms) {
        var c = new G.AbortController();
        setTimeout(function () { var E = G.DOMException; c.abort(E ? new E('signal timed out', 'TimeoutError') : undefined); }, ms);
        return c.signal;
      });
    }
    if (typeof G.AbortSignal.any !== 'function') {
      def(G.AbortSignal, 'any', function (signals) {
        var c = new G.AbortController();
        Array.prototype.forEach.call(signals, function (s) {
          if (c.signal.aborted) return;
          if (s.aborted) c.abort(s.reason); else s.addEventListener('abort', function () { c.abort(s.reason); }, { once: true });
        });
        return c.signal;
      });
    }
  }

  // BroadcastChannel (Safari 15.4) — 다른 탭 알림만 빠지고 나머지는 그대로 돌도록 같은 탭 안의 같은 이름끼리만 전한다
  if (typeof G.BroadcastChannel !== 'function' && typeof G.EventTarget === 'function') {
    var channels = {};
    var BC = function (name) {
      var t = new G.EventTarget(); t.name = String(name); t.onmessage = null; t.onmessageerror = null; t._closed = false;
      t.postMessage = function (data) {
        if (t._closed) return;
        (channels[t.name] || []).forEach(function (o) {
          if (o === t || o._closed) return;
          setTimeout(function () { var ev = new G.MessageEvent('message', { data: G.structuredClone(data) }); o.dispatchEvent(ev); if (typeof o.onmessage === 'function') o.onmessage(ev); }, 0);
        });
      };
      t.close = function () { t._closed = true; channels[t.name] = (channels[t.name] || []).filter(function (o) { return o !== t; }); };
      (channels[t.name] = channels[t.name] || []).push(t);
      return t;
    };
    def(G, 'BroadcastChannel', BC);
  }

  // <dialog> showModal/show/close (Safari 15.4) — 웹 앱의 관리자·도움말·드라이브 창이 쓴다
  if (typeof document !== 'undefined') {
    var probe = document.createElement('dialog');
    if (typeof probe.showModal !== 'function') {
      var P = Object.getPrototypeOf(probe);
      var style = document.createElement('style');
      style.textContent = 'dialog{position:absolute;left:0;right:0;width:-webkit-fit-content;height:-webkit-fit-content;margin:auto;border:solid;padding:1em;background:#fff;color:#000}'
        + 'dialog:not([open]){display:none}dialog[open]{display:block}'
        + 'dialog[data-legacy-modal]{position:fixed;top:50%;transform:translate(0,-50%);z-index:2147483001;max-height:calc(100% - 32px);overflow:auto}'
        + '.legacy-dialog-backdrop{position:fixed;inset:0;top:0;right:0;bottom:0;left:0;background:rgba(0,0,0,.35);z-index:2147483000}';
      (document.head || document.documentElement).appendChild(style);
      Object.defineProperty(P, 'open', {
        configurable: true,
        get: function () { return this.hasAttribute('open'); },
        set: function (v) { if (v) this.setAttribute('open', ''); else this.removeAttribute('open'); },
      });
      if (!('returnValue' in P)) Object.defineProperty(P, 'returnValue', { configurable: true, writable: true, value: '' });
      def(P, 'show', function () { this.setAttribute('open', ''); });
      def(P, 'showModal', function () {
        if (this.hasAttribute('open')) return;
        var dlg = this, bd = document.createElement('div');
        bd.className = 'legacy-dialog-backdrop';
        dlg.parentNode && dlg.parentNode.insertBefore(bd, dlg);
        dlg._legacyBackdrop = bd;
        dlg.setAttribute('data-legacy-modal', '');
        dlg.setAttribute('open', '');
        dlg._legacyKey = function (e) {
          if (e.key !== 'Escape') return;
          e.preventDefault();
          var ev = new Event('cancel', { cancelable: true });
          if (dlg.dispatchEvent(ev)) dlg.close();
        };
        document.addEventListener('keydown', dlg._legacyKey, true);
        var f = dlg.querySelector('[autofocus]') || dlg.querySelector('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
        if (f && f.focus) try { f.focus(); } catch (e) { /* 무시 */ }
      });
      def(P, 'close', function (rv) {
        if (!this.hasAttribute('open')) return;
        if (rv !== undefined) this.returnValue = String(rv);
        this.removeAttribute('open');
        this.removeAttribute('data-legacy-modal');
        if (this._legacyBackdrop) { this._legacyBackdrop.remove(); this._legacyBackdrop = null; }
        if (this._legacyKey) { document.removeEventListener('keydown', this._legacyKey, true); this._legacyKey = null; }
        this.dispatchEvent(new Event('close'));
      });
      // <form method="dialog"> 제출은 창을 닫는다
      document.addEventListener('submit', function (e) {
        var form = e.target;
        if (!form || (form.getAttribute('method') || '').toLowerCase() !== 'dialog') return;
        var dlg = form.closest('dialog');
        if (!dlg) return;
        e.preventDefault();
        var s = e.submitter;
        dlg.close(s && s.value !== undefined ? s.value : undefined);
      }, true);
    }
  }
})();
