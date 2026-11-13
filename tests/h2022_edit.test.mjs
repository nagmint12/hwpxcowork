// node --test tests/h2022_edit.test.mjs — 한/글 2022 편집·입력 기능(2026-11-11, 원장 research/hangul2022-features-20261111/impl/ledger_edit.md)
//  1) 찾기 옵션(엔진 searchTextEx·replaceAllEx): 온전한 낱말·아무개 문자·여러 단어·띄어쓰기 무시·자소 — 기대값은 한/글 2022 COM AllReplace 실측
//  2) 글자 바꾸기 순수 규칙(편집기 ui/h2022-edit-convert.ts): 대/소문자 Type 0~5·전각/반각 — 기대값은 한/글 2022 COM ConvertCase·ConvertFullHalfWidth 실측
//  3) 덧말·글자 겹치기(엔진 insertRuby·insertCharOverlap·getComposeControlAt·setComposeControl·deleteComposeControl):
//     내보낸 XML 이 한/글 2022 가 같은 조작(DutmalChars·ComposeChars)으로 저장한 꼴과 같다 → 다시 열어도 값이 그대로
//  4) 서버 diffDocs: 손대지 않은 내보내기는 덩어리 없음 · 덧말/겹침 넣기·고치기·지우기 → object 덩어리 → copyObjectsFrom 로 서버 문서에 실린다
// 엔진은 RHWP_PKG(기본 vendor/rhwp/pkg). 새 API 가 없는 옛 엔진이면 1)·3)·4) 는 실패로 드러난다(건너뛰지 않음).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import JSZip from 'jszip';
import { HwpxDoc, diffDocs } from '../engine/doc.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkgDir = path.resolve(root, process.env.RHWP_PKG || 'vendor/rhwp/pkg');
globalThis.measureTextWidth ??= (font, text) => text.length * 10;
const mod = await import(pathToFileURL(path.join(pkgDir, 'rhwp.js')).href);
if (!(globalThis.__rhwpEngineReady ??= new Set()).has(pkgDir)) { mod.initSync({ module: fs.readFileSync(path.join(pkgDir, 'rhwp_bg.wasm')) }); globalThis.__rhwpEngineReady.add(pkgDir); }
const conv = await import(pathToFileURL(path.join(root, 'vendor/rhwp/rhwp-studio/src/ui/h2022-edit-convert.ts')).href);

// 한/글 2022 가 저장한 네 문단 문서(첫째 문단입니다. / 둘째 문단입니다. 여기에 개체를 넣습니다. / …)
const FX = path.join(root, 'tests/fixtures/hangul_trk_brk_base.hwpx');
const PROBE = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/h2022_edit_hangul_probe.json'), 'utf8'));
const open = (bytes) => new mod.HwpDocument(new Uint8Array(bytes));
const sectionXml = async (bytes) => (await JSZip.loadAsync(bytes)).file('Contents/section0.xml').async('string');
const decodeRefs = (s) => s.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));

// ── 1) 찾기 옵션 ──
const FIND_BASE = PROBE.find_base;
const OPT_KEYS = { MatchCase: 'matchCase', WholeWordOnly: 'wholeWord', UseWildCards: 'wildcard', SeveralWords: 'severalWords', AllWordForms: 'ignoreSpace', FindJaso: 'jaso' };

test('찾기 옵션: 한/글 2022 AllReplace 실측과 같은 글이 된다(replaceAllEx)', () => {
  assert.equal(typeof mod.HwpDocument.prototype.replaceAllEx, 'function', '엔진에 replaceAllEx 가 있어야 한다');
  for (const c of PROBE.find) {
    const doc = open(fs.readFileSync(FX));
    const len = doc.getParagraphLength(0, 0);
    doc.replaceText(0, 0, 0, len, FIND_BASE);
    const opts = Object.fromEntries(Object.entries(c.opt).filter(([, v]) => v).map(([k]) => [OPT_KEYS[k], true]));
    const r = JSON.parse(doc.replaceAllEx(c.query, '#', JSON.stringify(opts)));
    assert.ok(r.ok, JSON.stringify(c));
    const got = doc.getTextRange(0, 0, 0, doc.getParagraphLength(0, 0));
    assert.equal(got, c.after, `${c.query} ${JSON.stringify(c.opt)}`);
  }
});

