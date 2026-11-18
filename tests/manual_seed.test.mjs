// 따라하기 설명서(docs/manuals) 넣기 — 공용 문서함 폴더·문서 5건·'AI 작업 맡기기'의 실제 요청 기록(완료·대기열·실패)과 메모·답글.
// 설명서 HWPX 는 scripts/build-manuals.mjs 가 만든 것을 그대로 쓴다(편집기 엔진으로 다시 열리는지도 본다).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './helpers/server.mjs';
import { seedManuals, replaceManuals } from '../server/manual-seed.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const dir = path.join(root, 'docs', 'manuals');

test('설명서 파일: manifest 의 HWPX 5건이 있고 따라하기 영역·예시 문단 표시가 들어 있다', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.folder, '따라하기 설명서');
  assert.equal(manifest.documents.length, 5);
  for (const d of manifest.documents) assert.ok(fs.statSync(path.join(dir, d.file)).size > 5000, d.file);
  assert.equal(manifest.documents.filter((d) => d.scenario === 'ai-requests').length, 1);
});

// 표준서식의 앞부분+본문 구조를 유지한다. 2026-11-17 사용자 요청으로 튜토리얼 앞부분에도 홀짝 바탕쪽을 연결했고,
// 2026-11-18 사용자 요청으로 1~3쪽도 4쪽처럼 쪽배경을 보인다(바탕쪽 감추기 없음 — scripts/tutorial_backgrounds.py).
test('설명서 서식: 표준서식 표지·차례 구역, 장·절 스타일, 차례 항목에 차례제목·차례1·차례2', async () => {
  const { HwpxDoc } = await import('../engine/doc.js');
  const { tocRegions, physicalParas } = await import('../engine/toc.js');
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.format, '대학혁신센터 표준서식');
  for (const d of manifest.documents) {
    const doc = await HwpxDoc.load(fs.readFileSync(path.join(dir, d.file)));
    assert.equal(doc.sections.length, 2, d.file);
    assert.match(doc.sections[0].xml, /masterPageCnt="2"/, `앞부분에도 홀짝 바탕쪽 연결: ${d.file}`);
    assert.equal((doc.sections[0].xml.match(/<hp:masterPage\b/g) || []).length, 2, d.file);
    assert.doesNotMatch(doc.sections.map((s) => s.xml).join(''), /<hp:pageHiding\b[^>]*hideMasterPage="1"/, `1~3쪽도 바탕쪽을 감추지 않음: ${d.file}`);
    assert.ok(!/<hp:linesegarray>/.test(doc.sections.map((s) => s.xml).join('')), `줄 배치 캐시 없음(한/글이 다시 계산): ${d.file}`);
    const styleId = (name) => (new RegExp(`<hh:style\\b[^>]*\\bid="(\\d+)"[^>]*\\bname="${name.replace(/[.)]/g, '\\$&')}"`).exec(doc.header.xml) || [])[1];
    const chapter = styleId('&amp;본문 1.');
    assert.ok(chapter && doc.sections[1].xml.includes(`styleIDRef="${chapter}"`), `장 제목이 &본문 1. 스타일: ${d.file}`);
    const reg = tocRegions(doc)[0];
    assert.ok(reg && reg.sec === 0, `차례 필드가 앞부분 구역에: ${d.file}`);
    const phys = physicalParas(doc.sections[0]);
    const tocXml = doc.sections[0].xml.slice(phys[reg.start].start, phys[reg.end].end);
    assert.match(tocXml.slice(0, 200), /pageBreak="1"/, `차례는 새 쪽에서: ${d.file}`);
    for (const name of ['차례제목', '차례1']) assert.ok(tocXml.includes(`styleIDRef="${styleId(name)}"`), `차례에 ${name} 스타일: ${d.file}`);
    assert.ok(!/&lt;그림 차례&gt;/.test(tocXml) || /\[그림 /.test(tocXml), `빈 그림 차례 머리 없음: ${d.file}`);
  }
});

// 차례 새로 고침이 기존 바탕쪽 연결과 첫 차례 문단의 쪽 나누기를 남기고 바탕쪽 감추기를 새로 넣지 않는다.
test('편집기 엔진: 표준서식 설명서의 차례를 새로 고쳐도 차례가 새 쪽에서 시작하고 앞부분 구역의 바탕쪽 연결이 남는다', async () => {
  const { refreshTocInEngine } = await import('../server/toc-engine.js');
  const { HwpxDoc } = await import('../engine/doc.js');
  const { containerFromBytesSync, tocRegions, physicalParas } = await import('../engine/toc.js');
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const file = path.join(dir, manifest.documents.find((d) => d.order === 1).file);
  const before = await HwpxDoc.load(fs.readFileSync(file));
  const reg = tocRegions(before)[0];
  const out = refreshTocInEngine(fs.readFileSync(file), { sec: reg.sec, para: reg.start });
  const after = new HwpxDoc(containerFromBytesSync(out.bytes));
  assert.match(after.sections[0].xml, /masterPageCnt="2"/);
  assert.doesNotMatch(after.sections[0].xml, /<hp:pageHiding\b[^>]*hideMasterPage="1"/);
  const first = physicalParas(after.sections[0])[out.start];
  assert.match(after.sections[0].xml.slice(first.start, first.start + 200), /pageBreak="1"/);
});

