#!/usr/bin/env node
// 사용 설명서(web/help.html) 그림 만들기 — SVG 로 그리고 → PNG(@resvg/resvg-wasm) → WebP(Python Pillow). 브라우저를 쓰지 않는다.
//   node scripts/build-help-visuals.mjs            → web/help-assets/*.webp (그림마다 150KB 미만)
//   node scripts/build-help-visuals.mjs --svg <폴더> → 그 폴더에 SVG 원본도 남김(고칠 때 보기용)
// 글꼴: 저장소의 재배포 가능 글꼴(Pretendard·D2Coding, SIL OFL — vendor/rhwp/assets/fonts 의 woff2)을
//   Python fontTools 로 풀어(임시 폴더) resvg 에 넘긴다. 그림은 자기 바탕(밝은 카드)을 갖고 바깥은 투명이라 밝은·어두운 화면 모두에서 읽힌다.
// 글은 이름표만(docs/UI_TERMS.md §1) — 설명 문장은 설명서 본문에 둔다. 서버 주소·토큰·사람 이름은 그림에 넣지 않는다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initWasm, Resvg } from '@resvg/resvg-wasm';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(root, 'web', 'help-assets');
const LIMIT = 150 * 1024;
const SCALE = 2;          // 그림 1px(논리) = PNG 2px — 고해상도 화면에서도 글이 또렷하게
const W = 880;            // 논리 폭(설명서 본문 폭에 맞춤)

// ── 색(web/help.css 와 같은 계열, docs/UI_TERMS.md §4: 보라 ✦ = AI 에게 보냄, 초록 ✓ = 완료) ──
const C = {
  ink: '#1f2f46', muted: '#5b697e', line: '#d5deeb', card: '#f6f8fc', white: '#ffffff',
  blue: '#225bc1', blueSoft: '#e7efff', purple: '#6741d9', purpleSoft: '#efe9ff',
  green: '#2b8a3e', greenSoft: '#e5f5e9', orange: '#a8510b', orangeSoft: '#fff0de',
  red: '#c92a2a', redSoft: '#ffe9e9', slate: '#2b3647', slateSoft: '#e9edf3', yellow: '#fff3bf',
};
const SANS = 'Pretendard';
const MONO = 'D2Coding';

// ── SVG 조각 ──
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const num = (v) => Math.round(v * 100) / 100;
function text(x, y, value, { size = 16, weight = 400, fill = C.ink, anchor = 'start', family = SANS, lh = 1.35 } = {}) {
  const lines = String(value).split('\n');
  const tspans = lines.map((l, i) => `<tspan x="${num(x)}" dy="${i ? num(size * lh) : 0}">${esc(l)}</tspan>`).join('');
  return `<text x="${num(x)}" y="${num(y)}" font-family="${family}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${tspans}</text>`;
}
const rect = (x, y, w, h, { rx = 10, fill = C.white, stroke = C.line, sw = 1.5, extra = '' } = {}) =>
  `<rect x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" rx="${rx}" fill="${fill}"${stroke ? ` stroke="${stroke}" stroke-width="${sw}"` : ''}${extra}/>`;
const line = (x1, y1, x2, y2, { stroke = C.line, sw = 2, extra = '' } = {}) =>
  `<line x1="${num(x1)}" y1="${num(y1)}" x2="${num(x2)}" y2="${num(y2)}" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round"${extra}/>`;
const circle = (cx, cy, r, { fill = C.white, stroke = null, sw = 2 } = {}) =>
  `<circle cx="${num(cx)}" cy="${num(cy)}" r="${num(r)}" fill="${fill}"${stroke ? ` stroke="${stroke}" stroke-width="${sw}"` : ''}/>`;
