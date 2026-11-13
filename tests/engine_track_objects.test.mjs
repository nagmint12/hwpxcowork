// node --test tests/engine_track_objects.test.mjs — 표·그림·차트·도형 변경 추적(2026-10-30, 엔진).
//  - 파서: 개체를 감싼 변경 표식을 hp:t 안·run 단계 두 꼴 모두 읽어 개체 anchor 에 ins/del, 개체에 붙은 표식(attach), 지운 개체 안 문단은 ref '/d'
//  - changes(): kind 'object'·'mixed', objects, label('표 지움'·'그림 넣음'·'글과 표 지움' …)
//  - 최종본 보기(paragraphs·bodyEntries·tables·figures·objectPrint·diffDocs): 지운 개체와 그 안은 없다 — 평탄화 사본(작업본)과 같다
//    (불변식: diffDocs(D, D.viewerCopy()) 덩어리 0 — 편집기(rhwp) 왕복 뒤에도, 최종본 ref = 평탄화 사본 ref)
//  - 수락·거절: 개체째(캡션·칸·그림 파일·차트 부분·안의 변경) 지우거나 표식만 지운다. 모두 거절 = 원래 본문
//  - 붙은 표식 옆 글 편집(지우기·넣기·메모)은 개체를 감싸지 않고 OVERLAP·CTRL_INSIDE 로 막히지 않는다
//  - resolveChanges: 안에 변경이 든 개체를 지워 번호가 밀려도 남은 변경을 제대로 푼다
// 표식은 손으로 넣는다(wrap) — 한/글 실측 꼴이 정해지면 쓰는 쪽(engine/track-objects.js)만 바뀐다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HwpxDoc, diffDocs } from '../engine/doc.js';
import { Section } from '../engine/section.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (n) => fs.readFileSync(path.join(here, 'fixtures', n));
const RHWP = path.join(here, '..', 'vendor', 'rhwp', 'pkg');
const hasRhwp = fs.existsSync(path.join(RHWP, 'rhwp_bg.wasm'));
let rhwpMod = null;
const rhwp = () => (rhwpMod ??= (async () => {
  globalThis.measureTextWidth ??= (font, text) => text.length * 10;
  const mod = await import(pathToFileURL(path.join(RHWP, 'rhwp.js')).href);
  if (!(globalThis.__rhwpEngineReady ??= new Set()).has(RHWP)) {
    const wasm = fs.readFileSync(path.join(RHWP, 'rhwp_bg.wasm'));
    if (typeof mod.initSync === 'function') mod.initSync({ module: wasm }); else await mod.default({ module_or_path: wasm });
    globalThis.__rhwpEngineReady.add(RHWP);
  }
  return mod;
})());
const AUTHOR = '검토자';
const DATE = new Date(Date.UTC(2026, 9, 30, 1, 2, 3));
const reload = async (d) => HwpxDoc.load(await d.save());

// ───────── 시험 도우미 ─────────

/** 단색 PNG(w×h) */
function png(w, h, rgb = [200, 30, 30]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const t = Buffer.from(type, 'ascii'); const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => rgb).flat())]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

/** 문단 ref 의 k 번째 개체 anchor(표·그림·차트·도형 — 최종본에서 지운 것도) */
function objAt(d, ref, k = 0) { return d.resolve(ref).p.anchors.filter((a) => Section.isObject(a))[k]; }

/**
 * 손으로 넣는 개체 변경 표식: 문단 ref 의 k 번째 개체를 type('Insert'|'Delete') 표식으로 감싼다 → 변경 id.
 * style 't' = 개체 앞뒤의 빈 hp:t 안(엔진 자리표시 꼴), 'run' = run 의 직접 자식, 'share' = 앞뒤 글의 hp:t 안(앞 hp:t 끝·뒤 hp:t 머리 — 글과 같은 hp:t)
 */
function wrap(d, ref, k, type, style = 't', author = AUTHOR) {
  const id = d.header.addChange(type, d.header.ensureAuthor(author), DATE);
  if (!d.trackingEnabled()) d.setTracking(true);
  const b = type === 'Insert' ? 'insert' : 'delete';
  const B = `<hp:${b}Begin Id="${id}" TcId="${id}"/>`; const E = `<hp:${b}End Id="${id}" TcId="${id}" paraend="0"/>`;
  const { sec } = d.resolve(ref); const a = objAt(d, ref, k);
  let xml;
  if (style === 'share') {
    const before = sec.xml.lastIndexOf('</hp:t>', a.start); const after = sec.xml.indexOf('<hp:t>', a.end);
    assert.ok(before > 0 && sec.xml.slice(before + 7, a.start) === '' && after === a.end, 'share: 개체 앞뒤가 글 hp:t');
    xml = sec.xml.slice(0, before) + B + sec.xml.slice(before, a.end + 6) + E + sec.xml.slice(a.end + 6);
  } else {
    const pre = style === 't' ? `<hp:t>${B}</hp:t>` : B; const post = style === 't' ? `<hp:t>${E}</hp:t>` : E;
    xml = sec.xml.slice(0, a.start) + pre + sec.xml.slice(a.start, a.end) + post + sec.xml.slice(a.end);
  }
  sec.load(xml);
  return id;
}

/** 문단 ref 의 글자 ci(p.chars 번호) 앞('before')·뒤('after') 원문 자리에 xml 을 그대로 끼운다 */
function inject(d, ref, ci, side, xml) {
  const { sec, p } = d.resolve(ref);
  const pos = side === 'before' ? p.chars[ci].raw[0] : p.chars[ci].raw[1];
  sec.load(sec.xml.slice(0, pos) + xml + sec.xml.slice(pos));
}

/** 줄 정보(다시 잰다)를 뺀 구역 XML */
const body = (d) => d.sections.map((s) => s.xml.replace(/<hp:linesegarray>[\s\S]*?<\/hp:linesegarray>|<hp:linesegarray\/>/g, ''));
const marks = (d) => d.sections.reduce((n, s) => n + (s.xml.match(/<hp:(?:insert|delete)(?:Begin|End)\b/g) || []).length, 0);
const rows = (d, view) => d.paragraphs(view ? { view } : undefined).map((p) => [p.ref, p.text]);
const changeRows = (d) => d.changes().map((c) => [c.id, c.type, c.ref, c.kind ?? null, c.label ?? null, c.text]);

