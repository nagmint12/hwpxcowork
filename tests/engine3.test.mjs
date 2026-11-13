// node --test tests/engine3.test.mjs — v0.2 통합 보정: 메모 넣기·빼기는 줄 정보(lineseg)를 지키고 textpos 만 옮긴다,
// 메모 날짜는 한글 형식(FILETIME), 보기용 사본의 rhwp 조판 보정, 넣은 표는 [표 N] 번호 매기기에서 빠진다.
// 한글이 다시 저장한 값과의 대조는 tests/e2e_flow.py(한글 2022 왕복)에서 한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { HwpxDoc, memoCreated } from '../engine/doc.js';

const BIZ = decodeURIComponent(new URL('./samples/경영대학_경영전문대학원_응답자수_기초통계_2021-2025.hwpx', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const hasBiz = fs.existsSync(BIZ);
const biz = () => HwpxDoc.load(fs.readFileSync(BIZ));
const reload = async (d) => HwpxDoc.load(await d.save());
const tpos = (d, i) => { const sec = d.sections[0]; const p = sec.bodyParas[i]; return [...sec.xml.slice(p.start, p.end).matchAll(/<hp:lineseg\b[^>]*?\btextpos="(\d+)"/g)].map((m) => Number(m[1])); };
const hasLs = (d, i) => !!d.sections[0].bodyParas[i].lineseg;

test('메모 넣기·빼기: 줄 정보를 지키고 textpos 를 컨트롤 하나당 8 옮긴다(한글과 같은 규칙)', { skip: !hasBiz && 'biz 표본 없음' }, async () => {
  const d = await biz();
  const t0 = tpos(d, 9); assert.equal(t0.length, 2, 's0/p9 는 두 줄 문단');
  const len = [...d.text('s0/p9')].length;
  // 문단 앞 5글자에 메모: 시작 컨트롤(0 위치)과 끝 컨트롤(5 뒤) 모두 둘째 줄보다 앞 → 둘째 줄 +16
  const m1 = d.addMemo('s0/p9', { start: 0, end: 5, author: '홍길동', text: '앞 메모' });
  assert.ok(hasLs(d, 9), '줄 정보가 남는다');
  assert.deepEqual(tpos(d, 9), [0, t0[1] + 16]);
  // 둘째 줄 안쪽 범위 메모: 둘째 줄 시작보다 뒤 → 그대로
  const m2 = d.addMemo('s0/p9', { start: len - 3, end: len, author: '홍길동', text: '뒤 메모' });
  assert.deepEqual(tpos(d, 9), [0, t0[1] + 16]);
  // 문단 전체 메모: 시작 컨트롤만 둘째 줄 앞 → +8
  const m3 = d.addMemo('s0/p9', { author: '김검토', text: '전체 메모' });
  assert.deepEqual(tpos(d, 9), [0, t0[1] + 24]);
  const r = await reload(d); assert.deepEqual(tpos(r, 9), [0, t0[1] + 24], '저장·다시 읽기 뒤에도');
  assert.equal(r.text('s0/p9'), d.text('s0/p9'));
  r.deleteMemo(m3); assert.deepEqual(tpos(r, 9), [0, t0[1] + 16]);
  r.deleteMemo(m1); r.deleteMemo(m2); assert.deepEqual(tpos(r, 9), t0, '모두 지우면 원래 값');
  // 글을 바꾸면(변경 추적) 줄 정보는 지운다(줄 나눔이 달라지므로)
  const f = r.find('s0/p9', r.text('s0/p9').slice(0, 2)); r.replaceTracked('s0/p9', f.start, f.end, '바뀐', { author: '홍길동' });
  assert.ok(!hasLs(r, 9));
});

test('메모 넣기: 모르는 요소(변경 표식·탭 등)가 있는 문단은 줄 정보를 지운다', { skip: !hasBiz && 'biz 표본 없음' }, async () => {
  const d = await biz();
  const f = d.find('s0/p9', d.text('s0/p9').slice(3, 5)); d.insertTracked('s0/p9', f.end, '(덧붙임)', { author: '홍길동' });
  const r = await reload(d);
  assert.ok(!hasLs(r, 9), '글을 넣은 문단은 이미 줄 정보 없음');
  // 줄 정보가 있는 다른 문단에 변경 표식을 손으로 넣은 경우는 엔진이 만들 수 없으므로, 첫 문단(구역 설정 컨트롤)으로 확인
  const p0 = r.sections[0].bodyParas[0];
  if (p0.lineseg && r.text('s0/p0')) { r.addMemo('s0/p0', { start: 0, end: 1, author: 'x', text: 'm' }); assert.ok(!hasLs(r, 0), '구역 설정 컨트롤이 든 문단은 지운다'); }
});

test('메모 날짜: Command = FILETIME(아래·위 32비트), CreateDateTime = 지역 시간+Z, memos().created 는 UTC ISO', async () => {
  const when = new Date(Date.UTC(2026, 9, 22, 5, 30, 15));
  const d = await HwpxDoc.load(fs.readFileSync(new URL('./fixtures/tool_memo_tracked.hwpx', import.meta.url)));
  const ref = d.paragraphs({ nested: false }).find((p) => p.text).ref;
  const id = d.addMemo(ref, { author: '홍길동', text: '날짜 시험', date: when });
  const xml = d.sections.map((s) => s.xml).join('');
  const ft = (BigInt(when.getTime()) + 11644473600000n) * 10000n;
  assert.ok(xml.includes(`MEMO/65535/`) && xml.includes(`/${Number(ft & 0xffffffffn)}/${Number(ft >> 32n)}/홍길동/`), 'Command 에 FILETIME');
  const pad = (n) => String(n).padStart(2, '0');
  const local = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}T${pad(when.getHours())}:${pad(when.getMinutes())}:${pad(when.getSeconds())}Z`;
  assert.ok(xml.includes(`<hp:stringParam name="CreateDateTime">${local}</hp:stringParam>`), 'CreateDateTime = 지역 시간 + Z(한글이 쓰는 모양)');
  assert.equal(d.memos().find((m) => m.id === id).created, when.toISOString());
  // 예전 엔진(첫 수 = epoch 초)이 쓴 메모, 한글이 그것을 2599년으로 읽고 다시 쓴 CreateDateTime 도 바른 시각으로
  assert.equal(memoCreated('MEMO/65535/1/1792614186/73386000/홍길동/\\;;', '2599-10-20T03:52:57Z'), new Date(1792614186000).toISOString());
  assert.equal(memoCreated(null, '2026-10-21T06:40:00Z'), '2026-10-21T06:40:00Z');
});

test('보기용 사본(viewerCopy): 누락 줄이 있어도 떠 있는 표 앞의 정상 저장 줄을 보존한다', { skip: !hasBiz && 'biz 표본 없음' }, async () => {
  const d = await biz();
  // 첫 표를 '떠 있는 표'(글자처럼 취급 아님)로 바꾼 문서를 만든다
  const sec = d.sections[0]; const tp = sec.bodyParas[3];
  const seg = sec.xml.slice(tp.start, tp.end); const at = seg.indexOf('treatAsChar="1"'); assert.ok(at >= 0);
  sec.load(sec.xml.slice(0, tp.start + at) + 'treatAsChar="0"' + sec.xml.slice(tp.start + at + 'treatAsChar="1"'.length));
  const base = await reload(d);
  assert.ok(hasLs(base, 2), '표 앞 문단(s0/p2)은 줄 정보가 있다');
  let v = await base.viewerCopy(); assert.equal(v.layoutFixed, 0, '모든 문단에 줄 정보가 있으면 그대로(한글 조판 그대로 그림)');
  // 메모만 넣으면 줄 정보가 남으므로 여전히 그대로
  base.addMemo('s0/p9', { start: 0, end: 3, author: 'x', text: 'm' }); v = await base.viewerCopy(); assert.equal(v.layoutFixed, 0);
  // 글을 고친 문단의 줄 복원은 엔진이 맡고, 앞 표지·표 앵커의 정상 줄은 보존한다.
  const f = base.find('s0/p9', base.text('s0/p9').slice(0, 2)); base.replaceTracked('s0/p9', f.start, f.end, '바뀐', { author: 'x' });
  v = await base.viewerCopy(); assert.equal(v.layoutFixed, 0);
  assert.ok(v.sections[0].bodyParas[2].lineseg && v.sections[0].bodyParas[4].lineseg, '관련 없는 정상 줄은 보존');
  assert.ok(hasLs(base, 2), '원본(변경추적본)은 그대로');
  assert.equal((await reload(v)).text('s0/p2'), base.text('s0/p2'));
});

test('한글이 다시 저장해 변경 항목을 묶은 파일(TcId 공유): 변경마다 작성자·종류를 바르게 읽고 1:1 로 펼친다', async () => {
  // tests/fixtures/hangul_resaved_dedup.hwpx = 고정 파일에 같은 분의 변경을 더해 한글 2022 가 다시 저장한 것(표식 10개 → 헤더 항목 6개)
  const raw = fs.readFileSync(new URL('./fixtures/hangul_resaved_dedup.hwpx', import.meta.url));
  const d = await HwpxDoc.load(raw);
  assert.equal(d.normalized, 10, '표식 Id 10개를 헤더 항목 10개로 펼침');
  const count = (type, author) => d.changes().filter((c) => c.type === type && c.author === author).length;
  assert.deepEqual([count('Insert', '홍길동'), count('Delete', '홍길동'), count('Insert', 'Nag'), count('Delete', 'Nag'), count('Insert', 'AI 검토자'), count('Delete', 'AI 검토자')], [4, 1, 2, 1, 1, 1]);
  assert.deepEqual(d.changes().map((c) => c.id), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.ok(d.memos().some((m) => m.text.startsWith('[AI 작업 #1]') && new Date(m.created).getUTCFullYear() >= 2026), '메모·날짜');
  // 펼친 문서에서 거절·수락이 다른 변경의 작성자를 흔들지 않는다
  const before = d.changes().filter((c) => c.author === 'Nag').length;
  const hong = d.changes().find((c) => c.type === 'Insert' && c.author === '홍길동');
  d.rejectChange(hong.id);
  assert.equal(count('Insert', '홍길동'), 3); assert.equal(d.changes().filter((c) => c.author === 'Nag').length, before);
  const r = await HwpxDoc.load(await d.save());
  assert.equal(r.normalized, 0, '저장하면 1:1 모양');
  assert.equal(r.changes().length, 9);
  // 원래 1:1 인 파일은 건드리지 않는다
  assert.equal((await HwpxDoc.load(fs.readFileSync(new URL('./fixtures/tool_memo_tracked.hwpx', import.meta.url)))).normalized, 0);
});

test('넣은 표 번호: 캡션이 있으면 번호 종류 표(TABLE)+자동 번호 캡션, 없으면 없음(NONE — 뒤 [표 N] 이 건너뛰지 않게)', { skip: !hasBiz && 'biz 표본 없음' }, async () => {
  const d = await biz();
  const sec = d.sections[0];
  const tblOf = (ref) => { const p = sec.bodyParas[Number(ref.split('/p')[1])]; return sec.xml.slice(p.start, p.end); };
  const n0 = (sec.xml.match(/numberingType="TABLE"/g) || []).length;
  // 표 2개 뒤(s0/p7 다음)에 넣으면 자동 번호는 51(새 번호) + 2 = 53
  const res = d.insertTableAfter(0, 7, { rows: [['구분', '값'], ['가', '1']], headerRows: 1, caption: '표. 시험' }, { author: '홍길동' });
  assert.match(/<hp:tbl\b[^>]*>/.exec(tblOf(res.ref))[0], /numberingType="TABLE"/);
  assert.match(tblOf(res.ref), /<hp:autoNum num="53" numType="TABLE">/);
  const none = d.insertTableAfter(0, 0, { rows: [['구분', '값'], ['가', '1']], headerRows: 1 }, { author: '홍길동' });
  assert.match(/<hp:tbl\b[^>]*>/.exec(tblOf(none.ref))[0], /numberingType="NONE"/);
  assert.doesNotMatch(tblOf(none.ref), /<hp:caption/);
  // 원래 표들은 그대로 TABLE
  assert.equal((sec.xml.match(/numberingType="TABLE"/g) || []).length, n0 + 1);
  const re = await HwpxDoc.load(await d.save());
  assert.equal(re.tables().find((t) => t.key === `s0/p9#t0`).caption.text, '[표 ] 시험');
});