/** 오른쪽 화살표(머리 포함). label 은 위, below 는 아래 */
function arrow(x1, y, x2, { color = C.blue, label = '', below = '', sw = 3 } = {}) {
  const head = `<path d="M${num(x2)} ${num(y)} l-11 -7 v14 z" fill="${color}"/>`;
  let s = line(x1, y, x2 - 9, y, { stroke: color, sw }) + head;
  if (label) s += text((x1 + x2) / 2, y - 10, label, { size: 13, weight: 700, fill: color, anchor: 'middle' });
  if (below) s += text((x1 + x2) / 2, y + 21, below, { size: 12, fill: C.muted, anchor: 'middle' });
  return s;
}
/** 둥근 꼬리표(칩) — 글 폭은 대략(한글 1em, 그 밖 0.58em)으로 잰다 */
function textWidth(value, size) {
  let w = 0;
  for (const ch of String(value)) w += /[ㄱ-힣←-⯿✦✓●]/.test(ch) ? size : (/[A-Z]/.test(ch) ? size * 0.66 : size * 0.56);
  return w;
}
function chip(x, y, value, { fill = C.blueSoft, color = C.blue, size = 13, weight = 700, anchor = 'start', stroke = null } = {}) {
  const w = textWidth(value, size) + 20; const h = size + 12;
  const left = anchor === 'middle' ? x - w / 2 : anchor === 'end' ? x - w : x;
  return rect(left, y, w, h, { rx: h / 2, fill, stroke, sw: 1.2 }) + text(left + w / 2, y + h / 2 + size * 0.36, value, { size, weight, fill: color, anchor: 'middle' });
}
/** ✦(네 갈래 별) — 글꼴에 없는 글자라 도형으로 그린다(UI_TERMS §4 보라 ✦ = AI 에게 보냄) */
function sparkle(cx, cy, r, fill = '#fff') {
  const k = r * 0.28;
  return `<path d="M${num(cx)} ${num(cy - r)} Q${num(cx + k)} ${num(cy - k)} ${num(cx + r)} ${num(cy)} Q${num(cx + k)} ${num(cy + k)} ${num(cx)} ${num(cy + r)} Q${num(cx - k)} ${num(cy + k)} ${num(cx - r)} ${num(cy)} Q${num(cx - k)} ${num(cy - k)} ${num(cx)} ${num(cy - r)} z" fill="${fill}"/>`;
}
/** 상자 폭 안에 들도록 글 크기를 줄인다(여러 줄이면 가장 긴 줄 기준) */
const fit = (value, size, maxW) => Math.min(size, ...String(value).split('\n').map((l) => size * maxW / Math.max(1, textWidth(l, size))));
/** 바깥은 투명, 안은 밝은 카드 바탕 — 밝은·어두운 설명서 화면 모두에서 읽힌다 */
function svgDoc(h, body, { title = '' } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${h}" viewBox="0 0 ${W} ${h}">`
    + (title ? `<title>${esc(title)}</title>` : '')
    + rect(1, 1, W - 2, h - 2, { rx: 18, fill: C.card, stroke: C.line, sw: 1.5 }) + body + '</svg>';
}

// ── 아이콘(가운데 cx,cy, 대략 44px 상자) ──
const ICONS = {
  doc: (cx, cy, c = C.blue) => rect(cx - 15, cy - 20, 30, 40, { rx: 4, fill: C.white, stroke: c, sw: 2.2 })
    + line(cx - 8, cy - 9, cx + 8, cy - 9, { stroke: c, sw: 2 }) + line(cx - 8, cy - 1, cx + 8, cy - 1, { stroke: c, sw: 2 }) + line(cx - 8, cy + 7, cx + 3, cy + 7, { stroke: c, sw: 2 }),
  terminal: (cx, cy) => rect(cx - 21, cy - 16, 42, 32, { rx: 5, fill: C.slate, stroke: null })
    + `<path d="M${cx - 13} ${cy - 6} l7 6 l-7 6" fill="none" stroke="#9fe0b0" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>`
    + line(cx - 2, cy + 7, cx + 11, cy + 7, { stroke: '#ffffff', sw: 2.6 }),
  key: (cx, cy, c = C.blue) => circle(cx - 9, cy, 9, { fill: 'none', stroke: c, sw: 3 })
    + line(cx, cy, cx + 19, cy, { stroke: c, sw: 3 }) + line(cx + 13, cy, cx + 13, cy + 7, { stroke: c, sw: 3 }) + line(cx + 19, cy, cx + 19, cy + 8, { stroke: c, sw: 3 }),
  person: (cx, cy, c = C.blue) => circle(cx, cy - 9, 8, { fill: 'none', stroke: c, sw: 2.6 })
    + `<path d="M${cx - 15} ${cy + 18} q0 -16 15 -16 q15 0 15 16" fill="none" stroke="${c}" stroke-width="2.6" stroke-linecap="round"/>`,
  chat: (cx, cy, c = C.purple) => `<path d="M${cx - 20} ${cy - 14} h40 a5 5 0 0 1 5 5 v19 a5 5 0 0 1 -5 5 h-26 l-9 8 v-8 h-5 a5 5 0 0 1 -5 -5 v-19 a5 5 0 0 1 5 -5 z" fill="${C.white}" stroke="${c}" stroke-width="2.4" stroke-linejoin="round"/>`
    + circle(cx - 9, cy + 1, 2.6, { fill: c }) + circle(cx, cy + 1, 2.6, { fill: c }) + circle(cx + 9, cy + 1, 2.6, { fill: c }),
  check: (cx, cy, c = C.green) => circle(cx, cy, 18, { fill: c })
    + `<path d="M${cx - 8} ${cy} l6 6 l11 -12" fill="none" stroke="#fff" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/>`,
  plug: (cx, cy, c = C.blue) => rect(cx - 13, cy - 6, 26, 18, { rx: 5, fill: C.white, stroke: c, sw: 2.6 })
    + line(cx - 6, cy - 6, cx - 6, cy - 16, { stroke: c, sw: 3 }) + line(cx + 6, cy - 6, cx + 6, cy - 16, { stroke: c, sw: 3 }) + line(cx, cy + 12, cx, cy + 20, { stroke: c, sw: 3 }),
  lock: (cx, cy, c = C.blue) => `<path d="M${cx - 9} ${cy - 3} v-7 a9 9 0 0 1 18 0 v7" fill="none" stroke="${c}" stroke-width="2.8"/>`
    + rect(cx - 15, cy - 3, 30, 22, { rx: 4, fill: C.white, stroke: c, sw: 2.6 }) + circle(cx, cy + 8, 3, { fill: c }),
  bolt: (cx, cy, c = C.purple) => `<path d="M${cx + 3} ${cy - 20} l-14 23 h10 l-4 17 l15 -24 h-10 z" fill="${c}"/>`,
  list: (cx, cy, c = C.blue) => [-9, 0, 9].map((d) => circle(cx - 13, cy + d, 2.6, { fill: c }) + line(cx - 6, cy + d, cx + 15, cy + d, { stroke: c, sw: 2.6 })).join(''),
  coin: (cx, cy, c = C.orange) => circle(cx, cy, 18, { fill: C.orangeSoft, stroke: c, sw: 2.6 }) + text(cx, cy + 7, '₩', { size: 19, weight: 700, fill: c, anchor: 'middle' }),
  gear: (cx, cy, c = C.blue) => Array.from({ length: 8 }, (_, i) => `<rect x="${cx - 3}" y="${cy - 19}" width="6" height="9" rx="1.5" fill="${c}" transform="rotate(${i * 45} ${cx} ${cy})"/>`).join('')
    + circle(cx, cy, 12, { fill: C.white, stroke: c, sw: 3 }) + circle(cx, cy, 4, { fill: c }),
  window: (cx, cy, c = C.blue) => rect(cx - 21, cy - 16, 42, 32, { rx: 5, fill: C.white, stroke: c, sw: 2.4 })
    + line(cx - 21, cy - 7, cx + 21, cy - 7, { stroke: c, sw: 2 }) + circle(cx - 15, cy - 11.5, 1.8, { fill: c }) + circle(cx - 10, cy - 11.5, 1.8, { fill: c }),
  send: (cx, cy, c = C.purple) => circle(cx, cy, 18, { fill: c }) + sparkle(cx, cy, 10),
};