test('찾기 옵션: searchTextEx 는 다음 매치 자리·길이·방향을 돌려주고, 옵션 없으면 searchText 와 같다', () => {
  const doc = open(fs.readFileSync(FX));
  doc.replaceText(0, 0, 0, doc.getParagraphLength(0, 0), FIND_BASE);
  const ww = JSON.parse(doc.searchTextEx('학교', 0, 0, 0, true, JSON.stringify({ wholeWord: true }), true));
  assert.deepEqual([ww.found, ww.para, ww.charOffset, ww.length, ww.totalMatchCount], [true, 0, 4, 2, 1]);
  const wc = JSON.parse(doc.searchTextEx('a*c', 0, 0, 0, true, JSON.stringify({ wildcard: true }), true));
  assert.equal(FIND_BASE.slice(wc.charOffset, wc.charOffset + wc.length), 'abc');
  assert.equal(wc.totalMatchCount, 4);
  const back = JSON.parse(doc.searchTextEx('a*c', 0, 0, FIND_BASE.length, false, JSON.stringify({ wildcard: true }), true));
  assert.equal(FIND_BASE.slice(back.charOffset, back.charOffset + back.length), 'a?c', '위쪽으로 찾으면 마지막 매치');
  for (const q of ['school', '가나', '학교']) {
    assert.equal(doc.searchTextEx(q, 0, 0, 0, true, '{}', true), doc.searchText(q, 0, 0, 0, true, false, true), q);
  }
  // 옵션 매처는 그 호출 동안만 — 다음 종전 호출은 종전 규칙
  doc.searchTextEx('학교', 0, 0, 0, true, JSON.stringify({ wholeWord: true }), true);
  assert.equal(JSON.parse(doc.searchText('학교', 0, 0, 0, true, false, true)).totalMatchCount, 3);
});

// ── 2) 글자 바꾸기 순수 규칙 ──
test('대/소문자 바꾸기: Type 0~5 가 한/글 실측과 같다', () => {
  for (const c of PROBE.convertCase) assert.equal(conv.convertCase('hello World. abc DEF gHi', c.type), c.after, `Type ${c.type}`);
});

test('전각/반각 바꾸기: 한/글 실측(모두 켬·숫자만, 반각으로·전각으로)과 같다', () => {
  const base = 'ABC abc 123 !?#() ｱｲｳ アイ ㄱㄴ 가 ＡＢＣ１２３！ ㈜ ﾞ';
  for (const c of PROBE.convertFullHalf) {
    const flags = { number: !!c.flags.Number, alpha: !!c.flags.Alpha, symbol: !!c.flags.Symbol, gata: !!c.flags.Gata, jamo: !!c.flags.HGJamo };
    assert.equal(conv.convertFullHalf(base, c.type === 1, flags), decodeRefs(c.after), JSON.stringify(c.flags) + c.type);
  }
  // 탁음 가타카나는 반각에서 두 글자로, 되돌리면 한 글자로
  assert.equal(conv.convertFullHalf('ガパ', false), 'ｶﾞﾊﾟ');
  assert.equal(conv.convertFullHalf('ｶﾞﾊﾟ', true), 'ガパ');
});

test('바뀐 구간만 고른다(changedSegments) · 날짜 형식 기본은 한/글 실측 꼴', () => {
  assert.deepEqual(conv.changedSegments('abc def', 'ABC def'), [{ start: 0, length: 3, text: 'ABC' }]);
  assert.deepEqual(conv.changedSegments('aXbYc', 'aZbWc'), [{ start: 1, length: 1, text: 'Z' }, { start: 3, length: 1, text: 'W' }]);
  assert.deepEqual(conv.changedSegments('ガ!', 'ｶﾞ!'), [{ start: 0, length: 1, text: 'ｶﾞ' }]);
  const d = new Date(2026, 10, 11, 14, 5, 9);
  // 한/글 2022 InsertStringDateTime 실측(2026-11-11): '2026년 11월 11일'
  assert.equal(conv.formatDate(d, conv.DATE_FORMATS[0]), PROBE.date.text.split('|')[0]);
  assert.equal(conv.formatDate(d, 'YYYY-MM-DD HH:mm'), '2026-11-11 14:05');
  assert.equal(conv.formatDate(d, 'A h시 m분'), '오후 2시 5분');
  assert.equal(conv.formatDate(d, 'M월 D일 dddd'), '11월 11일 수요일');
  assert.equal(conv.wrapDecision('down', true, false), 'ask');
  assert.equal(conv.wrapDecision('down', true, true), 'move');
  assert.equal(conv.wrapDecision('all', true, false), 'move');
});

