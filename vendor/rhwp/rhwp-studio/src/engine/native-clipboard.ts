// [hwpx-cowork] Same-PC bridge for Windows registered Hwp Native memory.
// Browsers cannot create this Windows format through ClipboardItem.
import { showToast } from '@/ui/toast';
import { clipboardBytes } from './portable-clipboard';

let latest = '';
let capability: Promise<boolean> | undefined;

export function queueNativeClipboard(self: any, token: string, copiedFragment?: Uint8Array): void {
  if (!['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) return;
  let auth: string | null;
  try { auth = localStorage.getItem('hwpx.token'); } catch { return; }
  if (!auth || typeof self.wasm.exportClipboardHwpx !== 'function') return;
  latest = token;
  const headers = { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' };
  capability ??= fetch('/api/clipboard/status', { headers, cache: 'no-store' })
    .then(r => r.ok ? r.json() : { available: false }).then((s: { available?: boolean }) => s.available === true).catch(() => false);
  // Synchronous snapshot: Ctrl+X deletes the source immediately after copy.
  let fragment: Uint8Array;
  try { fragment = copiedFragment ?? self.wasm.exportClipboardHwpx(); } catch { return; }
  setTimeout(() => { void (async () => {
    if (!await capability || token !== latest) return;
    const status = document.getElementById('sb-message');
    if (status) status.textContent = '한글에 붙여넣을 원본 서식을 준비하고 있습니다…';
    try {
      // [hwpx-cowork] 한/글 변환에는 스타일 정의를 붙여넣기 비교 기준으로 바꾼 조각을 보낸다 —
      // 그대로 보내면 한/글이 같은 이름 스타일의 글꼴·크기로 바꾼다. 내부 클립보드는 오려 두기 뒤에도 남는다.
      try { if (typeof self.wasm.exportClipboardHwpxHancom === 'function') fragment = self.wasm.exportClipboardHwpxHancom(); } catch { /* 웹 조각 그대로 */ }
      let binary = '';
      for (let i = 0; i < fragment.length; i += 32768) {
        binary += String.fromCharCode(...fragment.subarray(i, i + 32768));
      }
      const response = await fetch('/api/clipboard/native', {
        method: 'POST', headers, body: JSON.stringify({ token, hwpx: btoa(binary) }),
      });
      const result = await response.json();
      if (token !== latest) return;
      if (result.reason === 'CLIPBOARD_CHANGED') {
        if (status) status.textContent = '다른 내용이 복사되어 원본 서식 준비를 취소했습니다';
        return;
      }
      if (!response.ok || !result.ok) throw new Error('native copy failed');
      if (status) status.textContent = '한글 원본 서식 복사 완료 — 붙여넣을 수 있습니다';
    } catch {
      if (token !== latest) return;
      showToast({ message: '한글 원본 서식을 준비하지 못했습니다. 일반 서식 복사는 유지됩니다.', durationMs: 5000 });
      if (status) status.textContent = '일반 서식으로 복사했습니다';
    }
  })(); }, 0);
}

// A paste event authorizes reading this clipboard only. Check its text against
// the OS snapshot to avoid importing a newer, unrelated clipboard selection.
export async function readHancomNativeClipboard(text: string, model?: string | null): Promise<Uint8Array | null> {
  if (!['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) return null;
  let auth: string | null;
  try { auth = localStorage.getItem('hwpx.token'); } catch { return null; }
  if (!auth) return null;
  const normalized = text.replace(/\r\n?/g, '\n').trim();
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
  const textHash = [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join('');
  const modelDigest = model ? await crypto.subtle.digest('SHA-256', new TextEncoder().encode(model)) : null;
  const modelHash = modelDigest ? [...new Uint8Array(modelDigest)].map(n => n.toString(16).padStart(2, '0')).join('') : undefined;
  const response = await fetch('/api/clipboard/read-native', {
    method: 'POST', headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ textHash, modelHash }),
  });
  if (!response.ok) return null;
  const result = await response.json();
  return result.ok && typeof result.native === 'string' ? clipboardBytes(result.native) : null;
}