/**
 * 단계 그림: [아이콘 + 번호 + 제목 + 보조 글] 카드를 화살표로 잇는다.
 * steps: [{ icon, title, sub, mono, tone }] — tone 'result' 이면 파란 테두리(결과), 'ai' 면 보라.
 * tag: 오른쪽 위 꼬리표 { text, fill, color }. note: 아래 한 줄.
 */
function stepStrip({ steps, tag = null, note = '', heading = '', subHeading = '' }) {
  const pad = 24; const gap = 34; const n = steps.length;
  const top = heading ? 62 : 24;
  const cardW = (W - pad * 2 - gap * (n - 1)) / n;
  // 카드 높이 = 가장 긴 카드(제목 줄 수 + 보조 글 줄 수)에 맞춘다
  const lines = (v) => (v ? String(v).split('\n').length : 0);
  const cardH = Math.max(...steps.map((s) => 98 + lines(s.title) * 22 + (s.sub ? 6 + lines(s.sub) * 17.5 : 0) + 16));
  let body = '';
  if (heading) body += text(pad + 2, 38, heading, { size: 19, weight: 700 }) + (subHeading ? text(pad + 6 + textWidth(heading, 19) + 8, 38, subHeading, { size: 14, fill: C.muted }) : '');
  if (tag) body += chip(W - pad, heading ? 18 : 14, tag.text, { fill: tag.fill, color: tag.color, anchor: 'end', size: 13 });
  steps.forEach((s, i) => {
    const x = pad + i * (cardW + gap); const cx = x + cardW / 2;
    const result = s.tone === 'result'; const ai = s.tone === 'ai';
    body += rect(x, top, cardW, cardH, { rx: 14, fill: result ? C.blueSoft : C.white, stroke: result ? C.blue : ai ? C.purple : C.line, sw: result || ai ? 2.2 : 1.5 });
    body += (ICONS[s.icon] || ICONS.doc)(cx, top + 44);
    if (!result) body += circle(x + 20, top + 20, 12, { fill: ai ? C.purple : C.blue }) + text(x + 20, top + 25, String(i + 1), { size: 13, weight: 700, fill: '#fff', anchor: 'middle' });
    body += text(cx, top + 98, s.title, { size: fit(s.title, 17, cardW - 20), weight: 700, anchor: 'middle', lh: 1.28 });
    if (s.sub) {
      const titleLines = String(s.title).split('\n').length;
      body += text(cx, top + 98 + titleLines * 22 + 4, s.sub, { size: fit(s.sub, s.mono ? 13 : 13.5, cardW - 20), family: s.mono ? MONO : SANS, fill: s.mono ? C.slate : C.muted, anchor: 'middle', lh: 1.3 });
    }
    if (i < n - 1) body += arrow(x + cardW + 5, top + 44, x + cardW + gap - 4, { color: steps[i + 1].tone === 'result' ? C.blue : C.muted, sw: 2.6 });
  });
  let h = Math.ceil(top + cardH + 22);
  if (note) { body += text(W / 2, h + 6, note, { size: 14, fill: C.muted, anchor: 'middle' }); h += 30; }
  return { h, body };
}

