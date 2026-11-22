// Register at the repository root before mounting the same Vue application used by the desktop app.
const base = new URL('./', import.meta.url);
const rooms = new Map();
window.hwpxPages = {
  room(id) {
    const room = { close() { rooms.get(id)?.delete(room); }, send() {} };
    if (!rooms.has(id)) rooms.set(id, new Set());
    rooms.get(id).add(room);
    queueMicrotask(() => room.onopen?.());
    return room;
  },
};
async function start() {
  if (!navigator.serviceWorker || !window.indexedDB) throw new Error('이 브라우저에서는 개인 문서함을 열 수 없습니다. 사이트 저장소를 허용한 최신 브라우저에서 열어 주세요.');
  navigator.serviceWorker.addEventListener('message', ({ data }) => {
    if (data?.type !== 'hwpx-document-events') return;
    for (const { doc, event } of data.events) for (const room of rooms.get(doc) || []) room.onmessage?.({ data: JSON.stringify(event) });
  });
  const script = new URL('personal-worker.js', base).href;
  const registration = await navigator.serviceWorker.register(script, { scope: base.pathname });
  if (navigator.serviceWorker.controller?.scriptURL !== script) await new Promise((resolve, reject) => {
    const installing = registration.installing;
    const check = () => {
      const active = navigator.serviceWorker.controller?.scriptURL === script;
      if (!active && installing?.state !== 'redundant') return;
      navigator.serviceWorker.removeEventListener('controllerchange', check);
      installing?.removeEventListener('statechange', check);
      if (active) resolve();
      else reject(new Error('편집기 초기화를 완료하지 못했습니다. 새로 열어 주세요.'));
    };
    navigator.serviceWorker.addEventListener('controllerchange', check);
    installing?.addEventListener('statechange', check);
    check();
  });
  // Report storage failures before mounting: a local persistence failure should never look like a login prompt.
  const ready = await fetch(new URL('api/config', base));
  if (!ready.ok) throw new Error((await ready.json()).message);
  await import(document.querySelector('meta[name="hwpx-personal-app"]').content);
}
start().catch(error => {
  const root = document.getElementById('app');
  const p = document.createElement('p'); p.setAttribute('role', 'alert'); p.textContent = error.message;
  const retry = document.createElement('button'); retry.textContent = '다시 열기'; retry.onclick = () => location.reload();
  root.replaceChildren(p, retry);
});
