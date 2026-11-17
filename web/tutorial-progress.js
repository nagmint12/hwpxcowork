// 페이지 안의 캐시는 화면 연결용이다. 새 접속에서는 항상 서버에서 읽으며 브라우저 저장소는 쓰지 않는다.
export function createTutorialProgress({ request, token = () => '', onError = () => {} }) {
  const values = new Map(); const writes = new Map(); const sent = new Map(); const epochs = new Map(); const failures = new Map();
  let current = null;
  const snapshot = v => ({ docId: v.docId, i: v.i || 0, ctx: v.ctx || {} });
  function save(value, { force = false } = {}) {
    if (!value) { current = null; return; }
    current = value; values.set(value.docId, value);
    const copy = JSON.stringify(snapshot(value));
    if (failures.get(value.docId)?.code === 'TUTORIAL_PROGRESS_CHANGED' || (!force && sent.get(value.docId) === copy)) return;
    sent.set(value.docId, copy);
    const auth = token();
    const epoch = epochs.get(value.docId) || 0;
    const pending = (writes.get(value.docId) || Promise.resolve()).then(async () => {
      if ((epochs.get(value.docId) || 0) !== epoch) return;
      if (failures.get(value.docId)?.code === 'TUTORIAL_PROGRESS_CHANGED') return;
      const cached = values.get(value.docId);
      const result = await request(`/api/tutorial/${value.docId}/progress`, {
        method: 'PUT', body: { ...JSON.parse(copy), ...(Number.isInteger(cached?.revision) ? { revision: cached.revision } : {}) }, headers: { Authorization: `Bearer ${auth}` }, keepalive: true, signal: AbortSignal.timeout(15000),
      });
      failures.delete(value.docId);
      if ((epochs.get(value.docId) || 0) !== epoch) return;
      // 서버 응답의 오래된 ctx로 이미 입력 중인 클라이언트 문맥을 덮지 않습니다.
      for (const key of ['revision', 'checkpointId', 'checkpoints']) if (result?.[key] != null) {
        if (cached) cached[key] = result[key];
        value[key] = result[key];
      }
      return result;
    }).catch(e => {
      if ((epochs.get(value.docId) || 0) !== epoch) return;
      sent.delete(value.docId);
      failures.set(value.docId, e);
      if (e.status !== 404) onError(e);
    });
    writes.set(value.docId, pending);
  }
  async function load(docId) {
    await writes.get(docId);
    const value = await request(`/api/tutorial/${docId}/progress`, { signal: AbortSignal.timeout(15000) });
    values.set(docId, value); current = value;
    sent.set(docId, JSON.stringify(snapshot(value)));
    failures.delete(docId);
    return value;
  }
  function clear(docId) {
    epochs.set(docId, (epochs.get(docId) || 0) + 1);
    if (current?.docId === docId) current = null;
    values.delete(docId); sent.delete(docId); failures.delete(docId);
  }
  function adopt(value) {
    epochs.set(value.docId, (epochs.get(value.docId) || 0) + 1);
    values.set(value.docId, value); current = value;
    sent.set(value.docId, JSON.stringify(snapshot(value)));
    writes.delete(value.docId);
    failures.delete(value.docId);
    return value;
  }
  async function flush(docId, { strict = false } = {}) {
    await writes.get(docId);
    if (strict && failures.has(docId)) throw failures.get(docId);
  }
  return { state: (docId = null) => docId ? values.get(docId) || null : current, failure: docId => failures.get(docId), save, load, clear, adopt, flush };
}