// ── 그림들 ──

/** ① 전체 흐름: 문서에서 요청 → 내 PC 의 Codex·Claude Code 가 MCP 로 받음 → 제안이 문서로 → 사람이 반영 */
function aiFlow() {
  const top = 26; const boxH = 190; const h = 318;
  let b = '';
  const col = [24, 246, 468, 690]; const bw = 166;
  // 1. 문서 화면 + AI에게 맡기기
  b += rect(col[0], top, bw, boxH, { rx: 14 });
  b += rect(col[0] + 22, top + 20, 122, 112, { rx: 6, fill: C.white, stroke: C.line });
  for (let i = 0; i < 6; i++) b += line(col[0] + 34, top + 38 + i * 15, col[0] + (i === 5 ? 96 : 132), top + 38 + i * 15, { stroke: '#c9d3e1', sw: 4 });
  b += rect(col[0] + 30, top + 61, 106, 15, { rx: 3, fill: C.yellow, stroke: null }) + line(col[0] + 34, top + 68, col[0] + 132, top + 68, { stroke: '#b9a33a', sw: 4 });
  b += rect(col[0] + 18, top + 142, 130, 32, { rx: 8, fill: C.purple, stroke: null }) + sparkle(col[0] + 36, top + 158, 7) + text(col[0] + 91, top + 163, 'AI에게 맡기기', { size: 14, weight: 700, fill: '#fff', anchor: 'middle' });
  // 2. 내 PC — Codex · Claude Code
  b += rect(col[1], top, bw, boxH, { rx: 14, fill: C.purpleSoft, stroke: C.purple, sw: 2.2 });
  b += rect(col[1] + 20, top + 22, 126, 84, { rx: 8, fill: C.slate, stroke: null });
  b += `<path d="M${col[1] + 8} ${top + 112} h150 l-10 12 h-130 z" fill="#8a96a8"/>`;
  b += chip(col[1] + 83, top + 36, 'Codex', { fill: '#ffffff', color: C.slate, anchor: 'middle', size: 14 });
  b += chip(col[1] + 83, top + 68, 'Claude Code', { fill: '#ffffff', color: C.slate, anchor: 'middle', size: 14 });
  b += text(col[1] + 83, top + 150, '내 PC', { size: 16, weight: 700, anchor: 'middle', fill: C.purple });
  b += text(col[1] + 83, top + 172, 'ChatGPT·Claude 구독', { size: 13, fill: C.muted, anchor: 'middle' });
  // 3. 문서에 제안
  b += rect(col[2], top, bw, boxH, { rx: 14 });
  b += rect(col[2] + 22, top + 20, 122, 112, { rx: 6, fill: C.white, stroke: C.line });
  for (let i = 0; i < 2; i++) b += line(col[2] + 34, top + 38 + i * 15, col[2] + 132, top + 38 + i * 15, { stroke: '#c9d3e1', sw: 4 });
  b += line(col[2] + 34, top + 70, col[2] + 110, top + 70, { stroke: '#f0a3a3', sw: 4 }) + line(col[2] + 32, top + 70, col[2] + 112, top + 70, { stroke: C.red, sw: 1.6 });
  b += line(col[2] + 34, top + 86, col[2] + 124, top + 86, { stroke: '#8fd19e', sw: 4 });
  b += line(col[2] + 34, top + 104, col[2] + 132, top + 104, { stroke: '#c9d3e1', sw: 4 }) + line(col[2] + 34, top + 119, col[2] + 100, top + 119, { stroke: '#c9d3e1', sw: 4 });
  b += rect(col[2] + 18, top + 142, 130, 32, { rx: 8, fill: C.blueSoft, stroke: C.blue, sw: 1.5 }) + text(col[2] + 83, top + 163, '제안 · 메모', { size: 14, weight: 700, fill: C.blue, anchor: 'middle' });
  // 4. 사람이 반영
  b += rect(col[3], top, bw, boxH, { rx: 14 });
  b += ICONS.person(col[3] + 83, top + 52, C.ink);
  b += rect(col[3] + 16, top + 98, 64, 32, { rx: 8, fill: C.blue, stroke: null }) + text(col[3] + 48, top + 119, '반영', { size: 14, weight: 700, fill: '#fff', anchor: 'middle' });
  b += rect(col[3] + 86, top + 98, 64, 32, { rx: 8, fill: C.white, stroke: C.line }) + text(col[3] + 118, top + 119, '거절', { size: 14, weight: 700, fill: C.muted, anchor: 'middle' });
  b += ICONS.check(col[3] + 83, top + 160);
  // 화살표
  b += arrow(col[0] + bw + 6, top + 92, col[1] - 6, { label: 'MCP', below: '바로 알림', color: C.purple });
  b += arrow(col[1] + bw + 6, top + 92, col[2] - 6, { label: 'MCP', below: '제안 등록', color: C.purple });
  b += arrow(col[2] + bw + 6, top + 92, col[3] - 6, { color: C.blue });
  // 이름표
  const labels = ['① 문서에서 요청', '② 내 PC의 AI가 받음', '③ 제안이 문서로', '④ 내가 보고 반영'];
  labels.forEach((l, i) => { b += text(col[i] + bw / 2, top + boxH + 30, l, { size: 16, weight: 700, anchor: 'middle' }); });
  b += chip(col[1] + bw / 2, top + boxH + 44, '추가 비용 없음', { fill: C.greenSoft, color: C.green, anchor: 'middle', size: 12.5 });
  return { h, body: b, title: '문서에서 요청하면 내 PC의 Codex나 Claude Code가 MCP로 받아 처리하고, 제안이 문서로 돌아와 사람이 반영합니다' };
}