/** 표 문단 s0/p1(캡션 '시험 표', 가·나/다·라) — floating 이면 글 감싸기(treatAsChar 0). keepCaption 이면 캡션 제목 넣음 변경을 남긴다 */
async function tableDoc({ floating = false, keepCaption = false, second = false } = {}) {
  const d = await (await HwpxDoc.load(fx('tool_memo_tracked.hwpx'))).flattened();
  d.insertTableAfter(0, 0, { rows: [['가', '나'], ['다', '라']], headerRows: 1, caption: '시험 표' }, { author: '작성자', date: DATE });
  if (second) {
    // 같은 문단에 둘째 표(마·바) — 첫 표를 지워도 둘째 표 칸 번호(n·#t)가 평탄화 사본과 같아야 한다
    const t2 = d.insertTableAfter(0, 1, { rows: [['마', '바']], headerRows: 0 }, { author: '작성자', date: DATE });
    const sec = d.sections[0]; const ip = d.resolve(t2.ref).p;
    const tbl = /<hp:tbl\b[\s\S]*<\/hp:tbl>/.exec(sec.xml.slice(ip.start, ip.end))[0];
    sec.load(sec.xml.slice(0, ip.start) + sec.xml.slice(ip.end));
    const p = d.resolve('s0/p1').p;
    sec.load(sec.xml.slice(0, p.end).replace(/<\/hp:tbl><hp:t\/><\/hp:run>(?![\s\S]*<\/hp:tbl><hp:t\/><\/hp:run>)/, `</hp:tbl>${tbl}<hp:t/></hp:run>`) + sec.xml.slice(p.end));
  }
  if (!keepCaption) d.acceptAll();
  if (floating) { const sec = d.sections[0]; sec.load(sec.xml.replace(/(<hp:tbl\b[\s\S]*?<hp:pos\b[^>]*\btreatAsChar=")1"/g, '$10"')); }
  return reload(d);
}

/** '앞 글' + 표 + '뒤 글' 문단 s0/p1 */
async function textTableDoc() {
  const d = await tableDoc();
  const { sec, p } = d.resolve('s0/p1');
  const x = sec.xml.slice(p.start, p.end)
    .replace(/^(<hp:p\b[^>]*><hp:run\b[^>]*>)(<hp:tbl\b)/, '$1<hp:t>앞 글</hp:t>$2')
    .replace(/<\/hp:tbl><hp:t\/><\/hp:run>/, '</hp:tbl><hp:t>뒤 글</hp:t></hp:run>');
  sec.load(sec.xml.slice(0, p.start) + x + sec.xml.slice(p.end));
  assert.equal(d.text('s0/p1'), '앞 글뒤 글');
  return reload(d);
}

/** 그림 문단 s0/p1(캡션 '시험 그림') */
async function pictureDoc() {
  const d = await (await HwpxDoc.load(fx('tool_memo_tracked.hwpx'))).flattened();
  d.insertPictureAfter(0, 0, { data: png(40, 20), caption: '시험 그림' }, { author: '작성자', date: DATE });
  d.acceptAll();
  return reload(d);
}

/**
 * 최종본 보기 불변식: 최종본 ref·글 = 평탄화 사본, bodyEntries·표·그림·개체 지문이 같고, diffDocs(D, viewerCopy) 덩어리 0 → viewerCopy
 */
async function invariants(d, label) {
  const f = await d.flattened();
  assert.deepEqual(rows(d), rows(f), `${label}: 최종본 ref·글 = 평탄화 사본`);
  assert.deepEqual(d.bodyEntries(), f.bodyEntries(), `${label}: bodyEntries`);
  assert.deepEqual(d.tables(), f.tables(), `${label}: tables`);
  assert.deepEqual(d.figures().map((x) => [x.ref, x.n, x.width, x.height, x.caption]), f.figures().map((x) => [x.ref, x.n, x.width, x.height, x.caption]), `${label}: figures`);
  for (const p of f.paragraphs()) assert.equal(d.objectPrint(p.ref), f.objectPrint(p.ref), `${label}: objectPrint ${p.ref}`);
  const v = await d.viewerCopy();
  const r = await diffDocs(d, v);
  assert.deepEqual(r.hunks, [], `${label}: diffDocs(D, viewerCopy)`);
  assert.deepEqual(r.unsupported, [], `${label}: diffDocs unsupported`);
  const vt = await d.viewerCopy({ tolerant: true });
  assert.deepEqual((await diffDocs(d, vt)).hunks, [], `${label}: tolerant viewerCopy`);
  return v;
}

/** 편집기(rhwp) 왕복: viewerCopy → rhwp → exportHwpx → diffDocs(D, 그것) 덩어리 0(사본끼리의 왕복 차이와 같다) */
async function rhwpRoundTrip(d, v, label) {
  if (!hasRhwp) return;
  const mod = await rhwp();
  const doc = new mod.HwpDocument(new Uint8Array(await v.save()));
  const back = await HwpxDoc.load(Buffer.from(doc.exportHwpx()));
  const base = (await diffDocs(v, back)).hunks.map((h) => [h.type, h.ref]);
  assert.deepEqual(base, [], `${label}: 편집기 왕복(사본)`);
  assert.deepEqual((await diffDocs(d, back)).hunks.map((h) => [h.type, h.ref]), [], `${label}: 편집기 왕복 diffDocs(D, back)`);
}

// ───────── 파서 ─────────

test('파서: hp:t 안·run 단계 표식 모두 개체 anchor 에 ins/del, 개체에 붙은 표식, 지운 표 안 문단은 /d ref', async () => {
  for (const style of ['t', 'run', 'share']) {
    const d = style === 'share' ? await textTableDoc() : await tableDoc();
    const id = wrap(d, 's0/p1', 0, 'Delete', style);
    const { p } = d.resolve('s0/p1');
    const tbl = objAt(d, 's0/p1');
    assert.equal(tbl.del, String(id), style);
    assert.equal(tbl.ins, null, style);
    const ms = Section.changeMarks(p);
    assert.deepEqual(ms.map((m) => [m.name, m.level, !!m.attach]), [['hp:deleteBegin', style === 'run' ? 'run' : 't', true], ['hp:deleteEnd', style === 'run' ? 'run' : 't', true]], style);
    assert.equal(tbl.marks.begin, ms[0]);
    // 칸·캡션 문단은 '/d' — 최종본에 없다
    assert.ok(p.children.length >= 5 && p.children.every((c) => c.hidden && /\/d\d+$/.test(c.ref)), style);
    assert.equal(d.resolve('s0/p1/d1').p, p.children[1]);
    assert.throws(() => d.resolve('s0/p1/n0'), (e) => e.code === 'NO_PARAGRAPH');
    assert.deepEqual(d.paragraphs().filter((q) => q.ref.startsWith('s0/p1')).map((q) => q.ref), ['s0/p1'], style);
    // markup 보기에는 숨은 문단도 hidden 표시와 함께
    assert.ok(d.paragraphs({ view: 'markup' }).filter((q) => q.ref.startsWith('s0/p1/')).every((q) => q.hidden && q.ref.includes('/d')));
    // 표 열쇠: 지운 표는 #d
    assert.deepEqual(d._tableIndex(d.sections[0]).tables.map((t) => [t.key, !!t.hidden]), [['s0/p1#d0', true]]);
    assert.deepEqual(d.tables(), []);
  }
});

test('파서: 넣은 개체는 최종본에 보이고 원본 보기에서 숨는다 · 글과 섞인 범위는 붙은 표식이 아니다', async () => {
  const d = await tableDoc();
  wrap(d, 's0/p1', 0, 'Insert', 'run');
  assert.equal(objAt(d, 's0/p1').ins, '1');
  assert.ok(rows(d).some(([r]) => r === 's0/p1/n0'));
  assert.deepEqual(rows(d, 'original').filter(([r]) => r.startsWith('s0/p1')), [['s0/p1', '']]);
  const m = await textTableDoc();
  const id = m.header.addChange('Delete', m.header.ensureAuthor(AUTHOR), DATE);
  inject(m, 's0/p1', 5, 'after', `<hp:deleteEnd Id="${id}" TcId="${id}" paraend="0"/>`);
  inject(m, 's0/p1', 1, 'before', `<hp:deleteBegin Id="${id}" TcId="${id}"/>`);
  const ms = Section.changeMarks(m.resolve('s0/p1').p);
  assert.equal(ms[0].objects.length, 1);
  assert.equal(ms[0].attach, undefined);
  assert.equal(objAt(m, 's0/p1').del, String(id));
});

// ───────── changes() ─────────

test('changes(): 개체 변경 kind·objects·label — 표·그림·차트·도형·글상자·섞임', async () => {
  const t = await tableDoc();
  wrap(t, 's0/p1', 0, 'Delete');
  assert.deepEqual(t.changes().map((c) => [c.id, c.type, c.ref, c.kind, c.objects, c.label, c.text, c.start, c.end, c.spansParagraph, c.author]),
    [[1, 'Delete', 's0/p1', 'object', [{ tag: 'hp:tbl', what: 'table', name: '표' }], '표 지움', '', 0, 0, false, AUTHOR]]);
  const g = await pictureDoc();
  wrap(g, 's0/p1', 0, 'Insert', 'run');
  assert.deepEqual(g.changes().map((c) => [c.kind, c.label, c.objects.map((o) => o.what)]), [['object', '그림 넣음', ['picture']]]);
  const ch = await HwpxDoc.load(fx('chart_hangul.hwpx'));
  wrap(ch, 's0/p2', 0, 'Delete');
  assert.deepEqual(ch.changes().map((c) => [c.kind, c.label, c.objects]), [['object', '차트 지움', [{ tag: 'hp:chart', what: 'chart', name: '차트' }]]]);
  const sh = await HwpxDoc.load(fx('shapes_hangul.hwpx'));
  wrap(sh, 's0/p7', 0, 'Delete', 'run');
  wrap(sh, 's0/p2', 0, 'Insert');
  assert.deepEqual(changeRows(sh).map((r) => r.slice(0, 5)), [[1, 'Delete', 's0/p7', 'object', '글상자 지움'], [2, 'Insert', 's0/p2', 'object', '도형 넣음: 선']]);
  const m = await textTableDoc();
  const id = m.header.addChange('Delete', m.header.ensureAuthor(AUTHOR), DATE);
  inject(m, 's0/p1', 5, 'after', `<hp:deleteEnd Id="${id}" TcId="${id}" paraend="0"/>`);
  inject(m, 's0/p1', 1, 'before', `<hp:deleteBegin Id="${id}" TcId="${id}"/>`);
  assert.deepEqual(m.changes().map((c) => [c.kind, c.label, c.text, c.start, c.end]), [['mixed', '글과 표 지움', ' 글뒤 글', 1, 1]]);
});

// ───────── 최종본 보기 불변식 · 수락 · 거절 ─────────

/** 문단 ref 의 k 번째 개체 요소만 잘라 낸 본문(줄 정보 뺌) — 넣음 거절·지움 수락이 남길 XML */
async function withoutObject(doc, ref, k = 0) {
  const d = await doc.clone();
  const { sec } = d.resolve(ref); const a = objAt(d, ref, k);
  sec.load(sec.xml.slice(0, a.start) + sec.xml.slice(a.end));
  return body(d);
}

/**
 * 한 개체 변경: 불변식(+ 편집기 왕복) · 수락·거절 XML(개체를 지우는 쪽 = 개체 요소만 빠진 원래 XML, 남기는 쪽 = 원래 XML — 감싼 빈 hp:t 도 없다) ·
 * 모두 거절 = 원래 본문(지움) / 개체 없는 본문(넣음)
 */
async function roundCase(make, ref, type, style, label, check = {}) {
  const base = await make(); // 표·그림 id 는 무작위 — 한 번 만들고 복제한다
  const before = body(base);
  const without = await withoutObject(base, ref);
  const d = await base.clone();
  const id = wrap(d, ref, 0, type, style);
  const v = await invariants(d, label);
  await rhwpRoundTrip(d, v, label);
  const saved = await reload(d);
  assert.deepEqual(changeRows(saved), changeRows(d), `${label}: 저장·다시 읽기`);
  const gone = type === 'Delete';
  // 모두 거절 = 원래 본문(지움) · 개체 요소만 빠진 본문(넣음)
  const rj = await d.clone(); rj.rejectAll();
  assert.deepEqual(body(rj), gone ? before : without, `${label}: 모두 거절`);
  assert.equal(marks(rj), 0);
  // 수락
  const ac = await d.clone(); ac.acceptChange(id);
  assert.equal(marks(ac), 0);
  assert.deepEqual(ac.changes(), []);
  assert.deepEqual(body(ac), gone ? without : before, `${label}: 수락 XML`);
  assert.equal(ac.resolve(ref).p.anchors.filter((a) => Section.isObject(a)).length, gone ? 0 : 1, `${label}: 수락 뒤 개체`);
  assert.deepEqual(rows(ac), rows(d), `${label}: 수락본 글 = 최종본`);
  // 거절(하나)
  const one = await d.clone(); one.rejectChange(id);
  assert.deepEqual(body(one), gone ? before : without, `${label}: 거절 XML`);
  check.after?.(gone ? ac : one, gone ? one : ac);
  return d;
}

test('표(칸·캡션, 글자처럼·떠 있음) 지움·넣음 — 불변식 · 수락·거절 · 모두 거절 = 원래', async () => {
  for (const floating of [false, true]) {
    for (const [type, style] of [['Delete', 't'], ['Delete', 'run'], ['Insert', 't'], ['Insert', 'run']]) {
      await roundCase(() => tableDoc({ floating }), 's0/p1', type, style, `표 ${floating ? '떠 있음' : '글자처럼'} ${type}/${style}`, {
        after: (without, withObj) => {
          assert.deepEqual(without.tables(), []);
          assert.equal(withObj.tables().length, 1);
          assert.equal(rows(without).filter(([r]) => r.startsWith('s0/p1/')).length, 0);
        },
      });
    }
  }
});

test('같은 문단에 표 둘 — 첫 표를 지워도 둘째 표 칸 ref·표 번호가 평탄화 사본과 같다', async () => {
  const d = await tableDoc({ second: true });
  assert.equal(d.tables().length, 2);
  wrap(d, 's0/p1', 0, 'Delete');
  const v = await invariants(d, '표 둘');
  await rhwpRoundTrip(d, v, '표 둘');
  assert.deepEqual(d.tables().map((t) => [t.key, t.cells.map((c) => c.text).join('')]), [['s0/p1#t0', '마바']]);
  assert.deepEqual(rows(d).filter(([r]) => r.startsWith('s0/p1/')), [['s0/p1/n0', '마'], ['s0/p1/n1', '바']]);
  assert.equal(d.text('s0/p1/d1'), '가'); // 지운 표 칸(캡션 다음)은 /d 로 읽을 수 있다
});

test('그림(캡션) 지움·넣음 — 그림 파일은 아무도 안 쓰면 거둔다', async () => {
  for (const [type, style] of [['Delete', 'run'], ['Insert', 't']]) {
    await roundCase(pictureDoc, 's0/p1', type, style, `그림 ${type}/${style}`, {
      after: (without, withObj) => {
        assert.deepEqual(without.figures(), []);
        assert.equal(withObj.figures().length, 1);
        assert.equal(without.binaryItem('image1'), null, '그림 파일 거둠');
        assert.ok(withObj.binaryItem('image1'));
      },
    });
  }
});

test('차트 지움·넣음 — 차트 부분(Chart/chart1.xml)·대체 OLE 를 거둔다', async () => {
  for (const [type, style] of [['Delete', 't'], ['Insert', 'run']]) {
    await roundCase(() => HwpxDoc.load(fx('chart_hangul.hwpx')), 's0/p2', type, style, `차트 ${type}/${style}`, {
      after: (without, withObj) => {
        assert.equal(without.container.has('Chart/chart1.xml'), false);
        assert.equal(withObj.container.has('Chart/chart1.xml'), true);
        assert.ok(!/BinData\/ole1/.test(without.container.getText('Contents/content.hpf')));
      },
    });
  }
});

test('도형(선·글상자·묶음, 떠 있음) 지움·넣음 — 글상자 안 문단은 /d', async () => {
  const make = () => HwpxDoc.load(fx('shapes_hangul.hwpx'));
  for (const [ref, type, style] of [['s0/p7', 'Delete', 'run'], ['s0/p7', 'Insert', 't'], ['s0/p2', 'Delete', 't'], ['s0/p9', 'Delete', 'run']]) {
    await roundCase(make, ref, type, style, `도형 ${ref} ${type}/${style}`);
  }
  const d = await make();
  wrap(d, 's0/p7', 0, 'Delete');
  assert.deepEqual(d.paragraphs({ view: 'markup' }).filter((q) => q.ref.startsWith('s0/p7/')).map((q) => [q.ref, q.text, q.hidden]), [['s0/p7/d0', '글상자 안 글', true]]);
});

// ───────── 지운 개체 안의 변경 · 섞인 범위 · resolveChanges ─────────

test('지운 표 안의 변경(캡션 제목 넣음) — 표째 수락하면 안의 변경 머리 항목도 지우고 다시 매김 기록에 남긴다', async () => {
  const d = await tableDoc({ keepCaption: true }); // 1: 캡션 제목 넣음(s0/p1/n0)
  const txt = d.insertTracked('s0/p2', 0, '새 글 ', { author: AUTHOR, date: DATE }); // 2
  const del = wrap(d, 's0/p1', 0, 'Delete'); // 3
  assert.deepEqual([txt, del], [2, 3]);
  assert.deepEqual(changeRows(d), [
    [1, 'Insert', 's0/p1/d0', null, null, '시험 표'],
    [2, 'Insert', 's0/p2', null, null, '새 글 '],
    [3, 'Delete', 's0/p1', 'object', '표 지움', ''],
  ]);
  await invariants(d, '안에 변경이 든 지운 표');
  const a = await d.clone(); a.takeRenumberLog();
  a.acceptChange(3);
  assert.deepEqual(changeRows(a), [[1, 'Insert', 's0/p2', null, null, '새 글 ']]);
  assert.deepEqual(a.header.changes().map((c) => c.id), [1]);
  assert.deepEqual(a.takeRenumberLog().map((e) => [e.removed, [...e.map]]), [[3, [[1, 1], [2, 2]]], [1, [[2, 1]]]]);
  // 거절하면 표와 안의 변경이 그대로
  const r = await d.clone(); r.rejectChange(3);
  assert.deepEqual(changeRows(r).map((x) => [x[0], x[2]]), [[1, 's0/p1/n0'], [2, 's0/p2']]);
});

test('지운 표 칸 안 메모 — hidden 표시(ref /d), 표째 수락하면 메모도 없어지고 거절하면 제자리', async () => {
  const d = await tableDoc();
  const memo = d.addMemo('s0/p1/n2', { author: AUTHOR, text: '칸 메모', date: DATE }); // n0 캡션, n1 '가', n2 '나'
  wrap(d, 's0/p1', 0, 'Delete');
  const m = d.memos().find((x) => x.id === memo);
  assert.deepEqual([m.ref, m.hidden], ['s0/p1/d2', true]);
  assert.ok(d.memos().filter((x) => x.id !== memo).every((x) => !x.hidden));
  await invariants(d, '지운 표 칸 메모');
  const a = await d.clone(); a.acceptAll();
  assert.equal(a.memos().some((x) => x.id === memo), false);
  const r = await d.clone(); r.rejectAll();
  assert.deepEqual(r.memos().filter((x) => x.id === memo).map((x) => [x.ref, x.hidden]), [['s0/p1/n2', undefined]]);
});

test('resolveChanges: 묶음 도중 번호가 밀려도 원래 번호의 변경을 푼다(done·gone)', async () => {
  const d = await tableDoc({ keepCaption: true });
  d.insertTracked('s0/p2', 0, '새 글 ', { author: AUTHOR, date: DATE }); // 2
  wrap(d, 's0/p1', 0, 'Delete'); // 3
  const a = await d.clone();
  // 3 을 수락하면 1 이 함께 없어지고 2 가 1 이 된다 — 옛 차례 호출(acceptChange(2))이면 글 변경이 남는다
  assert.deepEqual(a.resolveChanges([3, 2], 'accept'), { done: [3, 2], gone: [], detail: [] });
  assert.deepEqual(a.changes(), []);
  assert.equal(a.text('s0/p2').startsWith('새 글 '), true);
  const b = await d.clone();
  assert.deepEqual(b.resolveChanges([1, 3], 'accept'), { done: [3], gone: [1], detail: [] });
  assert.deepEqual(changeRows(b).map((x) => x.slice(0, 3)), [[1, 'Insert', 's0/p2']]);
  const c = await d.clone();
  assert.deepEqual(c.resolveChanges([2, 3], 'reject'), { done: [3, 2], gone: [], detail: [] });
  assert.deepEqual(changeRows(c).map((x) => x.slice(0, 3)), [[1, 'Insert', 's0/p1/n0']]);
  // acceptAll·rejectAll 도 같은 길
  const e = await d.clone(); e.acceptAll(); assert.equal(marks(e), 0); assert.deepEqual(e.tables(), []);
  const f = await d.clone(); f.rejectAll(); assert.equal(marks(f), 0); assert.equal(f.tables().length, 1); assert.equal(f.text('s0/p1/n0'), '[표 ] ');
  // keepIfStuck: 거절할 수 없는 변경(SPANS_PARAGRAPH)은 수락, 그것도 안 되면 너그럽게
  const g = await d.clone();
  const sp = g.header.addChange('Insert', g.header.ensureAuthor(AUTHOR), DATE);
  inject(g, 's0/p0', 0, 'before', `<hp:insertBegin Id="${sp}" TcId="${sp}"/>`);
  assert.throws(() => g.resolveChanges([sp], 'reject'), (x) => x.code === 'SPANS_PARAGRAPH');
  const r = g.resolveChanges([sp], 'reject', { keepIfStuck: true });
  assert.deepEqual(r, { done: [sp], gone: [], detail: [{ id: sp, code: 'SPANS_PARAGRAPH' }] });
  assert.equal(g.changes().length, 3);
});

test('섞인 범위(글 + 표 한 삭제) — 수락하면 글과 표째, 거절하면 원래 · 최종본 보기 불변식', async () => {
  const base = await textTableDoc();
  const make = async () => {
    const m = await base.clone();
    const id = m.header.addChange('Delete', m.header.ensureAuthor(AUTHOR), DATE);
    inject(m, 's0/p1', 5, 'after', `<hp:deleteEnd Id="${id}" TcId="${id}" paraend="0"/>`);
    inject(m, 's0/p1', 1, 'before', `<hp:deleteBegin Id="${id}" TcId="${id}"/>`);
    return m;
  };
  const orig = body(base);
  const d = await make();
  assert.equal(d.text('s0/p1'), '앞');
  const v = await invariants(d, '섞임');
  await rhwpRoundTrip(d, v, '섞임');
  const a = await d.clone(); a.acceptAll();
  assert.deepEqual([a.text('s0/p1'), a.tables().length, marks(a)], ['앞', 0, 0]);
  const r = await d.clone(); r.rejectAll();
  assert.deepEqual(body(r), orig);
  // 너그러운 평탄화도 표를 지운다(예전: 개체를 남겨 작업본에 지운 표가 보였다)
  const t = await d.flattened({ tolerant: true });
  assert.deepEqual([t.tables().length, t.lastTolerantSkips], [0, []]);
});

test('개체 아닌 부호(메모 끝)가 낀 범위는 여전히 CTRL_INSIDE, 너그럽게는 표만 지우고 메모는 남긴다', async () => {
  const d = await textTableDoc();
  d.addMemo('s0/p1', { start: 0, end: 2, author: AUTHOR, text: '앞 메모', date: DATE });
  const id = d.header.addChange('Delete', d.header.ensureAuthor(AUTHOR), DATE);
  inject(d, 's0/p1', 5, 'after', `<hp:deleteEnd Id="${id}" TcId="${id}" paraend="0"/>`);
  inject(d, 's0/p1', 1, 'before', `<hp:deleteBegin Id="${id}" TcId="${id}"/>`);
  assert.throws(() => d.acceptChange(id), (e) => e.code === 'CTRL_INSIDE');
  const f = await d.flattened({ tolerant: true });
  assert.deepEqual(f.lastTolerantSkips, [id]);
  assert.deepEqual([f.text('s0/p1'), f.tables().length, f.memos().length], ['앞', 0, d.memos().length]);
  assert.deepEqual(rows(f), rows(d));
});

// ───────── 붙은 표식 옆 글 편집 ─────────

test('지운 표 옆 글 지우기·넣기·메모 — 개체를 감싸지 않고 막히지 않는다(hp:t 안·run·글과 같은 hp:t)', async () => {
  for (const style of ['t', 'run', 'share']) {
    const d = await textTableDoc();
    const memos0 = d.memos().length;
    const tid = wrap(d, 's0/p1', 0, 'Delete', style);
    assert.equal(d.text('s0/p1'), '앞 글뒤 글');
    // 표 자리를 건너는 글 지우기: 두 조각, 표의 지움 표식은 그대로 붙어 있다
    const r = d.deleteTracked('s0/p1', 1, 4, { author: AUTHOR, date: DATE });
    assert.equal(r.deleteIds.length, 2, style);
    assert.equal(d.text('s0/p1'), '앞 글', style);
    const obj = d.changes().filter((c) => c.kind);
    assert.deepEqual(obj.map((c) => [c.id, c.kind]), [[tid, 'object']], style);
    // 표 바로 앞·뒤에 글 넣기
    d.insertTracked('s0/p1', 1, 'X', { author: AUTHOR, date: DATE });
    assert.equal(d.text('s0/p1'), '앞X 글', style);
    assert.equal(d.changes().filter((c) => c.kind).length, 1, style);
    // 표 바로 뒤 글에서 시작하는 메모·표 바로 앞 글에서 끝나는 메모 — 표의 변경 범위에 부호가 들지 않는다
    d.addMemo('s0/p1', { start: 0, end: 1, author: AUTHOR, text: '앞 메모', date: DATE });
    d.addMemo('s0/p1', { start: 3, end: 4, author: AUTHOR, text: '뒤 메모', date: DATE });
    assert.equal(Section.changeMarks(d.resolve('s0/p1').p).filter((m) => m.attach).length, 2, `${style}: 표식이 여전히 표에 붙어 있다`);
    const want = rows(d);
    await invariants(d, `옆 글 편집 ${style}`);
    const a = await d.clone(); a.acceptAll();
    assert.deepEqual(rows(a), want, style);
    assert.deepEqual([a.tables().length, a.memos().length, marks(a)], [0, memos0 + 2, 0], style);
    const j = await d.clone(); j.rejectAll();
    assert.deepEqual([j.text('s0/p1'), j.tables().length, marks(j)], ['앞 글뒤 글', 1, 0], style);
  }
});

test('넣은 표 옆 글 지우기: 표는 남고 넣음 표식도 그대로(engine5 의 표 남김 규칙)', async () => {
  const d = await textTableDoc();
  wrap(d, 's0/p1', 0, 'Insert');
  const r = d.deleteTracked('s0/p1', 1, 4, { author: AUTHOR, date: DATE });
  assert.equal(r.deleteIds.length, 2);
  const f = await d.flattened();
  assert.deepEqual([f.text('s0/p1'), f.tables().length], ['앞 글', 1]);
  assert.deepEqual(d.changes().filter((c) => c.kind).map((c) => c.label), ['표 넣음']);
});

test('removeOwnObjects: 추적하지 않는 지우기는 붙은 표식·안의 변경 머리 항목까지 정리한다', async () => {
  const d = await tableDoc({ keepCaption: true }); // 1: 캡션 제목
  wrap(d, 's0/p1', 0, 'Insert'); // 2
  d.insertTracked('s0/p2', 0, '새 ', { author: AUTHOR, date: DATE }); // 3
  d.takeRenumberLog();
  assert.equal(d.removeOwnObjects('s0/p1'), 1);
  assert.deepEqual(changeRows(d).map((x) => x.slice(0, 3)), [[1, 'Insert', 's0/p2']]);
  assert.deepEqual(d.header.changes().map((c) => c.id), [1]);
  assert.deepEqual(d.takeRenumberLog().map((e) => e.removed), [2, 1]);
  assert.ok(!/<hp:t><\/hp:t>|insertBegin Id="2"/.test(d.sections[0].xml));
});

// ───────── 쓰는 쪽(A2): copyObjectsTracked · removeOwnObjectsTracked · trackObjectInsert ─────────

/** base 의 ref 문단 개체를 모두 뺀 사본(편집기에서 개체를 지운 문서 꼴) */
async function stripped(base, ref) { const d = await base.clone(); d.removeOwnObjects(ref); return d; }

test('copyObjectsTracked: 표 지움·넣음 — 변경 목록 → 최종본 = 편집기 문서 → 수락·거절 · 같은 것을 다시 보내면 그대로', async () => {
  const base = await tableDoc();
  const without = await stripped(base, 's0/p1');
  // 지움: 표는 지움 표식으로 남는다
  const d = await base.clone();
  assert.deepEqual(d.copyObjectsTracked(without, 's0/p1', 's0/p1', { author: AUTHOR, date: DATE }), { changed: true, ids: [1] });
  assert.deepEqual(changeRows(d), [[1, 'Delete', 's0/p1', 'object', '표 지움', '']]);
  assert.match(d.sections[0].xml, /<hp:t><hp:deleteBegin Id="1" TcId="1"\/><\/hp:t><hp:tbl\b[\s\S]*?<\/hp:tbl><hp:t><hp:deleteEnd Id="1" TcId="1" paraend="0"\/><\/hp:t>/);
  assert.deepEqual((await diffDocs(d, without)).hunks, [], '최종본 = 편집기 문서');
  await rhwpRoundTrip(d, await invariants(d, '추적 표 지움'), '추적 표 지움');
  assert.deepEqual(d.copyObjectsTracked(without, 's0/p1', 's0/p1', { author: AUTHOR }), { changed: false, ids: [] }, '다시 보내도 그대로');
  const rj = await d.clone(); rj.rejectChange(1);
  assert.deepEqual(body(rj), body(base), '지움 거절 = 원래');
  const ac = await d.clone(); ac.acceptChange(1);
  assert.deepEqual([ac.tables().length, marks(ac), rows(ac)], [0, 0, rows(without)]);
  // 넣음
  const e = await without.clone();
  assert.deepEqual(e.copyObjectsTracked(base, 's0/p1', 's0/p1', { author: AUTHOR, date: DATE }), { changed: true, ids: [1] });
  assert.deepEqual(changeRows(e), [[1, 'Insert', 's0/p1', 'object', '표 넣음', '']]);
  assert.deepEqual((await diffDocs(e, base)).hunks, []);
  await invariants(e, '추적 표 넣음');
  const er = await e.clone(); er.rejectAll();
  assert.deepEqual([er.tables().length, marks(er), rows(er)], [0, 0, rows(without)]);
  const ea = await e.clone(); ea.acceptAll();
  assert.deepEqual([ea.tables().map((t) => t.cells.map((c) => c.text).join('')), marks(ea), rows(ea)], [['가나다라'], 0, rows(base)]);
  // 같은 작성자가 넣은 표를 다시 빼면 그 넣음을 거절(새 변경 없음), 다른 사람이면 넣음 수락 뒤 지움
  const own = await e.clone();
  assert.deepEqual(own.copyObjectsTracked(without, 's0/p1', 's0/p1', { author: AUTHOR }), { changed: true, ids: [] });
  assert.deepEqual([own.changes(), own.header.changes(), own.tables().length, /<hp:tbl\b/.test(own.sections[0].xml)], [[], [], 0, false]);
  const other = await e.clone();
  assert.deepEqual(other.copyObjectsTracked(without, 's0/p1', 's0/p1', { author: '다른 사람', date: DATE }), { changed: true, ids: [1] });
  assert.deepEqual(other.changes().map((c) => [c.id, c.type, c.label, c.author]), [[1, 'Delete', '표 지움', '다른 사람']]);
  await invariants(other, '남의 넣음 → 지움');
});

test('copyObjectsTracked: 그림 넣음·지움·바꿈(지움+넣음) — 그림 파일은 거절·수락할 때 거둔다', async () => {
  const base = await pictureDoc();
  const without = await stripped(base, 's0/p1');
  const e = await without.clone();
  assert.deepEqual(e.copyObjectsTracked(base, 's0/p1', 's0/p1', { author: AUTHOR, date: DATE }).ids, [1]);
  assert.deepEqual(changeRows(e), [[1, 'Insert', 's0/p1', 'object', '그림 넣음', '']]);
  await rhwpRoundTrip(e, await invariants(e, '추적 그림 넣음'), '추적 그림 넣음');
  const bin = e.figures()[0].binId;
  const er = await e.clone(); er.rejectAll();
  assert.deepEqual([er.figures().length, er.binaryItem(bin)], [0, null]);
  // 바꿈: 다른 그림 파일 → 옛 그림 지움 + 새 그림 넣음
  const swapped = await base.clone();
  swapped.replacePicture('s0/p1', { binId: base.figures()[0].binId, n: 1 }, { data: png(30, 30, [0, 0, 250]) });
  const d = await base.clone();
  assert.deepEqual(d.copyObjectsTracked(swapped, 's0/p1', 's0/p1', { author: AUTHOR, date: DATE }).ids, [1, 2]);
  assert.deepEqual(changeRows(d).map((r) => r.slice(0, 5)), [[1, 'Delete', 's0/p1', 'object', '그림 지움'], [2, 'Insert', 's0/p1', 'object', '그림 넣음']]);
  assert.deepEqual((await diffDocs(d, swapped)).hunks, []);
  await invariants(d, '추적 그림 바꿈');
  const da = await d.clone(); da.acceptAll();
  assert.deepEqual([da.figures().length, da.binaryItem(base.figures()[0].binId)], [1, null], '수락: 새 그림만, 옛 파일 거둠');
  const dr = await d.clone(); dr.rejectAll();
  assert.deepEqual(body(dr), body(base), '거절: 원래');
});

test('copyObjectsTracked: 차트·도형(글상자·선) 넣음·지움 — 차트 부분은 수락·거절할 때 거둔다', async () => {
  const chart = await HwpxDoc.load(fx('chart_hangul.hwpx'));
  const noChart = await stripped(chart, 's0/p2');
  assert.equal(noChart.container.has('Chart/chart1.xml'), false);
  const d = await chart.clone();
  assert.deepEqual(d.copyObjectsTracked(noChart, 's0/p2', 's0/p2', { author: AUTHOR, date: DATE }).ids, [1]);
  assert.deepEqual(changeRows(d).map((r) => r.slice(0, 5)), [[1, 'Delete', 's0/p2', 'object', '차트 지움']]);
  assert.equal(d.container.has('Chart/chart1.xml'), true, '지움 표식 동안은 차트 부분이 남는다');
  await rhwpRoundTrip(d, await invariants(d, '추적 차트 지움'), '추적 차트 지움');
  const da = await d.clone(); da.acceptAll(); assert.equal(da.container.has('Chart/chart1.xml'), false);
  const e = await noChart.clone();
  assert.deepEqual(e.copyObjectsTracked(chart, 's0/p2', 's0/p2', { author: AUTHOR, date: DATE }).ids, [1]);
  assert.equal(e.container.has('Chart/chart1.xml'), true);
  assert.deepEqual(e.changes().map((c) => c.label), ['차트 넣음']);
  const er = await e.clone(); er.rejectAll(); assert.equal(er.container.has('Chart/chart1.xml'), false);
  const shapes = await HwpxDoc.load(fx('shapes_hangul.hwpx'));
  const s = await shapes.clone();
  assert.deepEqual(s.copyObjectsTracked(await stripped(shapes, 's0/p7'), 's0/p7', 's0/p7', { author: AUTHOR, date: DATE }).ids, [1]);
  const noLine = await stripped(shapes, 's0/p2');
  assert.deepEqual(noLine.copyObjectsTracked(shapes, 's0/p2', 's0/p2', { author: AUTHOR, date: DATE }).ids, [1]);
  assert.deepEqual([s.changes().map((c) => c.label), noLine.changes().map((c) => c.label)], [['글상자 지움'], ['도형 넣음: 선']]);
  assert.deepEqual(rows(s, 'markup').filter(([r]) => r.startsWith('s0/p7/')), [['s0/p7/d0', '글상자 안 글']]);
  await invariants(s, '추적 글상자 지움');
  await invariants(noLine, '추적 선 넣음');
});

test('copyObjectsTracked: 표 뼈대를 바꾸면(통째 바꿈) 옛 표 안 처리 안 된 변경을 먼저 수락 — 고아 머리 항목 없음 · 추적 안 하는 옮기기도', async () => {
  const d = await tableDoc({ keepCaption: true }); // 1: 캡션 제목 넣음
  const src = await d.flattened();
  const sec = src.sections[0];
  sec.load(sec.xml.replace(/<hp:cellSz width="(\d+)"/, (m, w) => `<hp:cellSz width="${Number(w) + 300}"`));
  assert.notEqual(src.objectPrint('s0/p1'), d.objectPrint('s0/p1'));
  const t = await d.clone(); t.takeRenumberLog();
  assert.deepEqual(t.copyObjectsTracked(src, 's0/p1', 's0/p1', { author: AUTHOR }), { changed: true, ids: [] });
  assert.deepEqual([t.changes(), t.header.changes(), marks(t)], [[], [], 0]);
  assert.deepEqual(t.takeRenumberLog().map((e) => e.removed), [1]);
  assert.equal(t.objectPrint('s0/p1'), src.objectPrint('s0/p1'));
  const u = await d.clone();
  assert.equal(u.copyObjectsFrom(src, 's0/p1', 's0/p1'), true);
  assert.deepEqual([u.changes(), u.header.changes(), marks(u)], [[], [], 0], '추적 안 하는 옮기기도 사라진 변경의 머리 항목을 지운다');
});

test('copyObjectsTracked: 거절로 번호가 밀리면 돌려주는 id 도 따라간다(내 넣은 표를 빼고 그림을 넣음)', async () => {
  const base = await tableDoc();
  const d = await stripped(base, 's0/p1');
  d.copyObjectsTracked(base, 's0/p1', 's0/p1', { author: AUTHOR, date: DATE }); // 1: 표 넣음
  d.insertTracked('s0/p2', 0, '글 ', { author: AUTHOR, date: DATE }); // 2
  const pic = await pictureDoc(); // s0/p1 = 그림 문단
  const r = d.copyObjectsTracked(pic, 's0/p1', 's0/p1', { author: AUTHOR, date: DATE });
  assert.deepEqual(r, { changed: true, ids: [2] });
  assert.deepEqual(changeRows(d).map((x) => x.slice(0, 5)), [[1, 'Insert', 's0/p2', null, null], [2, 'Insert', 's0/p1', 'object', '그림 넣음']]);
  assert.deepEqual(d.tables(), []);
  await invariants(d, 'id 따라가기');
});

test('removeOwnObjectsTracked·trackObjectInsert: 지움 표식으로 남김 · 내 넣음은 거절 · 이미 추적된 개체는 다시 감싸지 않는다', async () => {
  const base = await tableDoc();
  const d = await base.clone();
  assert.deepEqual(d.removeOwnObjectsTracked('s0/p1', { author: AUTHOR, date: DATE }), { count: 1, ids: [1] });
  assert.deepEqual(changeRows(d), [[1, 'Delete', 's0/p1', 'object', '표 지움', '']]);
  await invariants(d, 'removeOwnObjectsTracked');
  assert.deepEqual(d.removeOwnObjectsTracked('s0/p1', { author: AUTHOR }), { count: 0, ids: [] }, '이미 지운 표는 최종본에 없다');
  const rj = await d.clone(); rj.rejectAll(); assert.deepEqual(body(rj), body(base));
  const g = await pictureDoc();
  assert.deepEqual(g.trackObjectInsert('s0/p1', { author: AUTHOR, date: DATE }), [1]);
  assert.deepEqual(g.trackObjectInsert('s0/p1', { author: AUTHOR }), []);
  assert.deepEqual(g.changes().map((c) => c.label), ['그림 넣음']);
  const t = g.insertTracked('s0/p2', 0, '글 ', { author: AUTHOR, date: DATE }); // 2
  assert.equal(t, 2);
  assert.deepEqual(g.removeOwnObjectsTracked('s0/p1', { author: AUTHOR }), { count: 1, ids: [] }, '내 넣음 거절 — 새 변경 없음');
  assert.deepEqual([changeRows(g).map((x) => x.slice(0, 3)), g.figures().length], [[[1, 'Insert', 's0/p2']], 0]);
  const h = await pictureDoc(); h.trackObjectInsert('s0/p1', { author: '다른 사람' });
  assert.deepEqual(h.removeOwnObjectsTracked('s0/p1', { author: AUTHOR }), { count: 1, ids: [1] });
  assert.deepEqual(h.changes().map((c) => [c.type, c.author, c.label]), [['Delete', AUTHOR, '그림 지움']]);
  assert.throws(() => h.removeOwnObjectsTracked('s0/p1', {}), (e) => e.code === 'NO_AUTHOR');
});

test('OBJECT_TRACK 꼴 바꾸기: run 단계 표식 · 고침을 지움+넣음으로 — 읽는 쪽은 그대로', async () => {
  const { setObjectTrackStyle, OBJECT_TRACK } = await import('../engine/track-objects.js');
  try {
    setObjectTrackStyle({ name: 'marks-in-run' });
    const base = await tableDoc();
    const d = await base.clone();
    d.removeOwnObjectsTracked('s0/p1', { author: AUTHOR, date: DATE });
    assert.match(d.sections[0].xml, /<hp:run\b[^>]*><hp:deleteBegin Id="1" TcId="1"\/><hp:tbl\b/);
    assert.deepEqual(Section.changeMarks(d.resolve('s0/p1').p).map((m) => m.level), ['run', 'run']);
    await invariants(d, 'run 꼴');
    const rj = await d.clone(); rj.rejectAll(); assert.deepEqual(body(rj), body(base));
    setObjectTrackStyle({ name: 'marks-in-t', modify: { replaceXml: 'replace' } });
    assert.equal(OBJECT_TRACK.modify.props, 'direct');
    const src = await base.clone();
    const sec = src.sections[0];
    sec.load(sec.xml.replace(/<hp:cellSz width="(\d+)"/, (m, w) => `<hp:cellSz width="${Number(w) + 300}"`));
    const e = await base.clone();
    assert.deepEqual(e.copyObjectsTracked(src, 's0/p1', 's0/p1', { author: AUTHOR, date: DATE }).ids, [1, 2]);
    assert.deepEqual(e.changes().map((c) => c.label), ['표 지움', '표 넣음']);
    await invariants(e, 'replace 꼴');
  } finally { setObjectTrackStyle(null); }
  assert.deepEqual([OBJECT_TRACK.name, OBJECT_TRACK.modify], ['marks-in-t', { props: 'direct', replaceXml: 'direct' }]);
});

// ───────── 한/글 2022 가 만든 파일(2026-10-30 실측 — tests/fixtures/hangul_trk_*) ─────────

test('한/글 파일: 표·차트·도형·그림 변경을 읽고 최종본 보기 불변식 · 모두 수락·거절', async () => {
  const cases = [
    // [hwpx-cowork] 1 = 넣은 문단 나눔(폭 0 paraend="1" — kind 'para'), 2 = 표 + 표 문단 나눔. 모두 거절 = 한/글처럼 원래 세 문단(가른 문단이 다시 하나)
    ['hangul_trk_tbl_insert.hwpx', [[1, 'Insert', 's0/p1', 'para', '문단 나눔 넣음', ''], [2, 'Insert', 's0/p2', 'object', '표 넣음', ''], [3, 'Insert', 's0/p2/n0', null, null, '표안글']], (a, r) => {
      assert.equal(a.tables().length, 1); assert.equal(r.tables().length, 0);
      assert.equal(r.paragraphs({ nested: false }).length, 3);
      assert.equal(r.text('s0/p1'), '둘째 문단입니다. 여기에 개체를 넣습니다.');
    }],
    ['hangul_trk_tbl_delete.hwpx', [[1, 'Delete', 's0/p2', 'object', '표 지움', '']], (a, r) => { assert.equal(a.tables().length, 0); assert.equal(r.tables().length, 1); }],
    ['hangul_trk_chart_insert.hwpx', [[1, 'Insert', 's0/p1', 'object', '차트 넣음', '']], (a, r) => {
      assert.equal(a.container.has('Chart/chart1.xml'), true); assert.equal(r.container.has('Chart/chart1.xml'), false);
    }],
    ['hangul_trk_pic_insert_with_text.hwpx', [[1, 'Insert', 's0/p1', 'mixed', '글과 그림 넣음', '가나']], (a, r) => { assert.equal(a.figures().length, 1); assert.equal(r.figures().length, 0); }],
    ['hangul_trk_pic_delete_range.hwpx', [[1, 'Delete', 's0/p5', 'mixed', '글과 그림 지움', '앞  그']], (a, r) => { assert.equal(a.figures().length, r.figures().length - 1); }],
    ['hangul_trk_hand_marks_in_t.hwpx', [[1, 'Insert', 's0/p5', 'object', '그림 넣음', ''], [2, 'Delete', 's0/p6', 'object', '그림 지움', ''], [3, 'Insert', 's0/p7', 'object', '수식 넣음', '']], null],
  ];
  for (const [name, want, check] of cases) {
    const d = await HwpxDoc.load(fx(name));
    assert.deepEqual(changeRows(d), want, name);
    await rhwpRoundTrip(d, await invariants(d, name), name);
    const a = await d.clone(); a.acceptAll();
    const r = await d.clone(); r.rejectAll();
    assert.deepEqual([marks(a), marks(r)], [0, 0], name);
    assert.deepEqual(rows(a), rows(d), `${name}: 모두 수락 = 최종본`);
    check?.(a, r);
  }
});

test('한/글 파일: 글 뒤 개체의 지움 시작 표식을 잃은 저장본(한/글 저장 버그) — 읽을 때 시작 표식을 되살려 수락·거절할 수 있다', async () => {
  const d = await HwpxDoc.load(fx('hangul_trk_rect_delete_lost_begin.hwpx'));
  assert.equal(d.repaired, 1);
  assert.deepEqual(changeRows(d), [[1, 'Delete', 's0/p3', 'object', '도형 지움: 사각형', '']]);
  assert.match(d.sections[0].xml, /<hp:t><hp:deleteBegin Id="1" TcId="1"\/><\/hp:t><hp:rect\b/);
  await invariants(d, '시작 표식 되살림');
  const a = await d.clone(); a.acceptAll();
  assert.equal(a.resolve('s0/p3').p.anchors.filter((x) => Section.isObject(x)).length, 0);
  const r = await d.clone(); r.rejectAll();
  assert.equal(r.resolve('s0/p3').p.anchors.filter((x) => Section.isObject(x)).length, 1);
  assert.equal((await reload(d)).repaired, 0, '저장본에는 시작 표식이 있다');
  // 시작이 있는 파일·짝 없는 끝이 개체 뒤가 아닌 파일은 손대지 않는다
  for (const n of ['hangul_trk_tbl_delete.hwpx', 'hangul_tracked.hwpx', 'tool_memo_tracked.hwpx']) assert.equal((await HwpxDoc.load(fx(n))).repaired, 0, n);
});