test('설명서 넣기: 공용 폴더·문서·요청 4건(완료/대기열/실패/대기열)·메모와 답글', { timeout: 120000 }, async () => {
  const srv = await startServer({ ai: 'off' });
  try {
    const out = await seedManuals({ base: srv.base, token: srv.tokens.admin, dir });
    const A = srv.api('admin');
    const lib = await A('/api/library?includeTutorialTemplates=1');
    const folder = lib.folders.find((f) => f.id === out.folderId);
    assert.equal(folder?.name, '따라하기 설명서');
    assert.equal(folder.space, 'public');
    assert.equal(out.docs.length, 5);
    // 공용이라 편집자도 읽는다
    const E = srv.api('a');
    const seen = (await E('/api/library')).docs.map((d) => d.id);
    for (const d of out.docs) assert.equal(seen.includes(d.id), d.scenario === 'ai-requests', '사용하지 않은 설명서는 튜토리얼 메뉴로 대체, 예시 기록은 보존');
    // 'AI 작업 맡기기' 의 실제 기록
    const ai = out.docs.find((d) => d.scenario === 'ai-requests');
    const reqs = await A(`/api/docs/${ai.id}/requests`);
    assert.deepEqual(reqs.map((r) => r.status), ['done', 'pending', 'failed', 'pending']);
    const proposals = (await A(`/api/docs/${ai.id}/proposals`)).filter((p) => p.rid === reqs[0].rid);
    assert.equal(proposals.length, 3);
    assert.ok(proposals.every((p) => p.status === 'pending'), '제안은 사람이 정하도록 남겨 둔다');
    const memos = await A(`/api/docs/${ai.id}/memos`);
    const human = memos.find((x) => x.text.startsWith('수치의 근거'));
    assert.ok(human, '사람 메모');
    assert.ok(JSON.stringify(human).includes('표본 수와 시기'), 'AI 답글');
    // 한 번 더 넣으면 같은 폴더를 다시 쓴다(새 폴더를 만들지 않음)
    const again = await seedManuals({ base: srv.base, token: srv.tokens.admin, dir });
    assert.equal(again.folderId, out.folderId);
  } finally { await srv.stop(); }
});

test('설명서 새 판으로 바꾸기(--replace): 쓴 흔적 없는 옛 판은 지우고, 다른 사람이 메모를 단 것은 관리자 개인 문서함으로 옮긴다', { timeout: 120000 }, async () => {
  const srv = await startServer({ ai: 'off' });
  try {
    const out = await seedManuals({ base: srv.base, token: srv.tokens.admin, dir });
    const E = srv.api('a');
    const used = out.docs.find((d) => d.file.startsWith('00'));
    const p0 = (await E(`/api/docs/${used.id}/paragraphs`)).find((p) => p.text && p.kind === 'text');
    await E(`/api/docs/${used.id}/memos`, { method: 'POST', body: { ref: p0.ref, text: '연습 메모' } });
    const rep = await replaceManuals({ base: srv.base, token: srv.tokens.admin, dir });
    assert.equal(rep.moved.length, 1);
    assert.equal(rep.removed.length, 4, 'AI 작업 설명서(넣을 때 남긴 예시 기록뿐)도 지운다');
    assert.equal(rep.folderId, out.folderId);
    const A = srv.api('admin');
    const lib = await A('/api/library?includeTutorialTemplates=1');
    const inFolder = lib.docs.filter((d) => d.folderId === out.folderId);
    assert.deepEqual(inFolder.map((d) => d.id).sort(), rep.docs.map((d) => d.id).sort(), '폴더에는 새 판 5건만');
    const kept = lib.docs.find((d) => d.id === used.id);
    assert.deepEqual([kept.space, kept.spaceOwner, kept.title.endsWith('(이전 판·연습 기록)')], ['private', srv.users.admin.name, true]);
    assert.ok(!(await E('/api/library')).docs.some((d) => d.id === used.id), '옮긴 옛 판은 다른 사람에게 안 보임');
  } finally { await srv.stop(); }
});
