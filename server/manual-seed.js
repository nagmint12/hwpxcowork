// 이전 설명서 배포·복원 도구. 2026-11-01부터 자동 배포는 중단하고 튜토리얼 메뉴에서 실행한다.
// AI 예시 기록은 새 임시 문서에서도 같은 시나리오를 사용한다(tutorial-examples.js).
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export const SEED_MARK = '.manuals-seeded.json';
export const SEED_AGENT = '예시 AI';

function client(base, token) {
  const call = async (p, { method = 'GET', body, headers = {} } = {}) => {
    const raw = Buffer.isBuffer(body);
    const res = await fetch(new URL(p, base), {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body && !raw ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? (raw ? body : JSON.stringify(body)) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(`${method} ${p} → ${res.status} ${data.message || data.error || ''}`), { status: res.status, code: data.error });
    return data;
  };
  return call;
}

/** 'AI 작업 맡기기' 설명서에 실제 요청·메모 기록을 남긴다 */
export async function aiScenario({ api, base, token, docId, log = () => {}, tool: localTool = null }) {
  const paras = await api(`/api/docs/${docId}/paragraphs`);
  const find = (prefix) => {
    const p = paras.find((x) => x.text?.startsWith(prefix));
    if (!p) throw new Error(`설명서에 '${prefix}' 문단이 없습니다`);
    return p;
  };
  const target = (p) => ({ ref: p.ref, start: 0, end: p.text.length, text: p.text });
  const request = async (p, instruction) => (await api(`/api/docs/${docId}/requests`, { method: 'POST', body: { kind: 'instruct', instruction, route: 'queue', target: target(p) } })).request.rid;

  const mcp = localTool ? null : new Client({ name: 'hwpx-manual-seed', version: '1.0.0' });
  if (mcp) await mcp.connect(new StreamableHTTPClientTransport(new URL(`/mcp?agent=${encodeURIComponent(SEED_AGENT)}`, base), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  const tool = localTool || (async (name, args) => {
    const r = await mcp.callTool({ name, arguments: args });
    if (r.isError) throw new Error(`${name}: ${(r.content || []).map((c) => c.text).join(' ').slice(0, 300)}`);
    const text = (r.content || []).map((c) => c.text || '').join('');
    try { return JSON.parse(text); } catch { return text; }
  });
  try {
    // 요청 1 — 처리 완료, 제안 3건이 남아 사람이 정하길 기다림
    const a = find('예시 문단 A');
    const r1 = await request(a, '의미는 그대로 두고 보고서 문체로 다듬어 줘');
    await tool('start_request', { doc_id: docId, request_id: r1 });
    await tool('propose_changes', {
      doc_id: docId, request_id: r1, proposals: [
        { ref: a.ref, find: '실시하였으며', replace: '실시했으며', reason: '보고서 문체(‘-했다’)로 맞춤' },
        { ref: a.ref, find: '매우 높은 것으로 사료되는 바', replace: '높게 나타났으므로', reason: '근거 없는 추측 표현(사료됨)을 사실 서술로 바꿈' },
        { ref: a.ref, find: '판단됨.', replace: '판단합니다.', reason: '명사형 종결을 문장으로 맞춤' },
      ],
    });
    await tool('complete_request', { doc_id: docId, request_id: r1, summary: '예시 문단 A 의 추측·명사형 표현 세 곳을 보고서 문체로 다듬는 제안' });
    // 요청 2 — 대기열에 걸려 있음(아직 어떤 AI 도 가져가지 않음)
    await request(find('예시 문단 B'), '마지막 줄에 두세 글자만 넘어가니 자간을 조금 줄여 한 줄로 맞춰 줘');
    // 요청 3 — 실패 기록
    const r3 = await request(find('예시 표'), '첨부한 엑셀의 연도별 응답자 수로 아래 표의 빈 칸을 채워 줘');
    await tool('start_request', { doc_id: docId, request_id: r3 });
    await tool('fail_request', { doc_id: docId, request_id: r3, error: '첨부 파일이 없어 표를 채우지 못했습니다(예시 — 실제로 맡길 때는 엑셀을 첨부하세요)' });
    // 요청 4 — 그림 다시 그리기, 대기열
    await request(find('예시 그림'), '아래 막대그래프를 글꼴을 크게, 막대 색을 짙은 파랑으로 다시 그려 줘');
    // 메모와 답글
    const c = find('예시 문단 C');
    const memo = await api(`/api/docs/${docId}/memos`, { method: 'POST', body: { ref: c.ref, find: '87%', text: '수치의 근거(조사 표본 수·조사 시기)를 함께 적어 주세요.' } });
    const memoId = memo?.id ?? memo?.memo?.id ?? memo?.memoId;
    if (memoId != null) await tool('add_memo', { doc_id: docId, reply_to: String(memoId), text: '예: “2025년 10월 조사(n=2,000)에서 응답자의 87%가…” 처럼 표본 수와 시기를 앞에 두면 됩니다.' });
    log('AI 작업 설명서에 요청 4건(완료·대기열·실패·대기열)과 메모·답글을 남겼습니다');
  } finally { await mcp?.close().catch(() => {}); }
}

/**
 * 설명서를 올린다 → { folderId, docs: [{ file, id }] }.
 * base: 서버 주소(http://127.0.0.1:포트), token: 관리자 토큰, dir: docs/manuals(manifest.json 이 있는 폴더)
 */
export async function seedManuals({ base, token, dir, log = () => {} }) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const api = client(base, token);
  // 1) 공용 문서함에 폴더(이미 있으면 그 폴더)
  let folder;
  try { folder = await api('/api/folders', { method: 'POST', body: { name: manifest.folder, space: 'public' } }); }
  catch (error) {
    if (error.code !== 'NAME_TAKEN') throw error;
    folder = (await api('/api/library?includeTutorialTemplates=1')).folders.find((f) => f.name === manifest.folder && f.space === 'public' && !f.parentId);
  }
  const folderId = folder?.id;
  if (!folderId) throw new Error('설명서 폴더를 만들지 못했습니다');
  // 2) 문서 올리기(순서대로)
  const docs = [];
  for (const item of [...manifest.documents].sort((a, b) => a.order - b.order)) {
    const bytes = fs.readFileSync(path.join(dir, item.file));
    const doc = await api('/api/docs', { method: 'POST', body: bytes, headers: { 'Content-Type': 'application/octet-stream', 'x-file-name': encodeURIComponent(item.file), 'x-space': 'public', 'x-folder-id': folderId } });
    docs.push({ file: item.file, id: doc.id, scenario: item.scenario || null });
  }
  log(`사용 설명서 ${docs.length}건을 공용 문서함 '${manifest.folder}' 폴더에 올렸습니다`);
  // 3) 실제 기록
  for (const d of docs) if (d.scenario === 'ai-requests') await aiScenario({ api, base, token, docId: d.id, log });
  return { folderId, docs };
}

/**
 * 이미 넣은 설명서를 새 판으로 바꾼다(scripts/seed-manuals.mjs --replace): 공용 '따라하기 설명서' 폴더의 문서 중
 * 사람이 쓴 흔적(반영한 제안·넣은 사람이 아닌 메모)이 없는 것은 지우고, 있는 것은 지우지 않고 넣는 사람(관리자)의 개인 문서함으로
 * 옮겨 제목 끝에 '(이전 판·연습 기록)'을 단다. 그 뒤 seedManuals 로 새로 넣는다 → { removed, moved, folderId, docs }
 */
export async function replaceManuals({ base, token, dir, log = () => {} }) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const api = client(base, token);
  const me = await api('/api/me');
  const lib = await api('/api/library?includeTutorialTemplates=1');
  const folder = lib.folders.find((f) => f.name === manifest.folder && f.space === 'public' && !f.parentId);
  const removed = []; const moved = [];
  for (const d of folder ? lib.docs.filter((x) => x.folderId === folder.id) : []) {
    const memos = await api(`/api/docs/${d.id}/memos`);
    const other = (who) => !String(who ?? '').startsWith(me.name);   // 넣은 사람·그 사람의 '예시 AI' 가 아닌 사람
    const used = (d.proposals?.applied || 0) > 0 || memos.some((m) => other(m.author) || (m.thread?.replies || []).some((r) => other(r.by)));
    if (used) {
      await api(`/api/docs/${d.id}/location`, { method: 'PATCH', body: { space: 'private', owner: me.name } });
      await api(`/api/docs/${d.id}`, { method: 'PATCH', body: { title: `${d.title} (이전 판·연습 기록)` } });
      moved.push(d.title); log(`옮김(쓴 흔적이 있어 ${me.name} 개인 문서함으로): ${d.title}`);
    } else {
      await api(`/api/docs/${d.id}`, { method: 'DELETE' });
      removed.push(d.title); log(`지움: ${d.title}`);
    }
  }
  const out = await seedManuals({ base, token, dir, log });
  return { removed, moved, ...out };
}

/** 옛 서버 설정과의 호환: manuals.seed가 남아 있어도 사전 배포하지 않는다. */
export async function seedManualsOnce() {
  // 설명서는 이제 /api/tutorial의 공통 원본이다. 공용/개인 문서함에 미리 복사하지 않는다.
  // 명시적인 옛 자료 복원(seedManuals/replaceManuals) 도구는 그대로 남긴다.
  return null;
}
