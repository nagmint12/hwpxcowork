// SVG 그림 → 문서에 넣을 PNG(그림 제안 propose_figure 의 svg). 도식·흐름도·개념도·표 그림처럼 차트(server/chart.js)로 못 그리는
// 그림을 AI 가 SVG 글로 주면 서버가 PNG 로 그린다 — 한/글은 SVG 그림을 넣지 않으므로 PNG 로 넣고, SVG 원문은 첨부로 남긴다.
//   그리기: resvg(WASM, @resvg/resvg-wasm)를 그림마다 별도 스레드(figure-svg-worker.js)에서, 시간 제한(기본 30초)을 두고.
//   글꼴: 서버 PC 의 한글 글꼴 한 벌(보고서 글꼴 KoPubWorld돋움체 → Noto Sans KR → 맑은 고딕 → 나눔고딕 → Noto Sans CJK 순으로 찾음,
//         config.figures.fontFiles 로 바꿀 수 있음). SVG 의 font-family 가 없는 글꼴이면 이 글꼴로 그린다.
//   크기: widthMm(문서에 보일 폭)을 주면 그 폭, 없으면 SVG 고유 폭(96dpi) — 300dpi PNG 로 그린다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

export const SVG_MAX_CHARS = 400000;

export class FigureError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/** SVG 글 검사·정리 → 그릴 SVG 글. 코드 울타리(```svg)를 벗기고, 빠진 xmlns 를 채운다. DTD(엔터티)는 받지 않는다 */
export function normSvg(raw) {
  let s = String(raw ?? '').replace(/^﻿/, '').trim();
  const fence = /^```[A-Za-z]*\s*\n([\s\S]*?)\n?```$/.exec(s);
  if (fence) s = fence[1].trim();
  if (!s) throw new FigureError('BAD_SVG', 'SVG 글이 비어 있습니다');
  if (s.length > SVG_MAX_CHARS) throw new FigureError('BAD_SVG', `SVG 가 너무 깁니다(최대 ${SVG_MAX_CHARS}자) — 반복 도형은 <use> 로 줄이세요`);
  if (/<!DOCTYPE|<!ENTITY/i.test(s)) throw new FigureError('BAD_SVG', 'SVG 에 DOCTYPE·ENTITY 는 쓸 수 없습니다');
  const open = /<svg\b[^>]*>/i.exec(s);
  if (!open || !/<\/svg\s*>\s*$/i.test(s)) throw new FigureError('BAD_SVG', 'SVG 문서(<svg …>…</svg>)가 아닙니다');
  let tag = open[0];
  if (!/\sxmlns\s*=/.test(tag)) tag = tag.replace(/^<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  if (/xlink:/.test(s) && !/\sxmlns:xlink\s*=/.test(tag)) tag = tag.replace(/^<svg\b/i, '<svg xmlns:xlink="http://www.w3.org/1999/xlink"');
  return s.slice(0, open.index) + tag + s.slice(open.index + open[0].length);
}

// 한글 글꼴 한 벌 [보통, 굵게] — 파일 이름(소문자) 후보
const FAMILIES = [
  [['kopubworld dotum medium.ttf', 'kopubworlddotummedium.ttf', 'kopubworld dotum_pro medium.otf'], ['kopubworld dotum bold.ttf', 'kopubworlddotumbold.ttf', 'kopubworld dotum_pro bold.otf']],
  [['notosanskr-regular.otf', 'notosanskr-regular.ttf', 'notosanskr-vf.ttf', 'notosanskr[wght].ttf'], ['notosanskr-bold.otf', 'notosanskr-bold.ttf']],
  [['malgun.ttf'], ['malgunbd.ttf']],
  [['nanumgothic.ttf', 'nanumgothic.otf'], ['nanumgothicbold.ttf', 'nanumgothicbold.otf']],
  [['notosanscjkkr-regular.otf', 'notosanscjk-regular.ttc'], ['notosanscjkkr-bold.otf', 'notosanscjk-bold.ttc']],
];

function fontDirs(env = process.env) {
  const home = os.homedir();
  const dirs = [];
  if (env.WINDIR || env.SystemRoot) dirs.push(path.join(env.WINDIR || env.SystemRoot, 'Fonts'));
  if (env.LOCALAPPDATA) dirs.push(path.join(env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts'));
  dirs.push('/usr/share/fonts', '/usr/local/share/fonts', path.join(home, '.local', 'share', 'fonts'), path.join(home, '.fonts'),
    '/Library/Fonts', path.join(home, 'Library', 'Fonts'), '/System/Library/Fonts');
  return dirs;
}

/** 글꼴 폴더들의 파일 → Map(소문자 이름 → 경로). 하위 폴더는 4단계까지 */
function fontIndex(dirs) {
  const index = new Map();
  const walk = (dir, depth) => {
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < 4) walk(full, depth + 1); }
      else if (/\.(ttf|otf|ttc)$/i.test(e.name) && !index.has(e.name.toLowerCase())) index.set(e.name.toLowerCase(), full);
    }
  };
  for (const d of dirs) walk(d, 0);
  return index;
}

