// 엔진 연기 시험: 고정 파일과 큰 보고서를 파싱하고, 메모·변경 추적을 넣고 수락/거절하고, 저장 후 다시 읽는다.
import fs from 'node:fs';
import path from 'node:path';
import { HwpxDoc } from '../engine/doc.js';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const fx = (n) => path.join(here, 'fixtures', n);
const outDir = path.join(here, 'out'); fs.mkdirSync(outDir, { recursive: true });

function show(doc, label) {
  console.log(`\n=== ${label} ===`);
  for (const p of doc.paragraphs({ view: 'markup' })) console.log(`[${p.ref}] (${p.where}) ${JSON.stringify(p.text)} changes=${p.changes.join(',')} memos=${p.memos.join(',')}`);
  console.log('changes:', doc.changes().map((c) => `${c.id}:${c.type}:${c.author}:${JSON.stringify(c.text)}@${c.ref}[${c.start},${c.end})`));
  console.log('memos:', doc.memos().map((m) => `${m.id}:${m.author}:${JSON.stringify(m.text)}@${m.ref}[${m.start},${m.end}) anchor=${JSON.stringify(m.anchorText)}`));
  console.log('tracking:', doc.trackingEnabled(), 'authors:', doc.authors().map((a) => a.name).join('/'));
}

// 1. 한글이 쓴 변경 추적 파일
let doc = await HwpxDoc.load(fs.readFileSync(fx('hangul_tracked.hwpx')));
show(doc, 'hangul_tracked (원본)');

// 2. 도구가 쓴 메모+변경 파일
doc = await HwpxDoc.load(fs.readFileSync(fx('tool_memo_tracked.hwpx')));
show(doc, 'tool_memo_tracked (원본)');

// 3. 편집: 메모 추가, 교체, 삽입, 삭제
const author = 'AI 검토자(Claude)';
const r1 = doc.find('s0/p1', '낱말을 넣습니다');
console.log('find:', r1);
console.log('replaceTracked →', doc.replaceTracked('s0/p1', r1.start, r1.end, '단어를 추가합니다', { author }));
console.log('insertTracked →', doc.insertTracked('s0/p0', 0, '[머리말] ', { author }));
const memoId = doc.addMemo('s0/p1', { start: 0, end: 6, author, text: '첫 어절을 더 분명히 쓰면 좋겠습니다.\n둘째 줄' });
console.log('addMemo →', memoId);
const memoId2 = doc.addMemo('s0/p2', { author, text: '문단 전체 메모' });
console.log('addMemo(전체) →', memoId2);
show(doc, '편집 후');

// 4. 저장 → 다시 읽기 → 같은가
const bytes = await doc.save();
fs.writeFileSync(path.join(outDir, 'edited.hwpx'), bytes);
const re = await HwpxDoc.load(bytes);
show(re, '저장 후 다시 읽음');

// 5. 수락/거절
const ch = re.changes();
const ins = ch.find((c) => c.type === 'Insert' && c.author === author);
console.log('reject insert', ins.id, re.rejectChange(ins.id));
const del = re.changes().find((c) => c.type === 'Delete' && c.author === author);
console.log('accept delete', del.id, re.acceptChange(del.id));
show(re, '거절·수락 후');
re.acceptAll();
show(re, '모두 수락');
fs.writeFileSync(path.join(outDir, 'accepted.hwpx'), await re.save());

// 6. 문단 글 병합(편집기에서 돌아온 글 가정)
const d3 = await HwpxDoc.load(fs.readFileSync(fx('tool_memo_tracked.hwpx')));
d3.acceptAll();
const texts = d3.paragraphs({ nested: false }).map((p) => p.text);
texts[1] = texts[1].replace('있던 낱말을', '있던 단어를') + ' 끝에 덧붙임.';
texts.push('새로 추가된 문단입니다.');
console.log('mergeBodyTexts →', JSON.stringify(d3.mergeBodyTexts({ 0: texts }, { author: '편집자 홍길동' })));
show(d3, '병합 후');
fs.writeFileSync(path.join(outDir, 'merged.hwpx'), await d3.save());

// 7. 큰 보고서 파싱 성능/견고성
for (const big of ['2025년_전체종합보고서.hwpx', '경영대학_경영전문대학원_응답자수_기초통계_2021-2025.hwpx'].map((n) => path.join(here, 'samples', n))) {
  if (!fs.existsSync(big)) continue;
  const t0 = Date.now();
  const d = await HwpxDoc.load(fs.readFileSync(big));
  const paras = d.paragraphs();
  const body = paras.filter((p) => p.where === '본문');
  console.log(`\n${path.basename(big)}: sections=${d.sections.length} paras=${paras.length} body=${body.length} ${Date.now() - t0}ms`);
  console.log(' sample:', body.slice(0, 5).map((p) => `[${p.ref}] ${p.text.slice(0, 40)}`));
  const nested = paras.filter((p) => p.where !== '본문').slice(0, 3).map((p) => `[${p.ref}] (${p.where}) ${p.text.slice(0, 30)}`);
  console.log(' nested:', nested);
  // 본문 첫 글 있는 문단에 메모 + 교체 후 저장
  const target = body.find((p) => p.length > 10);
  d.addMemo(target.ref, { start: 0, end: Math.min(5, target.length), author, text: '큰 문서 메모 시험' });
  d.replaceTracked(target.ref, 0, 2, 'XX', { author });
  const t1 = Date.now();
  const saved = await d.save();
  fs.writeFileSync(path.join(outDir, path.basename(big).replace(/\.hwpx$/, '_edited.hwpx')), saved);
  console.log(` edited+saved ${saved.length} bytes in ${Date.now() - t1}ms; changes=${d.changes().length} memos=${d.memos().length}`);
}
console.log('\nOK');