// ── 3) 덧말·글자 겹치기 ──
const HANGUL_DUTMAL = PROBE.dutmal.xml[0];
const HANGUL_COMPOSE = PROBE.compose.find((c) => c.in[0] === -3).xml[0];

function withCompose() {
  const doc = open(fs.readFileSync(FX));
  // 둘째 문단 '둘째 ' 뒤(5)에 덧말, 셋째 문단 맨 앞에 글자 겹침
  const r = JSON.parse(doc.insertRuby(0, 1, 3, JSON.stringify({ mainText: '漢字', rubyText: '한자', below: false, styleId: null })));
  const o = JSON.parse(doc.insertCharOverlap(0, 2, 0, JSON.stringify({ text: '12', shape: 1, innerSize: -3, overlap: true })));
  return { doc, r, o };
}

test('덧말·글자 겹침 넣기: 내보낸 XML 이 한/글 2022 저장 꼴과 같고, 다시 열면 캐럿 자리에서 찾는다', async () => {
  const { doc, r, o } = withCompose();
  assert.ok(r.ok && o.ok);
  const xml = await sectionXml(doc.exportHwpx());
  assert.ok(xml.includes(HANGUL_DUTMAL), `덧말 XML: ${xml.match(/<hp:dutmal\b.*?<\/hp:dutmal>/)?.[0]}`);
  const comp = xml.match(/<hp:compose\b.*?<\/hp:compose>/)?.[0] ?? '';
  // 첫 charPr 은 놓인 자리 글자 모양 번호(문서마다 다름) — 나머지는 한/글과 글자 하나까지 같아야 한다
  assert.equal(comp.replace(/^(.*?<hp:charPr prIDRef=")\d+/, '$1X'), HANGUL_COMPOSE.replace(/^(.*?<hp:charPr prIDRef=")\d+/, '$1X'));
  const again = open(doc.exportHwpx());
  const at = (para, charOffset) => JSON.parse(again.getComposeControlAt(JSON.stringify({ sec: 0, para, charOffset })));
  assert.deepEqual(at(1, 3), { found: true, ctrlIdx: at(1, 3).ctrlIdx, kind: 'ruby', mainText: '漢字', rubyText: '한자', below: false, styleId: null });
  assert.deepEqual({ ...at(2, 0), ctrlIdx: 0 }, { found: true, ctrlIdx: 0, kind: 'overlap', text: '12', shape: 1, innerSize: -3, overlap: true });
  assert.equal(at(1, 0).found, false, '덧말이 없는 자리');
  assert.equal(again.getTextRange(0, 1, 0, again.getParagraphLength(0, 1)), doc.getTextRange(0, 1, 0, doc.getParagraphLength(0, 1)), '글은 그대로');
});

test('덧말 고치기·지우기(본말 남김), 글자 겹침 지우기', async () => {
  const { doc } = withCompose();
  const ruby = JSON.parse(doc.getComposeControlAt(JSON.stringify({ sec: 0, para: 1, charOffset: 3 })));
  doc.setComposeControl(0, 1, ruby.ctrlIdx, JSON.stringify({ mainText: '漢字', rubyText: 'かんじ', below: true, styleId: null }));
  let xml = await sectionXml(doc.exportHwpx());
  assert.match(xml, /<hp:dutmal posType="BOTTOM"[^>]*><hp:mainText>漢字<\/hp:mainText><hp:subText>かんじ<\/hp:subText><\/hp:dutmal>/);
  const before = doc.getTextRange(0, 1, 0, doc.getParagraphLength(0, 1));
  doc.deleteComposeControl(0, 1, ruby.ctrlIdx, true);
  assert.equal(doc.getTextRange(0, 1, 0, doc.getParagraphLength(0, 1)), before.slice(0, 3) + '漢字' + before.slice(3), '본말이 그 자리 글로 남는다');
  const ov = JSON.parse(doc.getComposeControlAt(JSON.stringify({ sec: 0, para: 2, charOffset: 0 })));
  doc.deleteComposeControl(0, 2, ov.ctrlIdx, false);
  xml = await sectionXml(doc.exportHwpx());
  assert.ok(!/<hp:dutmal\b|<hp:compose\b/.test(xml));
});

