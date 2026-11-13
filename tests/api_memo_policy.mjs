// 자동 작업 기록 메모 정책: 임시 서버·문서만 쓰고 실제 config/data 와 유료 AI 는 쓰지 않는다.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startServer, uploadDoc, fixture } from './helpers/server.mjs';
import { HwpxDoc } from '../engine/doc.js';

const srv = await startServer({ ai: 'mock' });
let passed = 0;
const ok = (condition, message) => { assert.ok(condition, message); passed++; console.log(`  ✓ ${message}`); };
const A = srv.api('a');
let rpcId = 0;
async function mcp(name, args) {
  const res = await fetch(`${srv.base}/mcp?agent=ChatGPT`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${srv.tokens.a}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'X-Hwpx-Agent-Session': 'memo_policy_chatgpt' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }),
  });
  const raw = await res.text();
  assert.equal(res.status, 200, raw);
  const dataLine = raw.split(/\r?\n/).find((line) => line.startsWith('data:'));
  const msg = JSON.parse(dataLine ? dataLine.slice(5) : raw);
  assert.ok(!msg.error && !msg.result?.isError, raw);
  const text = msg.result?.content?.find((c) => c.type === 'text')?.text;
  return JSON.parse(text);
}

try {
  const doc = await (await HwpxDoc.load(fs.readFileSync(fixture('tool_memo_tracked.hwpx')))).flattened();
  const created = await uploadDoc(srv.base, srv.tokens.a, Buffer.from(await doc.save()), '메모정책.hwpx');
  const id = created.id; const D = `/api/docs/${id}`;
  const initial = await A(`${D}/memos`);
  const version = (await A(D)).version;
  const request = async (over = {}) => (await A(`${D}/requests`, {
    method: 'POST', body: { kind: 'instruct', instruction: '표현을 검토해 주세요', target: { ref: 's0/p1' }, route: 'queue', ...over },
  })).request;
  const start = (rid) => mcp('start_request', { doc_id: id, request_id: rid });
  // 결과 없이 끝나는 단계는 변경 불필요 사유가 있어야 완료(11-05 빈 결과 차단) — 결과가 있으면 사유는 쓰이지 않는다
const complete = (rid) => mcp('complete_request', { doc_id: id, request_id: rid, summary: '표현 검토를 완료했습니다.', no_changes_reason: '메모 정책 시험 — 문서 결과 없이 완료' });
  const reqView = (rid) => A(`${D}/requests/${rid}`);

  const pending = await request();
  ok(pending.memoId == null && (await A(`${D}/memos`)).length === initial.length, '요약 기본: 대기 요청은 문서 메모를 만들지 않음');
  await start(pending.rid);
  ok((await reqView(pending.rid)).memoId == null && (await A(D)).version === version, '처리 시작만으로 문서 메모·새 기록이 생기지 않음');
  await A(`${D}/requests/${pending.rid}/cancel`, { method: 'POST' });
  ok((await reqView(pending.rid)).status === 'cancelled' && (await A(`${D}/memos`)).length === initial.length, '결과 없는 취소는 AI 작업 탭에만 기록');
  const failure = await A.res(`${D}/requests`, { method: 'POST', body: { kind: 'instruct', instruction: '#모의실패', target: { ref: 's0/p1' }, route: 'server' } });
  const failed = failure.data.request;
  ok(failure.status === 502 && failed.status === 'failed' && failed.memoId == null && (await A(`${D}/memos`)).length === initial.length, '결과 없는 AI 실패도 HWPX에 메모를 쌓지 않음');

  const partial = await request();
  await start(partial.rid);
  const paragraphs = await A(`${D}/paragraphs`);
  const target = paragraphs.find((p) => p.ref === 's0/p1');
  const source = target.final ?? target.text;
  assert.ok(source, '시험 대상 문단 글');
  await mcp('propose_changes', { doc_id: id, request_id: partial.rid, proposals: [{ ref: 's0/p1', find: source, replace: `${source} 확인`, reason: '표현 확인' }] });
  const partialMemo = (await reqView(partial.rid)).memoId;
  ok(!!partialMemo && (await A(`${D}/memos`)).length === initial.length + 1, '첫 부분 결과부터 요청마다 요약 메모 하나만 생성');
  await A(`${D}/memos/${partialMemo}/replies`, { method: 'POST', body: { text: '사람이 남긴 확인 답글' } });
  await complete(partial.rid);
  ok((await reqView(partial.rid)).memoId === partialMemo && (await A(`${D}/memos`)).length === initial.length + 1, '완료해도 같은 요청 메모를 갱신');

  const setNone = await A(`${D}/settings`, { method: 'PATCH', body: { aiMemo: 'none' } });
  ok(setNone.settings.aiMemo === 'none', '작업 기록 메모 안 남기기를 문서별 설정으로 선택');
  await A(`${D}/requests/${partial.rid}`, { method: 'PATCH', body: { summary: '업데이트된 공유 요약' } });
  const retained = (await A(`${D}/memos`)).find((m) => m.id === partialMemo);
  ok(retained?.text.includes('사람이 남긴 확인 답글') && retained.text.includes('업데이트된 공유 요약'), 'none으로 바꿔도 기존 요청 메모·사람 답글을 보존');
  const silent = await request();
  await start(silent.rid);
  const comment = await mcp('add_memo', { doc_id: id, request_id: silent.rid, ref: 's0/p1', text: '수치 근거 확인이 필요합니다.' });
  await complete(silent.rid);
  const after = await A(`${D}/memos`);
  ok((await reqView(silent.rid)).memoId == null && after.length === initial.length + 2, 'none은 신규 자동 작업메모만 생략하고 AI 확인 의견은 남김');
  ok(after.some((m) => m.id === comment.id && m.text.includes('수치 근거 확인')) && initial.every((m) => after.some((x) => x.id === m.id && x.text === m.text)), '기존 사람 메모·새 확인 의견 본문 보존');
  const exported = await HwpxDoc.load(await A(`${D}/file?kind=export`));
  ok(exported.memos().some((m) => m.id === partialMemo && m.text.includes('사람이 남긴 확인 답글'))
    && exported.memos().some((m) => m.text.includes('수치 근거 확인')), '한글 내보내기에도 사람 대화·확인 의견 유지');

  await A(`${D}/settings`, { method: 'PATCH', body: { aiMemo: 'detail' } });
  const detailed = await request();
  ok(!!detailed.memoId && (await A(`${D}/memos`)).some((m) => m.id === detailed.memoId && m.text.includes('이력:')), '상세 기록 선택은 대기 단계부터 기존 방식대로 기록');
  await A(`${D}/memos/${detailed.memoId}`, { method: 'DELETE' });
  await start(detailed.rid); await complete(detailed.rid);
  ok((await reqView(detailed.rid)).memoId == null, '사람이 지운 작업기록 메모는 완료 후에도 다시 만들지 않음');
  console.log(`\n메모 정책 통합 시험 ${passed}개 통과`);
} finally {
  await srv.stop();
}
