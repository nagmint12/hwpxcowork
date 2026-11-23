import { pasteWithParagraphFormat } from './native-paste.mjs';

export const NATIVE_CLIPBOARD_PATCHES = [
  {
    id: 'native-paste-empty-paragraph-source-format', file: 'src/core/wasm-bridge.ts',
    why: '빈 문단에서는 첫 복사 문단의 스타일과 직접 지정한 줄 간격·문단 모양을 가져온다',
    anchor: '    return (this.doc as any).pasteDocumentFragment(sec, para, path, offset, bytes);',
    replace: () => `    const paste = ${pasteWithParagraphFormat.toString().replace('function pasteWithParagraphFormat(doc, Document, sec, para, path, offset, bytes)', 'function (doc: any, Document: any, sec: number, para: number, path: string, offset: number, bytes: Uint8Array)').replace('cells.map(c =>', 'cells.map((c: any) =>')};\n    return paste(this.doc, HwpDocument, sec, para, path, offset, bytes);`,
  },
  {
    id: 'native-import-uploaded-fragment-conversion', file: 'src/engine/native-clipboard.ts',
    why: '2018·2022의 복사 원본 바이트를 한글 자체로 HWPX 변환하여 메모·개체·스타일을 가져온다',
    anchor: "let latest = '';",
    replace: a => `export function isHancomNativeFragment(bytes: Uint8Array): boolean {
  return [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].every((value, i) => bytes[i] === value);
}

export async function prepareHancomNativeFragment(bytes: Uint8Array): Promise<Uint8Array> {
  if (!isHancomNativeFragment(bytes)) return bytes;
  const auth = localStorage.getItem('hwpx.token');
  if (!auth) throw new Error('AUTH_REQUIRED');
  let binary = '';
  for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  const body = JSON.stringify({ native: btoa(binary) });
  for (let attempt = 0; attempt < 20; attempt++) {
    const response = await fetch('/api/clipboard/import', { method: 'POST', headers: { Authorization: 'Bearer ' + auth, 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(50000) });
    if (response.status === 429) { await new Promise(resolve => setTimeout(resolve, 500)); continue; }
    const result = await response.json();
    if (!response.ok || !result.ok || typeof result.hwpx !== 'string') throw new Error(result.reason || 'NATIVE_IMPORT_FAILED');
    const converted = clipboardBytes(result.hwpx);
    if (converted[0] !== 0x50 || converted[1] !== 0x4b) throw new Error('INVALID_HWPX');
    Object.defineProperty(converted, 'clipboardWarnings', { value: Array.isArray(result.warnings) ? result.warnings : [] });
    return converted;
  }
  throw new Error('IMPORT_BUSY');
}

${a}`,
  },
  {
    id: 'native-import-keyboard-integration', file: 'src/engine/input-handler-keyboard.ts',
    why: '한글 원본 형식을 문서 조각 붙여넣기 경로에 연결한다',
    anchor: "import { queueNativeClipboard, readHancomNativeClipboard } from './native-clipboard';",
    replace: () => "import { queueNativeClipboard, readHancomNativeClipboard, prepareHancomNativeFragment, isHancomNativeFragment } from './native-clipboard';",
  },
  {
    id: 'native-import-portable-clipboard-atomic-paste', file: 'src/engine/input-handler-keyboard.ts',
    why: '원본 변환이 끝날 때까지 선택 영역을 유지하고 문서·커서가 바뀐 뒤에는 지연 붙여넣기를 취소한다',
    anchor: "  if (portable) {\n    pasteDocumentFragment.call(this, portable, hasSelection);\n    return;\n  }",
    replace: () => `  if (portable) {
    if (!isHancomNativeFragment(portable)) {
      pasteDocumentFragment.call(this, portable, hasSelection);
      return;
    }
    const guard = guardPasteTarget.call(this);
    const status = document.getElementById('sb-message');
    if (status) status.textContent = '한글 원본 구조를 가져오고 있습니다…';
    void (async () => {
      try {
        const prepared = await prepareHancomNativeFragment(portable!);
        if (!guard.current()) return;
        const warnings = (prepared as Uint8Array & { clipboardWarnings?: unknown[] }).clipboardWarnings;
        if (chooseCellPaste.call(this, 'document', prepared, hasSelection)) {
          if (status) status.textContent = '셀 붙이기 방식을 선택해 주세요';
        } else if (pasteDocumentFragment.call(this, prepared, hasSelection, true, false) && status) {
          status.textContent = warnings?.length ? '한글 원본 구조를 붙였습니다. 원본 없는 그림 ' + warnings.length + '개를 표시했습니다' : '한글 원본 구조를 붙여넣었습니다';
        }
      } catch (error) {
        showToast({ message: error instanceof Error && error.message === 'FRAGMENT_TOO_LARGE' ? '복사한 내용이 처리 용량을 넘습니다. 범위를 나누어 복사해 주세요.' : '한글 원본을 가져오지 못했습니다. 잠시 후 다시 붙여넣어 주세요.', durationMs: 6000 });
        if (status) status.textContent = '한글 원본 변환을 완료하지 못했습니다';
      } finally { guard.stop(); }
    })();
    return;
  }`,
  },
  {
    id: 'native-import-local-paste-conversion', file: 'src/engine/input-handler-keyboard.ts',
    why: '로컬의 기존 native 읽기 경로도 같은 원본 HWPX 변환을 사용한다',
    anchor: "      try { native = await readHancomNativeClipboard(text, model); } catch { /* use embedded HWP model */ }",
    replace: () => "      try { native = await readHancomNativeClipboard(text, model); if (native) native = await prepareHancomNativeFragment(native); } catch { native = null; /* use embedded HWP model */ }",
  },
  {
    id: 'native-copy-missing-picture-notice', file: 'src/engine/native-clipboard.ts',
    why: '한글 붙여넣기 준비 상태와 모든 서식의 일치 검증을 구분하고 원본 없는 그림을 알린다',
    anchor: "      if (status) status.textContent = '한글 원본 서식 복사 완료 — 붙여넣을 수 있습니다';",
    replace: () => "      if (status) status.textContent = result.warnings?.length ? '한글에 붙여넣을 준비가 됐습니다 — 원본 없는 그림 ' + result.warnings.length + '개를 표시했습니다' : '한글에 붙여넣을 준비가 됐습니다';",
  },
  {
    id: 'native-copy-public-origin-physical-proof', file: 'src/engine/native-clipboard.ts',
    why: '공용 HTTPS 접속도 실제 호스트 클립보드에 복사 표식이 있는 경우에만 원본 한글 형식으로 변환한다',
    anchor: "export function queueNativeClipboard(self: any, token: string, copiedFragment?: Uint8Array): void {\n  if (!['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) return;",
    replace: () => "export function queueNativeClipboard(self: any, token: string, copiedFragment?: Uint8Array): void {\n  const directLocal = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);\n  if (!directLocal && !globalThis.isSecureContext) return;",
  },
  {
    id: 'native-copy-probe-public-origin-on-write', file: 'src/engine/native-clipboard.ts',
    why: '원격 브라우저에는 클립보드 읽기를 열지 않고 쓰기마다 물리 복사 표식을 검증한다',
    anchor: "  capability ??= fetch('/api/clipboard/status', { headers, cache: 'no-store' })\n    .then(r => r.ok ? r.json() : { available: false }).then((s: { available?: boolean }) => s.available === true).catch(() => false);",
    replace: a => a.replace("capability ??= fetch", "capability ??= directLocal ? fetch").replace(".catch(() => false);", ".catch(() => false) : Promise.resolve(true);"),
  },
  {
    id: 'native-copy-remote-fallback-without-warning', file: 'src/engine/native-clipboard.ts',
    why: '서버와 다른 PC에서 복사한 경우 기존 문서모델·HTML 복사를 그대로 유지한다',
    anchor: "      if (result.reason === 'CLIPBOARD_CHANGED') {",
    replace: a => "      if (!directLocal && result.reason === 'SAME_PC_REQUIRED') {\n        if (status) status.textContent = '문서 서식으로 복사했습니다';\n        return;\n      }\n" + a,
  },
  {
    id: 'native-copy-wait-for-physical-publication', file: 'src/engine/native-clipboard.ts',
    why: '큰 복사의 브라우저 게시가 끝나기 전에 물리 표식을 검사한 경우 짧게 재확인한다',
    anchor: "      const response = await fetch('/api/clipboard/native', {\n        method: 'POST', headers, body: JSON.stringify({ token, hwpx: btoa(binary) }),\n      });\n      const result = await response.json();",
    replace: () => `      let response!: Response;
      let result: any;
      const nativeBody = JSON.stringify({ token, hwpx: btoa(binary) });
      for (let publicationAttempt = 0; ; publicationAttempt++) {
        response = await fetch('/api/clipboard/native', { method: 'POST', headers, body: nativeBody });
        result = await response.json();
        if (directLocal || result.reason !== 'SAME_PC_REQUIRED' || publicationAttempt >= 4 || token !== latest) break;
        await new Promise(resolve => setTimeout(resolve, 250));
      }`,
  },
];