// ── 4) 서버 diffDocs ──
test('서버 diffDocs: 손대지 않은 내보내기는 덩어리 없음 · 덧말/겹침 넣기·고치기·지우기는 object 덩어리 → copyObjectsFrom', async () => {
  const bytes = fs.readFileSync(FX);
  const untouched = Buffer.from(open(bytes).exportHwpx());
  const base = await HwpxDoc.load(untouched);
  assert.equal((await diffDocs(base, await HwpxDoc.load(Buffer.from(open(untouched).exportHwpx())))).hunks.length, 0, '손대지 않은 내보내기');

  const { doc } = withCompose();
  const head = await HwpxDoc.load(Buffer.from(doc.exportHwpx()));
  const d = await diffDocs(base, head);
  const objs = d.hunks.filter((h) => h.type === 'object');
  assert.deepEqual(objs.map((h) => [h.ref, h.objectSummary]), [['s0/p1', '조판 부호 넣음: 덧말'], ['s0/p2', '조판 부호 넣음: 글자 겹침']]);
  assert.equal(d.hunks.filter((h) => h.type === 'replace').length, 0, '글은 그대로');
  for (const h of objs) assert.ok(base.copyObjectsFrom(head, h.headRef, h.ref));
  assert.equal((await diffDocs(base, head)).hunks.length, 0, '옮긴 뒤 차이 없음');
  const saved = await sectionXml(await base.save());
  assert.ok(saved.includes(HANGUL_DUTMAL));
  assert.match(saved, /<hp:t>둘째<\/hp:t><hp:dutmal\b|둘째[^<]*<\/hp:t><hp:dutmal\b/, '덧말이 "둘째" 뒤 자리에');
  assert.match(saved, /<hp:compose circleType="SHAPE_CIRCLE" charSz="-3" composeType="OVERLAP" charPrCnt="10" composeText="12">/);
  // 서버 문서를 다시 편집기 엔진으로 열면 같은 덧말·겹침
  const reopened = open(await base.save());
  assert.equal(JSON.parse(reopened.getComposeControlAt(JSON.stringify({ sec: 0, para: 1, charOffset: 3 }))).rubyText, '한자');
  assert.equal(JSON.parse(reopened.getComposeControlAt(JSON.stringify({ sec: 0, para: 2, charOffset: 0 }))).text, '12');

  // 고치기 → 덩어리(지움+넣음) → 반영 / 지우기 → 덩어리 → 반영
  const edited = open(await base.save());
  const ruby = JSON.parse(edited.getComposeControlAt(JSON.stringify({ sec: 0, para: 1, charOffset: 3 })));
  edited.setComposeControl(0, 1, ruby.ctrlIdx, JSON.stringify({ mainText: '漢字', rubyText: '한짜', below: false, styleId: null }));
  const ov = JSON.parse(edited.getComposeControlAt(JSON.stringify({ sec: 0, para: 2, charOffset: 0 })));
  edited.deleteComposeControl(0, 2, ov.ctrlIdx, false);
  const head2 = await HwpxDoc.load(Buffer.from(edited.exportHwpx()));
  const d2 = (await diffDocs(base, head2)).hunks.filter((h) => h.type === 'object');
  assert.deepEqual(d2.map((h) => h.ref), ['s0/p1', 's0/p2']);
  for (const h of d2) assert.ok(base.copyObjectsFrom(head2, h.headRef, h.ref));
  const saved2 = await sectionXml(await base.save());
  assert.match(saved2, /<hp:subText>한짜<\/hp:subText>/);
  assert.ok(!saved2.includes('<hp:subText>한자</hp:subText>'));
  assert.ok(!/<hp:compose\b/.test(saved2));
});