/** ② 실시간 처리 켜기 — Codex 줄 · Claude Code 줄 */
function realtimeSteps() {
  const pad = 24; const labelW = 132; const gap = 30; const rowH = 128; const top = 22;
  const rows = [
    { name: 'Codex', plan: 'ChatGPT 구독', steps: [
      { icon: 'person', title: '로그인', sub: 'codex login' },
      { icon: 'key', title: '토큰 저장', sub: 'setx … (한 번)' },
      { icon: 'terminal', title: '실행기 켜 두기', sub: 'start-codex-agent.bat' },
      { icon: 'check', title: 'Codex로 보내기', sub: '문서 화면에 보임', tone: 'result' }] },
    { name: 'Claude Code', plan: 'Claude 구독', steps: [
      { icon: 'person', title: '로그인', sub: 'claude auth login' },
      { icon: 'key', title: '토큰 저장', sub: 'setx … (한 번)' },
      { icon: 'terminal', title: '실행기 켜 두기', sub: 'start-claude-worker.bat' },
      { icon: 'check', title: 'Claude Code로 보내기', sub: '문서 화면에 보임', tone: 'result' }] },
  ];
  const n = 4; const x0 = pad + labelW + 14;
  const cardW = (W - x0 - pad - gap * (n - 1)) / n;
  let b = '';
  rows.forEach((r, ri) => {
    const y = top + ri * (rowH + 16);
    b += rect(pad, y, labelW, rowH, { rx: 14, fill: C.slate, stroke: null });
    b += text(pad + labelW / 2, y + rowH / 2 - 4, r.name, { size: r.name.length > 6 ? 17 : 20, weight: 700, fill: '#fff', anchor: 'middle' });
    b += text(pad + labelW / 2, y + rowH / 2 + 20, r.plan, { size: 13, fill: '#c8d2e0', anchor: 'middle' });
    r.steps.forEach((s, i) => {
      const x = x0 + i * (cardW + gap); const cx = x + cardW / 2; const result = s.tone === 'result';
      b += rect(x, y, cardW, rowH, { rx: 14, fill: result ? C.blueSoft : C.white, stroke: result ? C.blue : C.line, sw: result ? 2.2 : 1.5 });
      b += ICONS[s.icon](cx, y + 36);
      if (!result) b += circle(x + 18, y + 18, 11, { fill: C.blue }) + text(x + 18, y + 22.5, String(i + 1), { size: 12, weight: 700, fill: '#fff', anchor: 'middle' });
      b += text(cx, y + 84, s.title, { size: fit(s.title, 16, cardW - 22), weight: 700, anchor: 'middle', fill: result ? C.blue : C.ink });
      b += text(cx, y + 106, s.sub, { size: fit(s.sub, 12.5, cardW - 12), family: result ? SANS : MONO, fill: result ? C.muted : C.slate, anchor: 'middle' });
      if (i < n - 1) b += arrow(x + cardW + 4, y + 36, x + cardW + gap - 3, { color: r.steps[i + 1].tone === 'result' ? C.blue : C.muted, sw: 2.4 });
    });
  });
  const h = top + rows.length * (rowH + 16) + 26;
  b += text(W / 2, h - 18, '창을 켜 두면 새 요청을 바로 처리 · 끄면 요청은 대기열에서 기다림', { size: 14, fill: C.muted, anchor: 'middle' });
  return { h, body: b, title: 'Codex는 codex login, 토큰 저장, start-codex-agent.bat 실행. Claude Code는 claude auth login, 토큰 저장, start-claude-worker.bat 실행. 켜 두면 문서 화면에 보낼 곳이 보입니다' };
}

