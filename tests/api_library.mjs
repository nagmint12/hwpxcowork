// 문서함(docs/LIBRARY_SPEC.md) API 시험: 공용·개인 문서함, 폴더, 폴더·문서 접근 권한, 문서 옮기기 — 임시 서버(빈 포트, AI 끔).
//  1) 옛 동작 그대로: 자리 없이 올리면 공용 문서함 맨 위, 모두 보기·편집자 편집·viewer 읽기 전용·삭제는 관리자
//  2) 공용 폴더 권한: 직접 지정한 폴더는 적힌 사람만 — 목록·문서 열기·WebSocket·MCP 모두 404/NO_DOC, 올리기 403, 하위 폴더는 물려받음
//  3) 개인 문서함: 주인·관리자만, 폴더 공유(보기·편집), 문서만 따로 공유, '모든 사용자' 거절
//  4) 옮기기·폴더 이름·지우기(비어 있어야)·공용 맨 위 권한(관리자만)·viewer 는 개인 문서함으로 올림
import { startServer, uploadDoc, watchWs, fixture } from './helpers/server.mjs';
import fs from 'node:fs';

let passed = 0;
const ok = (cond, msg) => { if (!cond) throw new Error('FAIL: ' + msg); passed++; console.log('  ✓', msg); };
const section = (s) => console.log(`\n── ${s}`);

const USERS = [
  { name: '관리자', role: 'admin' },
  { name: '홍길동', role: 'editor' },
  { name: '김검토', role: 'editor' },
  { name: '박보기', role: 'viewer' },
  { name: '최편집', role: 'editor' },
];