// ── 5) 날짜/시간 코드 ──
test('날짜/시간 코드: 한/글 2022 InsertFieldDateTime 저장 꼴(DATE 필드 + 파라미터 4개 + 안 글) · 서버가 글과 필드 부호를 함께 옮긴다', async () => {
  const bytes = fs.readFileSync(FX);
  const doc = open(bytes);
  const text = '2026년 11월 11일';
  const r = JSON.parse(doc.insertDateCode(0, 0, 0, text));
  assert.deepEqual([r.ok, r.charOffset, r.length], [true, 0, [...text].length]);
  const xml = await sectionXml(doc.exportHwpx());
  const hangul = PROBE.date.xml;
  const params = (x) => /<hp:fieldBegin\b[^>]*type="DATE"[^>]*>(<hp:parameters[\s\S]*?<\/hp:parameters>)/.exec(x)?.[1];
  assert.equal(params(xml), params(hangul), '파라미터는 한/글 저장본과 같다');
  assert.match(xml, /<hp:fieldBegin\b[^>]*type="DATE"[^>]*editable="0"[^>]*dirty="0"/);
  assert.match(xml, new RegExp(`</hp:fieldBegin></hp:ctrl><hp:t>${text}</hp:t><hp:ctrl><hp:fieldEnd[ >]`), '날짜 글이 필드 안에');
  const again = open(doc.exportHwpx());
  assert.equal(again.getTextRange(0, 0, 0, [...text].length), text);
  // 문단 끝 날짜 코드 뒤에 친 글은 필드 밖이고, 그 뒤에 또 코드를 넣을 수 있다(원시 슬롯이 어긋나 실패하던 결함 — 2026-11-12)
  const d2 = open(bytes);
  d2.insertDateCode(0, 3, d2.getParagraphLength(0, 3), '2026년');
  d2.insertText(0, 3, d2.getParagraphLength(0, 3), ' 뒤');
  assert.ok(JSON.parse(d2.insertDateCode(0, 3, d2.getParagraphLength(0, 3), '2027년')).ok);
  const x2 = await sectionXml(d2.exportHwpx());
  assert.match(x2, /<hp:t>2026년<\/hp:t><hp:ctrl><hp:fieldEnd[^>]*\/><\/hp:ctrl><hp:t> 뒤<\/hp:t>/);

  const base = await HwpxDoc.load(Buffer.from(open(bytes).exportHwpx()));
  const head = await HwpxDoc.load(Buffer.from(doc.exportHwpx()));
  const d = await diffDocs(base, head);
  const rep = d.hunks.find((h) => h.type === 'replace' && h.ref === 's0/p0');
  const obj = d.hunks.find((h) => h.type === 'object' && h.ref === 's0/p0');
  assert.ok(rep && obj, JSON.stringify(d.hunks.map((h) => [h.type, h.ref, h.objectSummary])));
  assert.match(obj.objectSummary, /날짜 코드/);
  for (const id of base.mergeParagraphText('s0/p0', rep.newText, { author: 't' }) ?? []) base.acceptChange(id);
  assert.ok(base.copyObjectsFrom(head, obj.headRef, obj.ref));
  assert.equal((await diffDocs(base, head)).hunks.length, 0, '옮긴 뒤 차이 없음');
  const saved = await sectionXml(await base.save());
  assert.equal(params(saved), params(hangul));
  assert.match(saved, new RegExp(`<hp:fieldBegin [^>]*type="DATE"[^]*?</hp:fieldBegin></hp:ctrl><hp:t>${text}</hp:t><hp:ctrl><hp:fieldEnd[ >]`));
});

test('일어 바꾸기 순수 규칙: 히라가나 ↔ 가타카나(유니코드 차례, 반각은 그대로)', () => {
  assert.equal(conv.convertKana('ひらがな ゝ ｶ 가', true), 'ヒラガナ ヽ ｶ 가');
  assert.equal(conv.convertKana('カタカナ ヾ', false), 'かたかな ゞ');
});

// ── 6) 한자로 바꾸기·한글로 바꾸기(글자 단위, Unihan 표) ──
const hanja = await import(pathToFileURL(path.join(root, 'vendor/rhwp/rhwp-studio/src/ui/h2022-hanja.ts')).href);
const hanjaData = await import(pathToFileURL(path.join(root, 'vendor/rhwp/rhwp-studio/src/ui/generated/h2022-hanja-data.ts')).href);

test('한자 표: 생성물 머리(Unihan 판·해시·라이선스 고지)와 크기, 음절 후보 차례(본음·KS 먼저)', () => {
  const t = hanja.parseHanjaData(hanjaData.HANJA_DATA);
  assert.ok(t.byHanja.size > 8000, `한자 ${t.byHanja.size}`);
  const src = fs.readFileSync(path.join(root, 'vendor/rhwp/rhwp-studio/src/ui/generated/h2022-hanja-data.ts'), 'utf8');
  assert.match(src, /^\/\/ 생성물 — 손으로 고치지 않는다\. scripts\/gen-hanja-table\.mjs/);
  assert.ok(fs.readFileSync(path.join(root, 'vendor/rhwp/rhwp-studio/src/ui/generated/UNICODE-LICENSE-unihan.txt'), 'utf8').includes('UNICODE LICENSE V3'));
  const han = hanja.hanjaCandidates(t, '한').map((e) => e.c);
  for (const c of ['漢', '韓', '寒', '限']) assert.ok(han.includes(c), c);
  // '이' 는 본음 이(二·以 …)가 먼저, 두음 꼴로 '이' 를 가진 李·理 는 뒤에
  const yi = hanja.hanjaCandidates(t, '이').map((e) => e.c);
  assert.ok(yi.indexOf('二') < yi.indexOf('李') && yi.indexOf('以') < yi.indexOf('理'));
  assert.equal(hanja.formatHanja('漢', '한', 'hanja'), '漢');
  assert.equal(hanja.formatHanja('漢', '한', 'hanjaHangul'), '漢(한)');
  assert.equal(hanja.formatHanja('漢', '한', 'hangulHanja'), '한(漢)');
});

