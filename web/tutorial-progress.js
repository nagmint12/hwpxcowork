// 페이지 안의 캐시는 화면 연결용이다. 새 접속에서는 항상 서버에서 읽으며 브라우저 저장소는 쓰지 않는다.
export function createTutorialProgress({ request, token = () => '', onError = () => {} }) {
  const values = new Map(); const writes = new Map(); const sent = new Map();
  let current = null;
  const snapshot = v => ({ docId: v.docId, i: v.i || 0, ctx: v.ctx || {} });
  function save(value) {
    if (!value) { current = null; return; }
    current = value; values.set(value.docId, value);
    const copy = JSON.stringify(snapshot(value));
    if (sent.get(value.docId) === copy) return;
    sent.set(value.docId, copy);
    const auth = token();
    const pending = (writes.get(value.docId) || Promise.resolve()).then(() => request(`/api/tutorial/${value.docId}/progress`, {
      method: 'PUT', body: JSON.parse(copy), headers: { Authorization: `Bearer ${auth}` }, keepalive: true,
    })).catch(e => {
      if (![404, 409].includes(e.status)) { sent.delete(value.docId); onError(e); }
    });
    writes.set(value.docId, pending);
  }
  async function load(docId) {
    await writes.get(docId);
    const value = await request(`/api/tutorial/${docId}/progress`);
    values.set(docId, value); current = value;
    sent.set(docId, JSON.stringify(snapshot(value)));
    return value;
  }
  function clear(docId) {
    if (current?.docId === docId) current = null;
    values.delete(docId); sent.delete(docId);
  }
  return { state: (docId = null) => docId ? values.get(docId) || null : current, save, load, clear, flush: docId => writes.get(docId) || Promise.resolve() };
}