/** ③ VS Code 에서 붙여넣는 곳 — 터미널 · 설정 파일 · AI 대화창 */
function vscodePlaces() {
  const h = 420; const x = 24; const y = 20; const w = W - 48; const hh = 340;
  let b = '';
  // 창 틀
  b += rect(x, y, w, hh, { rx: 12, fill: '#1e2430', stroke: '#11151c', sw: 1.5 });
  b += rect(x, y, w, 30, { rx: 12, fill: '#2a3140', stroke: null }) + rect(x, y + 18, w, 12, { rx: 0, fill: '#2a3140', stroke: null });
  [0, 1, 2].forEach((i) => { b += circle(x + 18 + i * 16, y + 15, 5, { fill: ['#ff6b6b', '#fcc419', '#51cf66'][i] }); });
  b += text(x + w / 2, y + 20, 'VS Code', { size: 13, fill: '#c3cbd8', anchor: 'middle' });
  // 왼쪽 활동 막대
  b += rect(x, y + 30, 40, hh - 30, { rx: 0, fill: '#252b37', stroke: null });
  [0, 1, 2, 3].forEach((i) => { b += rect(x + 11, y + 48 + i * 36, 18, 18, { rx: 4, fill: i === 0 ? '#8ea2c2' : '#4b5567', stroke: null }); });
  // 편집기(가운데) — config.toml
  const ex = x + 40; const ew = 470; const ey = y + 30; const eh = 186;
  b += rect(ex, ey, ew, 28, { rx: 0, fill: '#262d3a', stroke: null });
  b += rect(ex, ey, 128, 28, { rx: 0, fill: '#1e2430', stroke: null }) + text(ex + 14, ey + 19, 'config.toml', { size: 13, family: MONO, fill: '#e3e8f0' });
  const code = [['[mcp_servers.hwpx]', '#82aaff'], ['url = "…/mcp?agent=Codex"', '#c3e88d'], ['bearer_token_env_var = "HWPX_COWORK_TOKEN"', '#c3e88d']];
  code.forEach(([t, c], i) => { b += text(ex + 18, ey + 60 + i * 26, t, { size: 14, family: MONO, fill: c }); });
  // 터미널(아래)
  const ty = ey + eh; const th = y + hh - ty;
  b += rect(ex, ty, ew, th, { rx: 0, fill: '#161a22', stroke: null }) + line(ex, ty, ex + ew, ty, { stroke: '#3a4354', sw: 1.5 });
  b += text(ex + 14, ty + 22, '터미널', { size: 12.5, fill: '#9aa6b8' });
  b += text(ex + 14, ty + 50, 'PS> codex mcp add hwpx --url …', { size: 14, family: MONO, fill: '#e3e8f0' });
  b += text(ex + 14, ty + 76, 'PS> claude mcp add … hwpx …', { size: 14, family: MONO, fill: '#e3e8f0' });
  b += text(ex + 14, ty + 102, 'PS> start-codex-agent.bat', { size: 14, family: MONO, fill: '#e3e8f0' });
  // AI 대화창(오른쪽)
  const px = ex + ew; const pw = x + w - px; const py = y + 30; const ph = hh - 30;
  b += rect(px, py, pw, ph, { rx: 0, fill: '#232a36', stroke: null }) + line(px, py, px, py + ph, { stroke: '#3a4354', sw: 1.5 });
  b += text(px + 16, py + 24, 'Codex · Claude Code', { size: 13, weight: 700, fill: '#e3e8f0' });
  b += rect(px + 60, py + 48, pw - 76, 40, { rx: 12, fill: C.purple, stroke: null }) + text(px + 60 + (pw - 76) / 2, py + 73, '대기열을 처리해 줘', { size: 15, weight: 700, fill: '#fff', anchor: 'middle' });
  b += rect(px + 16, py + 100, pw - 80, 58, { rx: 12, fill: '#323b4b', stroke: null });
  b += text(px + 30, py + 124, '요청 2건을 처리했어요.', { size: 13, fill: '#dfe5ee' }) + text(px + 30, py + 145, '제안 3건 · 메모 1건', { size: 13, fill: '#aab6c8' });
  b += rect(px + 14, py + ph - 52, pw - 28, 38, { rx: 10, fill: '#1b212b', stroke: '#47526a', sw: 1.2 }) + text(px + 28, py + ph - 27, '여기에 입력', { size: 13, fill: '#7d8899' });
  // 번호 표시
  const badge = (bx, by, n, label) => circle(bx, by, 15, { fill: '#ffd43b', stroke: '#1e2430', sw: 2 }) + text(bx, by + 5.5, n, { size: 15, weight: 700, fill: '#1e2430', anchor: 'middle' })
    + text(bx + 22, by + 5, label, { size: 15, weight: 700, fill: C.ink });
  b += badge(x + 22, y + hh + 34, '1', '터미널 — 명령 붙여넣기');
  b += badge(x + 300, y + hh + 34, '2', '설정 파일 — 직접 고칠 때만');
  b += badge(x + 588, y + hh + 34, '3', 'AI 대화창 — 한마디로 처리');
  // 그림 위 번호(작게)
  const mini = (bx, by, n) => circle(bx, by, 12, { fill: '#ffd43b', stroke: '#1e2430', sw: 1.6 }) + text(bx, by + 4.5, n, { size: 13, weight: 700, fill: '#1e2430', anchor: 'middle' });
  b += mini(ex + ew - 20, ty + 20, '1') + mini(ex + ew - 20, ey + 46, '2') + mini(px + pw - 22, py + 22, '3');
  return { h, body: b, title: 'VS Code의 터미널에 명령을 붙여넣고, 설정 파일은 직접 고칠 때만 열고, Codex나 Claude Code 대화창에 대기열을 처리해 줘라고 입력합니다' };
}