async function mcp(base, token, name, args = {}) {
  const h = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` };
  const r = await fetch(`${base}/mcp?agent=Claude`, { method: 'POST', headers: h, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  const raw = await r.text();
  let msg = null;
  try { const line = raw.split(/\r?\n/).find((l) => l.startsWith('data:')); msg = JSON.parse(line ? line.slice(5) : raw); } catch { /* 글 */ }
  const text = msg?.result?.content?.[0]?.text ?? msg?.error?.message ?? raw;
  let json = null; try { json = JSON.parse(text); } catch { /* 글 */ }
  return { isError: !msg || !!msg.error || !!msg.result?.isError, text, json };
}

/** WebSocket 이 열리는가(볼 수 없는 문서면 서버가 끊는다) */
async function wsOpens(base, token, docId) {
  const w = watchWs(base, token, docId);
  try { await w.ready; return true; } catch { return false; } finally { try { w.close(); } catch { /* ignore */ } }
}

const srv = await startServer({ ai: 'off', users: USERS });
try {
  const tok = (name) => srv.userList.find((u) => u.name === name).token;
  const ADM = srv.api(tok('관리자')); const A = srv.api(tok('홍길동')); const B = srv.api(tok('김검토'));
  const V = srv.api(tok('박보기')); const C = srv.api(tok('최편집'));
  const bytes = fs.readFileSync(fixture('hangul_tracked.hwpx'));
  const up = (name, fileName, headers = {}) => srv.api(tok(name)).res('/api/docs', { method: 'POST', body: bytes, headers: { 'x-file-name': encodeURIComponent(fileName), ...headers } });
  const ids = async (X) => (await X('/api/docs')).map((d) => d.id);

  section('1. 자리 없이 올리기 = 공용 문서함 맨 위(옛 동작)');
  const d0 = await uploadDoc(srv.base, tok('홍길동'), bytes, '공용문서.hwpx');
  ok(d0.space === 'public' && d0.folderId === null && d0.spaceOwner === null, `공용 맨 위: ${JSON.stringify({ space: d0.space, folderId: d0.folderId })}`);
  ok(d0.perms.join() === 'read,edit,manage' && d0.canConfigure, `올린 사람 권한 ${d0.perms}`);
  const [lB, lV] = [(await B('/api/docs')).find((d) => d.id === d0.id), (await V('/api/docs')).find((d) => d.id === d0.id)];
  ok(lB && lB.canEdit && !lB.canConfigure && lB.perms.join() === 'read,edit', `편집자 김검토 ${lB?.perms}`);
  ok(lV && !lV.canEdit && lV.perms.join() === 'read', `viewer 박보기 ${lV?.perms}`);
  ok((await B.res(`/api/docs/${d0.id}`, { method: 'DELETE' })).status === 403, '편집자는 지우지 못함(공용 맨 위 기본 권한에 삭제 없음)');
  const libA = await A('/api/library');
  ok(libA.publicRoot.perms.join() === 'read,write,edit' && !libA.publicRoot.acl, `홍길동 공용 맨 위 ${libA.publicRoot.perms} (acl 안 보임)`);
  const libAdm = await ADM('/api/library');
  ok(libAdm.publicRoot.perms.includes('manage') && libAdm.publicRoot.acl?.[0]?.name === '*', '관리자는 공용 맨 위 관리 + acl');

  section('2. 공용 폴더 — 직접 지정한 접근 목록');
  const fHR = await ADM('/api/folders', { method: 'POST', body: { name: '인사', space: 'public' } });
  ok(fHR.id && fHR.space === 'public' && fHR.inherit === true, `폴더 만듦 ${fHR.id}`);
  ok((await A.res('/api/folders', { method: 'POST', body: { name: '인사', space: 'public' } })).status === 409, '같은 자리 같은 이름 → 409');
  await ADM(`/api/folders/${fHR.id}/access`, { method: 'PUT', body: { acl: [{ name: '김검토', perms: ['read'] }, { name: '최편집', perms: ['write', 'edit', 'delete'] }] } });
  const lib2 = await ADM('/api/library');
  const hr = lib2.folders.find((f) => f.id === fHR.id);
  ok(hr.inherit === false && hr.acl.length === 2 && hr.acl[1].perms.join() === 'read,write,edit,delete', `acl 정리(작성·편집·삭제 → 보기 포함): ${JSON.stringify(hr.acl)}`);
  ok(!(await A('/api/library')).folders.some((f) => f.id === fHR.id), '목록에 없는 홍길동은 폴더도 안 보임');
  ok((await up('홍길동', 'x.hwpx', { 'x-folder-id': fHR.id })).status === 403, '홍길동 → 인사에 올리기 403');
  const rC = await up('최편집', '인사기록.hwpx', { 'x-folder-id': fHR.id });
  ok(rC.status === 200 && rC.data.folderId === fHR.id, '최편집(작성) → 인사에 올림');
  const dHR = rC.data;
  ok(!(await ids(A)).includes(dHR.id), '홍길동 문서 목록에 없음');
  const getA = await A.res(`/api/docs/${dHR.id}`);
  ok(getA.status === 404 && getA.data.error === 'NO_DOC', `홍길동 문서 열기 → 404 NO_DOC`);
  ok((await A.res(`/api/docs/${dHR.id}/paragraphs`)).status === 404, '홍길동 문단 읽기도 404(모든 /api/docs/:id 아래)');
  ok((await A.res(`/api/docs/${dHR.id}/memos`, { method: 'POST', body: { ref: 's0/p0', text: 'x' } })).status === 404, '홍길동 메모 남기기도 404');
  ok(!(await wsOpens(srv.base, tok('홍길동'), dHR.id)) && await wsOpens(srv.base, tok('김검토'), dHR.id), 'WebSocket: 홍길동 끊김 · 김검토 열림');
  const m1 = await mcp(srv.base, tok('홍길동'), 'read_document', { doc_id: dHR.id });
  ok(m1.isError && /NO_DOC/.test(m1.text), `MCP read_document → ${m1.text.slice(0, 40)}`);
  const m2 = await mcp(srv.base, tok('홍길동'), 'list_documents', {});
  ok(!m2.isError && Array.isArray(m2.json) && !m2.json.some((d) => d.id === dHR.id), 'MCP list_documents 에도 없음');
  const bHR = (await B('/api/docs')).find((d) => d.id === dHR.id);
  ok(bHR && !bHR.canEdit && bHR.perms.join() === 'read', `김검토(보기) ${bHR?.perms}`);
  ok((await B.res(`/api/docs/${dHR.id}/memos`, { method: 'POST', body: { ref: 's0/p0', text: '보기 권한도 메모는 남김' } })).status === 200, '김검토 메모는 됨(읽기 전용 = 메모·AI 요청)');
  const sub = await C('/api/folders', { method: 'POST', body: { name: '2026', parentId: fHR.id } });
  ok(sub.parentId === fHR.id && sub.perms.includes('manage'), '최편집(작성) → 하위 폴더 만듦, 만든 사람은 관리');
  ok((await B('/api/library')).folders.find((f) => f.id === sub.id)?.perms.join() === 'read', '하위 폴더는 인사 권한을 물려받음(김검토 보기)');
  ok((await B.res(`/api/folders/${sub.id}`, { method: 'PATCH', body: { name: '바꿈' } })).status === 403, '김검토 이름 바꾸기 403');
  ok((await C(`/api/folders/${sub.id}`, { method: 'PATCH', body: { name: '2026년' } })).name === '2026년', '만든 사람 이름 바꿈');
  ok((await ADM.res(`/api/folders/${fHR.id}`, { method: 'DELETE' })).status === 409, '비지 않은 폴더 지우기 409');

  section('3. 개인 문서함');
  const p1 = await up('홍길동', '내 메모.hwpx', { 'x-space': 'private' });
  ok(p1.status === 200 && p1.data.space === 'private' && p1.data.spaceOwner === '홍길동', '홍길동 개인 문서함에 올림');
  const P1 = p1.data.id;
  ok(!(await ids(B)).includes(P1) && (await ids(ADM)).includes(P1), '김검토 안 보임 · 관리자 보임');
  ok((await B.res(`/api/docs/${P1}`)).status === 404, '김검토 열기 404');
  ok((await up('김검토', 'y.hwpx', { 'x-space': 'private', 'x-space-owner': encodeURIComponent('홍길동') })).status === 403, '남의 개인 문서함 맨 위에 올리기 403');
  const pf = await A('/api/folders', { method: 'POST', body: { name: '초안', space: 'private' } });
  ok(pf.space === 'private' && pf.owner === '홍길동', '개인 폴더 만듦');
  const p2 = (await up('홍길동', '초안1.hwpx', { 'x-folder-id': pf.id })).data;
  ok(p2.folderId === pf.id && p2.space === 'private', '개인 폴더에 올림');
  ok((await A.res(`/api/folders/${pf.id}/access`, { method: 'PUT', body: { acl: [{ name: '*', perms: ['read'] }] } })).status === 400, "개인 폴더에 '모든 사용자' → 400");
  await A(`/api/folders/${pf.id}/access`, { method: 'PUT', body: { acl: [{ name: '김검토', perms: ['read'] }, { name: '최편집', perms: ['read', 'edit'] }, { name: '홍길동', perms: ['read'] }] } });
  const pfView = (await A('/api/library')).folders.find((f) => f.id === pf.id);
  ok(pfView.acl.length === 2 && !pfView.acl.some((e) => e.name === '홍길동'), '주인 이름은 목록에서 빠짐(주인은 언제나 전부)');
  const bP2 = (await B('/api/docs')).find((d) => d.id === p2.id); const cP2 = (await C('/api/docs')).find((d) => d.id === p2.id);
  ok(bP2 && !bP2.canEdit && cP2 && cP2.canEdit, '폴더 공유: 김검토 보기 · 최편집 편집');
  ok((await B('/api/library')).folders.some((f) => f.id === pf.id && f.owner === '홍길동'), '김검토 문서함 목록에 공유받은 폴더');
  ok(!(await ids(V)).includes(p2.id), '공유 안 받은 박보기 안 보임');
  ok(!(await ids(B)).includes(P1), '개인 맨 위 문서는 폴더 공유와 무관');
  ok((await B.res(`/api/docs/${P1}/access`, { method: 'PUT', body: { acl: [{ name: '김검토', perms: ['read'] }] } })).status === 404, '남이 문서 권한 바꾸기 → 404(보이지도 않음)');
  await A(`/api/docs/${P1}/access`, { method: 'PUT', body: { acl: [{ name: '김검토', perms: ['read'] }] } });
  ok((await ids(B)).includes(P1) && !(await ids(C)).includes(P1), '문서만 따로 공유: 김검토 보임 · 최편집 안 보임');
  const bP1 = (await B('/api/docs')).find((d) => d.id === P1);
  ok(bP1.access.custom === true && !bP1.access.acl, '관리 권한 없으면 acl 은 숨김');
  ok((await B.res(`/api/docs/${P1}/access`, { method: 'PUT', body: { inherit: true } })).status === 403, '보기 권한으로 권한 바꾸기 403');
  await A(`/api/docs/${P1}/access`, { method: 'PUT', body: { inherit: true } });
  ok(!(await ids(B)).includes(P1), '폴더 권한 따름으로 되돌리면 다시 안 보임');

  section('4. 옮기기 · 공용 맨 위 권한 · viewer');
  ok((await A.res(`/api/docs/${P1}/location`, { method: 'PATCH', body: { folderId: fHR.id } })).status === 403, '작성 권한 없는 폴더로 옮기기 403');
  ok((await B.res(`/api/docs/${d0.id}/location`, { method: 'PATCH', body: { space: 'private' } })).status === 403, '관리 권한 없는 문서 옮기기 403');
  const mv = await A(`/api/docs/${P1}/location`, { method: 'PATCH', body: { space: 'public' } });
  ok(mv.space === 'public' && mv.spaceOwner === null && (await ids(B)).includes(P1), '개인 → 공용 맨 위로 옮김, 김검토 보임');
  const mv2 = await A(`/api/docs/${P1}/location`, { method: 'PATCH', body: { folderId: pf.id } });
  ok(mv2.folderId === pf.id && mv2.space === 'private', '다시 개인 폴더로');
  ok((await A.res('/api/library/public/access', { method: 'PUT', body: { acl: [] } })).status === 403, '공용 맨 위 권한은 관리자만');
  await ADM('/api/library/public/access', { method: 'PUT', body: { acl: [{ name: '*', perms: ['read'] }, { name: '홍길동', perms: ['write', 'edit'] }] } });
  ok((await up('김검토', 'z.hwpx', { 'x-space': 'public' })).status === 403, '맨 위 권한을 줄이면 김검토 공용 올리기 403');
  const zB = (await up('김검토', 'z.hwpx')).data;
  ok(zB.space === 'private' && zB.spaceOwner === '김검토', '자리 없이 올리면 작성 권한이 없을 때 내 개인 문서함으로');
  const d0B = (await B('/api/docs')).find((d) => d.id === d0.id);
  ok(d0B && !d0B.canEdit, '맨 위 편집 권한이 빠진 김검토는 공용 문서 읽기 전용');
  const vDoc = (await up('박보기', 'v.hwpx')).data;
  ok(vDoc.space === 'private' && vDoc.canEdit, 'viewer 는 공용에 못 올리고 개인 문서함으로 — 자기 문서는 편집');
  await C(`/api/docs/${dHR.id}`, { method: 'DELETE' });
  ok(!(await ids(ADM)).includes(dHR.id), '최편집(삭제 권한) 인사 문서 지움');
  await C(`/api/folders/${sub.id}`, { method: 'DELETE' });
  ok((await ADM.res(`/api/folders/${fHR.id}`, { method: 'DELETE' })).status === 200, '빈 폴더 지움');
  console.log(`\n문서함 시험 ${passed}개 통과`);
} finally {
  await srv.stop();
}