test('한글로 바꾸기(글자 단위): 두음 법칙(낱말 첫머리)·렬/률(모음·ㄴ 뒤) — 맞춤법 규칙 기대값(한/글 실측 아님, 원장)', () => {
  const t = hanja.parseHanjaData(hanjaData.HANJA_DATA);
  assert.equal(hanja.dueum('리'), '이'); assert.equal(hanja.dueum('녀'), '여'); assert.equal(hanja.dueum('락'), '낙'); assert.equal(hanja.dueum('노'), '노');
  assert.equal(hanja.hanjaToHangul(t, '李 理由 女子 男女 來日 未來 年 每年 良心 改良 龍 恐龍'), '이 이유 여자 남녀 내일 미래 연 매년 양심 개량 용 공룡');
  assert.equal(hanja.hanjaToHangul(t, '比率 效率 能率 羅列 先烈 分裂 歷史 經歷'), '비율 효율 능률 나열 선열 분열 역사 경력');
  assert.equal(hanja.hanjaToHangul(t, '韓國語(漢字) 敎育', 'hanjaHangul'), '韓國語(한국어)(漢字(한자)) 敎育(교육)');
  assert.equal(hanja.hanjaToHangul(t, '가나 abc 123'), '가나 abc 123', '한자 아닌 글은 그대로');
  // 낱말 사전이 없어 틀리는 것(원장의 한계): 音樂 → 음락(한/글 사전은 음악), 不正 → 불정(부정)
  assert.equal(hanja.hanjaToHangul(t, '音樂 不正'), '음락 불정');
});

// ── 7) 쪽·구역 이동, 찾아가기 스타일(엔진 계산값) ──
const nav = await import(pathToFileURL(path.join(root, 'vendor/rhwp/rhwp-studio/src/engine/h2022-navigation.ts')).href);
const bridgeOf = (doc) => ({
  getPageOfPosition: (s, p) => JSON.parse(doc.getPageOfPosition(s, p)),
  getPositionOfPage: (g) => JSON.parse(doc.getPositionOfPage(g)),
  getSectionCount: () => doc.getSectionCount(),
  getParagraphCount: (s) => doc.getParagraphCount(s),
  getParagraphLength: (s, p) => doc.getParagraphLength(s, p),
  getPageInfo: (g) => JSON.parse(doc.getPageInfo(g)),
  hitTest: (g, x, y) => JSON.parse(doc.hitTest(g, x, y)),
  getCursorRect: (s, p, o) => JSON.parse(doc.getCursorRect(s, p, o)),
  get pageCount() { return doc.pageCount(); },
});