let cachedFonts = null;
/** 그릴 때 쓸 글꼴 파일들(첫 번째로 찾은 한글 글꼴 한 벌). config.figures.fontFiles 가 있으면 그것 */
export function figureFonts(cfg = null) {
  const given = cfg?.figures?.fontFiles;
  if (Array.isArray(given) && given.length) return given.map(String).filter((f) => fs.existsSync(f));
  if (cachedFonts) return cachedFonts;
  const index = fontIndex(fontDirs());
  cachedFonts = [];
  for (const [regular, bold] of FAMILIES) {
    const r = regular.map((n) => index.get(n)).find(Boolean);
    if (!r) continue;
    const b = bold.map((n) => index.get(n)).find(Boolean);
    cachedFonts = b ? [r, b] : [r];
    break;
  }
  return cachedFonts;
}

/**
 * SVG(normSvg 결과) → { png: Buffer, width, height(픽셀), widthMm(보일 폭) }.
 * widthMm 을 주면 그 폭(10~maxWidthMm), 아니면 SVG 고유 폭. dpi = 보일 폭 기준 해상도(문서에 넣을 그림 300, 미리보기는 낮게).
 * 실패하면 FigureError(BAD_SVG·SVG_TIMEOUT·SVG_UNAVAILABLE)
 */
export function renderSvg(svg, { widthMm = null, maxWidthMm = 300, dpi = 300, cfg = null, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(new URL('./figure-svg-worker.js', import.meta.url), { workerData: { svg, widthMm, maxWidthMm, dpi, fonts: figureFonts(cfg) }, resourceLimits: { maxOldGenerationSizeMb: 512 } });
    } catch (e) { reject(new FigureError('SVG_UNAVAILABLE', `서버에서 SVG 를 그릴 수 없습니다: ${e.message}`)); return; }
    let done = false;
    const finish = (fn) => { if (done) return; done = true; clearTimeout(timer); worker.terminate().catch(() => {}); fn(); };
    const timer = setTimeout(() => finish(() => reject(new FigureError('SVG_TIMEOUT', `SVG 를 ${Math.round(timeoutMs / 1000)}초 안에 그리지 못했습니다 — 도형·효과(필터)를 줄이세요`))), timeoutMs);
    worker.once('message', (m) => finish(() => {
      if (!m?.ok) {
        const message = String(m?.message || '').replace(/\s+/g, ' ').slice(0, 300);
        reject(new FigureError('BAD_SVG', `SVG 를 그리지 못했습니다${message ? `: ${message}` : ''} — 올바른 SVG 문서인지(닫는 태그·xmlns·viewBox) 확인하세요`));
        return;
      }
      resolve({ png: Buffer.from(m.png), width: m.width, height: m.height, widthMm: m.widthMm });
    }));
    worker.once('error', (e) => finish(() => reject(new FigureError('SVG_UNAVAILABLE', `서버에서 SVG 를 그릴 수 없습니다: ${e.message}`))));
    worker.once('exit', (code) => finish(() => reject(new FigureError('SVG_UNAVAILABLE', `SVG 그리기가 끝나지 못했습니다(코드 ${code})`))));
  });
}
