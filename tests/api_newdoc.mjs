// 새 문서로 시작·문서 이름 바꾸기 API 시험 — 임시 서버(빈 포트, AI 끔).
//  1) POST /api/library/docs: 빈 한/글 문서(server/templates/blank.hwpx)를 그 자리에 — 기본 이름 '새 문서', 같은 자리 같은 이름은 '(2)'
//  2) 만든 문서는 여느 문서처럼 열고(문단·파일·한글로 저장) 고칠 수 있다, 폴더·개인 문서함 자리, 권한 없는 자리는 403
//  3) PATCH /api/docs/:id { title }: 수정·관리 권한, 빈 이름 거절, 보기 전용 403, WebSocket 'renamed' 알림, fileName 은 그대로
import { startServer, uploadDoc, watchWs, fixture } from './helpers/server.mjs';
import { HwpxDoc } from '../engine/doc.js';
import { elements } from '../engine/page-layout.js';
import fs from 'node:fs';

let passed = 0;
const ok = (cond, msg) => { if (!cond) throw new Error('FAIL: ' + msg); passed++; console.log('  ✓', msg); };
const section = (s) => console.log(`\n── ${s}`);

const USERS = [
  { name: '관리자', role: 'admin' },
  { name: '홍길동', role: 'editor' },
  { name: '김검토', role: 'editor' },
  { name: '박보기', role: 'viewer' },
];

const srv = await startServer({ ai: 'off', users: USERS });
try {
  const tok = (name) => srv.userList.find((u) => u.name === name).token;
  const A = srv.api(tok('홍길동')); const B = srv.api(tok('김검토')); const V = srv.api(tok('박보기'));

  section('1. 새 문서로 시작');
  const n1 = await A('/api/library/docs', { method: 'POST', body: {} });
  ok(n1.title === '새 문서' && n1.fileName === '새 문서.hwpx' && n1.space === 'public', `기본 이름·자리: ${n1.title} · ${n1.fileName} · ${n1.space}`);
  ok(n1.version === 1 && n1.milestone?.note === '새 문서', `v1 이정표 '새 문서': ${JSON.stringify(n1.milestone)}`);
  const n2 = await A('/api/library/docs', { method: 'POST', body: { title: '새 문서' } });
  const n3 = await B('/api/library/docs', { method: 'POST', body: { title: '  새   문서.hwpx ' } });
  ok(n2.title === '새 문서 (2)' && n3.title === '새 문서 (3)', `같은 이름은 겹치지 않게: ${n2.title} · ${n3.title}`);
  const up = await uploadDoc(srv.base, tok('홍길동'), fs.readFileSync(fixture('hangul_tracked.hwpx')), '보고서.hwpx');
  const n4 = await A('/api/library/docs', { method: 'POST', body: { title: '보고서' } });
  ok(n4.title === '보고서 (2)', `올린 문서와도 겹치지 않음: ${n4.title}`);
  const n5 = await A('/api/library/docs', { method: 'POST', body: { title: 'a/b:c' } });
  ok(n5.title === 'a/b:c' && n5.fileName === 'a_b_c.hwpx', `파일 이름에 못 쓰는 글자: ${n5.fileName}`);

  section('2. 만든 문서 열기·고치기·자리');
  const info = await A(`/api/docs/${n1.id}`);
  ok(info.sections === 1 && info.bodyParagraphs === 1 && info.changes === 0 && info.memos === 0, `빈 문서: 구역 ${info.sections} · 문단 ${info.bodyParagraphs}`);
  const paras = await A(`/api/docs/${n1.id}/paragraphs`);
  ok(paras.length === 1 && paras[0].text === '', '문단 하나, 글 없음');
  const file = await A(`/api/docs/${n1.id}/file`);
  ok(Buffer.isBuffer(file) && file.subarray(0, 2).toString() === 'PK', `파일 받기 ${file.length}B`);
  const blank = await HwpxDoc.load(file);
  const normal = blank.header.style({ name: '바탕글' });
  const [first] = elements(blank.sections[0].xml, 'hp:p');
  ok(normal && first.attrs.styleIDRef === normal.styleId && blank.header.charHeight(normal.charPr) === 1000
    && blank.sections[0].bodyParas[0].runs.every(run => run.charPr === normal.charPr), '빈 문단과 첫 입력의 글자 모양이 바탕글 10pt');
  const exp = await A.res(`/api/docs/${n1.id}/file?kind=export`);
  ok(exp.ok && /%EC%83%88%20%EB%AC%B8%EC%84%9C\.hwpx/.test(exp.headers.get('content-disposition') || ''), `한글로 저장 이름 = 제목: ${exp.headers.get('content-disposition')}`);
  const fold = await A('/api/folders', { method: 'POST', body: { name: '작업', space: 'public' } });
  const inF = await A('/api/library/docs', { method: 'POST', body: { title: '새 문서', space: 'public', folderId: fold.id } });
  ok(inF.folderId === fold.id && inF.title === '새 문서', `폴더 안(이름은 폴더마다 따로): ${inF.title}`);
  const mine = await A('/api/library/docs', { method: 'POST', body: { space: 'private', owner: '홍길동' } });
  ok(mine.space === 'private' && mine.spaceOwner === '홍길동', '개인 문서함');
  ok((await B.res('/api/library/docs', { method: 'POST', body: { space: 'private', owner: '홍길동' } })).status === 403, '남의 개인 문서함에는 못 만듦');
  const vDoc = await V('/api/library/docs', { method: 'POST', body: {} });
  ok(vDoc.space === 'private' && vDoc.spaceOwner === '박보기', `viewer 는 자리 없이 만들면 개인 문서함: ${vDoc.space}`);

  section('3. 이름 바꾸기');
  const w = watchWs(srv.base, tok('김검토'), n1.id); await w.ready;
  const r1 = await A(`/api/docs/${n1.id}`, { method: 'PATCH', body: { title: '  2026 계획서  ' } });
  ok(r1.title === '2026 계획서' && r1.fileName === '새 문서.hwpx', `만든 사람: ${r1.title} (파일 이름 그대로 ${r1.fileName})`);
  const msg = await w.waitFor((m) => m.type === 'doc' && m.action === 'renamed', 5000);
  ok(msg.title === '2026 계획서' && msg.by === '홍길동', 'WebSocket renamed 알림');
  w.close();
  ok((await A('/api/docs')).find((d) => d.id === n1.id)?.title === '2026 계획서', '목록에 새 이름');
  const r2 = await B(`/api/docs/${up.id}`, { method: 'PATCH', body: { title: '보고서 최종' } });
  ok(r2.title === '보고서 최종', '편집자(수정 권한)도 바꿈');
  ok((await V.res(`/api/docs/${up.id}`, { method: 'PATCH', body: { title: 'x' } })).status === 403, '보기 전용은 403');
  const bad = await A.res(`/api/docs/${up.id}`, { method: 'PATCH', body: { title: '   ' } });
  ok(bad.status === 400 && bad.data.error === 'BAD_TITLE', `빈 이름 거절 ${bad.status} ${bad.data.error}`);
  ok((await B.res(`/api/docs/${mine.id}`, { method: 'PATCH', body: { title: 'x' } })).status === 404, '볼 수 없는 문서는 404');
  const hist = await A(`/api/docs/${up.id}/history`);
  ok(JSON.stringify(hist).includes('보고서 → 보고서 최종'), '이력에 이름 바꿈 기록');

  console.log(`\n${passed}개 통과`);
} finally {
  await srv.stop();
}