const FIGURES = [
  { name: 'ai-flow', build: aiFlow },
  { name: 'realtime-steps', build: realtimeSteps },
  { name: 'vscode-places', build: vscodePlaces },
  { name: 'request-steps', build: () => ({ ...stepStrip({ steps: [
      { icon: 'doc', title: '글 고르기', sub: '또는 문단에서 우클릭' },
      { icon: 'send', title: 'AI에게 맡기기', sub: '할 일 적기\n비우면 검토', tone: 'ai' },
      { icon: 'list', title: 'AI 작업 탭', sub: '‘확인 필요’가 되면' },
      { icon: 'check', title: '반영 · 거절', sub: '내가 정함', tone: 'result' }],
    note: 'AI가 끝내도 문서 글은 그대로 — 반영은 사람이 합니다' }), title: '글을 고르고 AI에게 맡기기를 누른 뒤, AI 작업 탭에서 확인 필요가 되면 반영하거나 거절합니다' }) },
  { name: 'chatgpt-steps', build: () => ({ ...stepStrip({ heading: 'ChatGPT 웹', subHeading: '고급 · 필요할 때만', tag: { text: '공개 https 주소 필요', fill: C.slateSoft, color: C.slate }, steps: [
      { icon: 'plug', title: '사용자 지정\nMCP 서버 추가', sub: 'ChatGPT 플러그인' },
      { icon: 'window', title: '서버 URL 넣기', sub: '인증: OAuth' },
      { icon: 'lock', title: '내 토큰으로 허용', sub: 'HWPX 확인 화면' },
      { icon: 'chat', title: '“대기열을\n처리해 줘”', sub: '대화를 보낼 때 처리', tone: 'ai' }],
    note: '실시간이 아닙니다 — 대화창에서 말할 때마다 쌓인 요청을 처리합니다' }), title: 'ChatGPT 웹: 사용자 지정 MCP 서버를 추가하고, 서버 URL과 OAuth를 넣고, HWPX 확인 화면에서 토큰으로 허용한 뒤 대기열을 처리해 줘라고 말합니다' }) },
  { name: 'api-key', build: () => ({ ...stepStrip({ heading: 'API 키', subHeading: '선택 · 유료', tag: { text: '쓴 만큼 API 요금', fill: C.orangeSoft, color: C.orange }, steps: [
      { icon: 'gear', title: '내 AI 키', sub: '문서 목록 화면' },
      { icon: 'key', title: 'API 키 붙여넣기', sub: 'API 제공업체에서 발급' },
      { icon: 'check', title: '저장 · 연결 확인', sub: '확인은 요금 없음' },
      { icon: 'coin', title: '서버가 바로 처리', sub: '내 키로 요금 청구', tone: 'result' }],
    note: '설치는 없지만 구독과 별도로 비용이 듭니다' }), title: 'API 키: 문서 목록의 내 AI 키에서 키를 붙여넣고 저장, 연결 확인을 누르면 서버가 내 키로 바로 처리합니다. 사용한 만큼 요금이 듭니다' }) },
];