test('쪽 처음/끝·앞뒤 쪽·구역 이동 자리(engine/h2022-navigation.ts — 엔진 getPositionOfPage 로 셈)', () => {
  const doc = open(fs.readFileSync(FX));
  // 셋째 문단을 길게 해 쪽을 여럿으로
  doc.insertText(0, 2, 0, '가나다라마바사 '.repeat(900));
  const w = bridgeOf(doc);
  assert.ok(w.pageCount >= 3, `쪽 ${w.pageCount}`);
  const p1 = nav.pageStart(w, 1);
  assert.deepEqual([p1.sectionIndex, p1.paragraphIndex], [0, 2]);
  assert.ok(p1.charOffset > 0, '둘째 쪽은 긴 문단 가운데서 시작');
  const e0 = nav.pageEnd(w, 0);
  assert.deepEqual([e0.paragraphIndex, e0.charOffset, e0.cursorRect.pageIndex], [2, p1.charOffset, 0], '첫 쪽 끝 = 둘째 쪽 첫 자리와 같은 글자 번호, 캐럿은 첫 쪽');
  assert.equal(nav.pageOf(w, { sectionIndex: 0, paragraphIndex: 2, charOffset: p1.charOffset + 50 }), 1, '긴 문단 가운데의 쪽은 캐럿 사각형의 쪽');
  assert.deepEqual(nav.pageMoveTarget(w, { sectionIndex: 0, paragraphIndex: 2, charOffset: p1.charOffset + 50 }, 'pageBegin').charOffset, p1.charOffset);
  const last = nav.pageEnd(w, w.pageCount - 1);
  assert.deepEqual([last.paragraphIndex, last.charOffset], [doc.getParagraphCount(0) - 1, doc.getParagraphLength(0, doc.getParagraphCount(0) - 1)], '마지막 쪽 끝 = 문서 끝');
  assert.equal(nav.pageMoveTarget(w, { sectionIndex: 0, paragraphIndex: 0, charOffset: 0 }, 'pagePrev'), null, '첫 쪽 앞은 없음');
  assert.deepEqual(nav.pageMoveTarget(w, { sectionIndex: 0, paragraphIndex: 0, charOffset: 0 }, 'pageNext'), p1);
  assert.equal(nav.pageMoveTarget(w, { sectionIndex: 0, paragraphIndex: 0, charOffset: 0 }, 'sectionNext'), null, '구역이 하나뿐');
  assert.deepEqual(nav.pageMoveTarget(w, { sectionIndex: 0, paragraphIndex: 3, charOffset: 2 }, 'sectionPrev'), null);
  // 찾아가기 스타일: 캐럿 다음 문단부터, 끝에 닿으면 처음부터
  const styleOf = (p) => JSON.parse(doc.getStyleAt(0, p)).id;
  const want = styleOf(1);
  const hit = nav.findForward(w, { sec: 0, para: 1 }, (s, p) => (styleOf(p) === want ? 0 : null));
  assert.ok(hit, '같은 스타일 문단(한 바퀴 돌면 자기 자신이라도)');
  assert.equal(styleOf(hit.pos.paragraphIndex), want);
});

// ── 8) 상호 참조(표·책갈피) ──
const PROBE_XREF = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/h2022_edit_hangul_xref_probe.json'), 'utf8'));
const xrefParams = (x) => /<hp:fieldBegin\b[^>]*type="CROSSREF"[^>]*>(<hp:parameters[\s\S]*?<\/hp:parameters>)/.exec(x)?.[1] ?? null;
const xrefDialog = await import(pathToFileURL(path.join(root, 'vendor/rhwp/rhwp-studio/src/ui/h2022-edit-xref-dialog.ts')).href).catch(() => null);

