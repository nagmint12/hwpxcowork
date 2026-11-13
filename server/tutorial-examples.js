// 설명서의 예시 기록을 사용자의 새 연습 문서 안에서만 만든다. AI·MCP·개인 실행기를 호출하지 않는다.
import { Service } from './service.js';
import { aiScenario, SEED_AGENT } from './manual-seed.js';
import { AI_B_INSTRUCTION } from './tutorial-samples.js';

export async function seedTutorialExamples(service, user, docId) {
  // examples:false — 예시 기록(완료·대기·실패 요청)은 이 시나리오가 도구로 직접 만든다. 연습 문서의 예시 답변 경로로 바로 처리되면 안 된다
  const offline = new Service({ store: service.store, hub: service.hub, config: { ...service.cfg, tutorial: { enabled: false, examples: false } }, ai: null });
  const api = async (url, { body } = {}) => {
    if (url.endsWith('/paragraphs')) return offline.paragraphs(docId);
    if (url.endsWith('/requests')) return offline.createRequest(docId, String(body.target?.text || '').startsWith('예시 문단 B') ? { ...body, instruction: AI_B_INSTRUCTION } : body, user);
    if (url.endsWith('/memos')) return offline.addMemo(docId, { ...body, text: '수치의 근거가 되는 응답자 400명·만족 응답 348명·조사 시기가 본문과 맞는지 확인해 주세요.' }, user);
    throw new Error(`지원하지 않는 예시 경로: ${url}`);
  };
  const tool = (name, a) => {
    if (name === 'start_request') return offline.startRequest(docId, a.request_id, user, SEED_AGENT);
    if (name === 'propose_changes') return offline.proposeMany(docId, a.proposals, user, SEED_AGENT, { rid: a.request_id });
    if (name === 'complete_request') return offline.completeRequest(docId, a.request_id, { summary: a.summary }, user, SEED_AGENT);
    if (name === 'fail_request') return offline.failRequest(docId, a.request_id, { error: a.error }, user, SEED_AGENT);
    if (name === 'add_memo') return offline.replyMemo(docId, a.reply_to, '가상 자료의 조사 시기는 2025년 10월이며 348명 ÷ 400명 × 100 = 87%입니다. 실제 문서에서는 원자료를 첨부해 확인하세요.', user, SEED_AGENT);
    throw new Error(`지원하지 않는 예시 도구: ${name}`);
  };
  await aiScenario({ api, tool, docId });
  await service.store.withDoc(docId, () => {
    const meta = service.store.readMeta(docId);
    for (const r of meta.requests) r.example = true;
    service.store.saveMeta(meta);
  });
}
