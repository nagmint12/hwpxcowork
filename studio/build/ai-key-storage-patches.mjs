// [hwpx-cowork] 2026-11-18 공개 웹 페이지(GitHub Pages)에서는 편집기 AI 도우미의 API 키를 브라우저에 저장하지 않는다(사용자 결정 —
// "개인 사용자가 거기 접속해 개인 API 키를 저장하면 위험하다", GitHub Pages 에만 적용).
// *.github.io 는 한 계정의 모든 Pages 사이트가 같은 출처라 저장소(IndexedDB·localStorage)를 함께 쓰고, 누구나 여는 공개 주소다.
// 판정: 주소가 *.github.io 이거나, 배포가 index.html 에 <meta name="hwpx-ai-key-storage" content="off"> 를 넣었을 때(직접 도메인을 붙일 때).
// 그때 키 저장소를 열지 않아(KeyStore backend = null → canPersist false) '기억' 칸이 잠기고 키는 이번 실행 동안 메모리에만 있다.
// 예전에 남은 키 저장소(IndexedDB 'rhwp-ai')는 지운다. 다른 배포(운영 웹은 iframe 이라 AI 도우미를 올리지 않음·데스크톱·모바일)는 바뀌지 않는다.
const KEY_STORE = 'src/ai/settings/key-store.ts';
const CONTEXT = 'src/ai/ai-context.ts';
const DIALOG = 'src/ai/ui/ai-settings-dialog.ts';

export const AI_KEY_STORAGE_PATCHES = [
  {
    id: 'ai-key-storage-blocked-detect',
    file: KEY_STORE,
    why: 'GitHub Pages(공개 주소)에서는 API 키를 저장하지 않는다 — 판정 함수와 남은 키 저장소 지우기',
    anchor: 'export async function openIndexedDbKeyBackend(): Promise<KeyBackend | null> {',
    replace: (a) => `/** [hwpx-cowork] 2026-11-18 공개 페이지(*.github.io 또는 meta hwpx-ai-key-storage=off)면 키를 저장하지 않는다(studio/build/ai-key-storage-patches.mjs) */
export function coworkAiKeyStorageBlocked(): boolean {
  try {
    if (/(^|\\.)github\\.io$/i.test(globalThis.location?.hostname ?? '')) return true;
    return globalThis.document?.querySelector('meta[name="hwpx-ai-key-storage"]')?.getAttribute('content') === 'off';
  } catch {
    return false;
  }
}

/** [hwpx-cowork] 키 저장을 막은 페이지에서 예전에 남은 키 저장소를 지운다 */
export async function coworkForgetStoredAiKeys(): Promise<void> {
  try {
    if (typeof indexedDB === 'undefined') return;
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    });
  } catch { /* 저장소가 막혔으면 남은 키도 없다 */ }
}

${a}`,
  },
  {
    id: 'ai-key-storage-blocked-import',
    file: CONTEXT,
    why: '키 저장 막기 판정을 AI 도우미 공유 상태에서 쓴다',
    anchor: "import { KeyStore, openIndexedDbKeyBackend, type KeyStatus } from './settings/key-store.ts';",
    replace: () => "import { KeyStore, openIndexedDbKeyBackend, coworkAiKeyStorageBlocked, coworkForgetStoredAiKeys, type KeyStatus } from './settings/key-store.ts';",
  },
  {
    id: 'ai-key-storage-blocked-flag',
    file: CONTEXT,
    why: '설정 화면이 "이 페이지는 저장하지 않음"을 알 수 있게 표시를 둔다',
    anchor: '  settingsVolatile = false;\n',
    replace: (a) => `${a}  /** [hwpx-cowork] 2026-11-18 키 저장을 막은 공개 페이지(GitHub Pages)인가 — 그렇다면 키는 이번 실행 동안만 */\n  keyStorageBlocked = false;\n`,
  },
  {
    id: 'ai-key-storage-blocked-create',
    file: CONTEXT,
    why: '공개 페이지에서는 키 저장소(IndexedDB)를 열지 않고 남은 것을 지운다',
    anchor: '    const backend = await openIndexedDbKeyBackend();\n    return new AiContext(loadAiSettings(), new KeyStore(backend));',
    replace: () => `    // [hwpx-cowork] 2026-11-18 GitHub Pages 에서는 키를 저장하지 않는다(studio/build/ai-key-storage-patches.mjs)
    const blocked = coworkAiKeyStorageBlocked();
    if (blocked) await coworkForgetStoredAiKeys();
    const backend = blocked ? null : await openIndexedDbKeyBackend();
    const ctx = new AiContext(loadAiSettings(), new KeyStore(backend));
    ctx.keyStorageBlocked = blocked;
    return ctx;`,
  },
  {
    id: 'ai-key-storage-blocked-label',
    file: DIALOG,
    why: "잠긴 '기억' 칸에 이 페이지가 키를 저장하지 않는다는 이유를 보인다",
    anchor: "      this.ctx.keyStore.canPersist ? t('ai.settings.remember') : t('ai.settings.rememberUnavailable')));",
    replace: () => "      this.ctx.keyStore.canPersist ? t('ai.settings.remember') : this.ctx.keyStorageBlocked ? t('ai.settings.rememberBlocked') : t('ai.settings.rememberUnavailable')));",
  },
  {
    id: 'ai-key-storage-blocked-text-ko',
    file: 'src/i18n/locales/ko.ts',
    why: '공개 페이지의 키 저장 막음 안내(한국어)',
    anchor: '  "ai.settings.rememberUnavailable": "이 브라우저에서는 키를 기억할 수 없습니다 (이번 실행 동안만 사용)",\n',
    replace: (a) => `${a}  "ai.settings.rememberBlocked": "이 공개 페이지에서는 API 키를 저장하지 않습니다 (이번 실행 동안만 사용 · 새로 고치면 지워짐)",\n`,
  },
  {
    id: 'ai-key-storage-blocked-text-en',
    file: 'src/i18n/locales/en.ts',
    why: '공개 페이지의 키 저장 막음 안내(영어)',
    anchor: '  "ai.settings.rememberUnavailable": "This browser cannot remember the key (session only)",\n',
    replace: (a) => `${a}  "ai.settings.rememberBlocked": "This public page never stores API keys (session only, cleared on reload)",\n`,
  },
];