test('상호 참조: 표(쪽·번호·위/아래)·책갈피 — 파라미터 8개가 한/글 2022 저장 꼴과 같다(표 id 만 다름) · 서버가 옮긴다', async () => {
  const bytes = fs.readFileSync(FX);
  const doc = open(bytes);
  JSON.parse(doc.createTable(0, 0, 0, 2, 2));
  const targets = JSON.parse(doc.getCrossRefTargets()).tables;
  assert.equal(targets.length, 1);
  doc.addBookmark(0, 2, 0, 'BM1');
  const last = doc.getParagraphCount(0) - 1;
  const len = () => doc.getParagraphLength(0, last);
  const put = (input) => JSON.parse(doc.insertCrossReference(0, last, len(), JSON.stringify(input)));
  const t = targets[0];
  const page = put({ kind: 'table', targetSec: t.sec, targetPara: t.para, targetCtrl: t.ctrlIdx, content: 'page', text: '1' });
  assert.ok(page.ok, JSON.stringify(page));
  const id = JSON.parse(doc.getCrossRefTargets()).tables[0].id;
  assert.ok(id > 0, '표 id 가 0 이면 새 번호를 준다');
  assert.equal(page.command, `?#${id};0;0;0;0;`);
  put({ kind: 'table', targetSec: t.sec, targetPara: t.para, targetCtrl: t.ctrlIdx, content: 'number', text: '1' });
  put({ kind: 'table', targetSec: t.sec, targetPara: t.para, targetCtrl: t.ctrlIdx, content: 'updown', text: '위' });
  put({ kind: 'bookmark', name: 'BM1', content: 'page', text: '1' });
  // 필드 끝에 이어 친 글은 필드 밖(한/글은 열 때 상호 참조 글을 다시 셈해 필드 안 글을 통째로 바꾼다 — COM 왕복 2026-11-12)
  doc.insertText(0, last, len(), ' 끝');
  const xml = await sectionXml(doc.exportHwpx());
  assert.match(xml, /\?BM1;6;0;0;0;[^]*?<\/hp:fieldBegin><\/hp:ctrl><hp:t>1<\/hp:t><hp:ctrl><hp:fieldEnd[^>]*\/><\/hp:ctrl><hp:t> 끝<\/hp:t>/, '이어 친 글이 필드 밖');
  const got = [...xml.matchAll(/<hp:fieldBegin\b[^>]*type="CROSSREF"[^>]*>(<hp:parameters[\s\S]*?<\/hp:parameters>)/g)].map((m) => m[1]);
  assert.equal(got.length, 4);
  const norm = (x) => x.replace(/\?#\d+;/g, '?#ID;');
  // 한/글 실측: 표·쪽 번호(t1), 표·번호, 표·위/아래
  for (const [i, name] of [[0, 'table_page'], [1, 'table_number'], [2, 'table_updown']]) assert.equal(norm(got[i]), norm(PROBE_XREF[name].params), name);
  // 책갈피: 한/글은 대상 종류 차례 6·TARGET_BOOKMARK·경로 = 책갈피 이름(실측은 창이 고른 이름 그대로 경로가 되는 것을 확인)
  assert.match(got[3], /<hp:stringParam name="Command">\?BM1;6;0;0;0;<\/hp:stringParam><hp:stringParam name="RefPath">\?BM1;<\/hp:stringParam><hp:stringParam name="RefType">TARGET_BOOKMARK<\/hp:stringParam>/);
  assert.match(xml, new RegExp(`<hp:tbl id="${id}"`), '표 id 가 내보낸 hp:tbl@id 와 같다');
  assert.match(xml, /type="CROSSREF"[^]*?<\/hp:fieldBegin><\/hp:ctrl><hp:t>위<\/hp:t><hp:ctrl><hp:fieldEnd[ >]/);
  // 다시 열어도 그대로
  assert.equal((await sectionXml(open(doc.exportHwpx()).exportHwpx())).match(/type="CROSSREF"/g).length, 4);
  if (xrefDialog) {
    assert.equal(xrefDialog.crossRefText('updown', { sec: 0, para: 0 }, { sec: 0, para: 3 }, () => 1), '위');
    assert.equal(xrefDialog.crossRefText('updown', { sec: 0, para: 5 }, { sec: 0, para: 3 }, () => 1), '아래');
    assert.equal(xrefDialog.crossRefText('number', { sec: 0, para: 0, number: 2 }, { sec: 0, para: 3 }, () => 1), '2');
  }

  // 서버: 표·책갈피가 든 기준 문서에 상호 참조만 더한 내보내기 → 글 + 부호 덩어리 → 반영
  const baseDoc = open(bytes);
  baseDoc.createTable(0, 0, 0, 2, 2);
  baseDoc.addBookmark(0, 2, 0, 'BM1');
  const baseBytes = Buffer.from(baseDoc.exportHwpx());
  const head = open(baseBytes);
  head.insertCrossReference(0, last, head.getParagraphLength(0, last), JSON.stringify({ kind: 'bookmark', name: 'BM1', content: 'page', text: '1' }));
  const base = await HwpxDoc.load(baseBytes);
  const headDoc = await HwpxDoc.load(Buffer.from(head.exportHwpx()));
  const d = await diffDocs(base, headDoc);
  const rep = d.hunks.find((h) => h.type === 'replace');
  const obj = d.hunks.find((h) => h.type === 'object');
  assert.ok(rep && obj && /상호 참조/.test(obj.objectSummary), JSON.stringify(d.hunks.map((h) => [h.type, h.ref, h.objectSummary])));
  for (const cid of base.mergeParagraphText(rep.ref, rep.newText, { author: 't' }) ?? []) base.acceptChange(cid);
  assert.ok(base.copyObjectsFrom(headDoc, obj.headRef, obj.ref));
  assert.equal((await diffDocs(base, headDoc)).hunks.length, 0);
  assert.match(await sectionXml(await base.save()), /\?BM1;6;0;0;0;[^]*?<\/hp:fieldBegin><\/hp:ctrl><hp:t>1<\/hp:t><hp:ctrl><hp:fieldEnd[ >]/);
});