// ── 글꼴 준비(woff2 → otf/ttf, Python fontTools) ──
const FONT_FILES = ['Pretendard-Regular', 'Pretendard-SemiBold', 'Pretendard-Bold', 'D2Coding-Regular'];
const FONT_DIRS = [path.join(root, 'vendor', 'rhwp', 'assets', 'fonts'), path.join(root, 'studio', 'dist', 'fonts')];
const PY_FONT = 'import sys\nfrom fontTools.ttLib import TTFont\nf = TTFont(sys.argv[1])\nf.flavor = None\nf.save(sys.argv[2])\n';
const PY_WEBP = [
  'import os, sys', 'from PIL import Image',
  'src, dst, limit = sys.argv[1], sys.argv[2], int(sys.argv[3])',
  'im = Image.open(src); im.load()',
  // 무손실이 작으면 그대로, 크면 손실 압축(글자가 뭉개지지 않게 높은 품질)으로
  'im.save(dst, "WEBP", lossless=True, quality=100, method=6)',
  'mode = "lossless"',
  'if os.path.getsize(dst) > limit:',
  '    for q in (92, 88, 84, 80):',
  '        im.save(dst, "WEBP", quality=q, method=6, alpha_quality=100)',
  '        mode = f"q{q}"',
  '        if os.path.getsize(dst) <= limit: break',
  'print(os.path.getsize(dst), im.size[0], im.size[1], mode)',
].join('\n');
function python(code, args) {
  const r = spawnSync(process.env.PYTHON || 'python', ['-I', '-c', code, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`python 실패: ${(r.stderr || r.error?.message || '').trim()}`);
  return r.stdout.trim();
}
function prepareFonts(cacheDir) {
  fs.mkdirSync(cacheDir, { recursive: true });
  return FONT_FILES.map((name) => {
    const src = FONT_DIRS.map((d) => path.join(d, `${name}.woff2`)).find((f) => fs.existsSync(f));
    if (!src) throw new Error(`글꼴이 없습니다: ${name}.woff2`);
    const out = path.join(cacheDir, `${name}.font`);
    if (!fs.existsSync(out) || fs.statSync(out).mtimeMs < fs.statSync(src).mtimeMs) python(PY_FONT, [src, out]);
    return new Uint8Array(fs.readFileSync(out));
  });
}

async function main() {
  const svgOut = (() => { const i = process.argv.indexOf('--svg'); return i > 0 ? path.resolve(process.argv[i + 1]) : null; })();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-help-visuals-'));
  try {
    await initWasm(fs.readFileSync(require.resolve('@resvg/resvg-wasm/index_bg.wasm')));
    const fontBuffers = prepareFonts(path.join(os.tmpdir(), 'hwpx-help-visual-fonts'));
    fs.mkdirSync(OUT, { recursive: true });
    if (svgOut) fs.mkdirSync(svgOut, { recursive: true });
    const report = [];
    for (const fig of FIGURES) {
      const { h, body, title } = fig.build();
      const svg = svgDoc(h, body, { title });
      if (svgOut) fs.writeFileSync(path.join(svgOut, `${fig.name}.svg`), svg);
      const r = new Resvg(svg, { font: { fontBuffers, loadSystemFonts: false, defaultFontFamily: SANS, sansSerifFamily: SANS, monospaceFamily: MONO },
        fitTo: { mode: 'width', value: W * SCALE }, shapeRendering: 2, textRendering: 1 });
      const png = r.render().asPng(); r.free();
      const pngPath = path.join(tmp, `${fig.name}.png`);
      fs.writeFileSync(pngPath, png);
      // 다 만든 뒤 한 번에 바꿔 쓴다 — 운영 서버가 web/ 을 바로 내보내므로 반쯤 쓴 파일을 보이지 않게
      const tmpWebp = path.join(tmp, `${fig.name}.webp`);
      const [bytes, pw, ph, mode] = python(PY_WEBP, [pngPath, tmpWebp, String(LIMIT - 1024)]).split(/\s+/);
      if (Number(bytes) >= LIMIT) throw new Error(`${fig.name}.webp 가 너무 큽니다(${bytes}B)`);
      const dest = path.join(OUT, `${fig.name}.webp`);
      fs.copyFileSync(tmpWebp, `${dest}.tmp`); fs.renameSync(`${dest}.tmp`, dest);
      report.push({ file: `web/help-assets/${fig.name}.webp`, bytes: Number(bytes), px: `${pw}x${ph}`, css: `${W}x${h}`, mode });
    }
    for (const r of report) console.log(`${r.file}  ${(r.bytes / 1024).toFixed(1)}KB  ${r.px}px (화면 ${r.css})  ${r.mode}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
