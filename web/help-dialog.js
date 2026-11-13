// 편집기·작성 중인 요청을 그대로 둔 채 프로그램 안에서 설명서를 읽는다.
import { ref, computed, nextTick, onMounted, onBeforeUnmount } from '/vendor/vue.esm-browser.prod.js';
import { state } from './util.js';

// 떠 있는 설명서 창을 코드로 여는 손잡이(HelpDialog 가 붙어 있는 동안) — 상단 AI 알약 등. 없으면 새 탭으로
let openFromCode = null;
/** 사용 설명서 그 절을 문서 화면 안 창으로 연다(hash: '#ai' …). opener = 닫은 뒤 초점을 돌려줄 요소 */
export function openHelp(hash = '#start', opener = null) {
  if (openFromCode) return openFromCode(hash, opener);
  window.open(`/help.html${hash || ''}`, '_blank', 'noopener');
  return null;
}

export const HelpDialog = {
  template: `<dialog ref="dialog" class="help-dialog" aria-labelledby="help-dialog-title" data-testid="help-dialog"
      @cancel.prevent="close" @click="backdrop" @keydown.esc.stop.prevent="close">
    <header class="help-dialog-head"><h2 id="help-dialog-title">사용 설명서</h2>
      <div class="help-dialog-actions"><button class="small" v-if="isAdmin" data-testid="help-full-manual" @click="openTopic('#manual')">상세 운영 매뉴얼</button>
        <a class="btnlike small" :href="standaloneUrl" target="_blank" rel="noopener" data-help-new-tab>새 창으로 보기</a>
        <button ref="closeButton" autofocus class="small" data-testid="help-close" aria-label="설명서 닫기" @click="close">닫기</button></div></header>
    <p class="help-dialog-loading muted" v-if="loading" role="status">설명서를 여는 중입니다…</p>
    <iframe v-if="source" ref="frame" class="help-dialog-frame" :src="source" title="HWPX 공동 검토 사용 설명서" @load="loaded"/>
  </dialog>`,
  setup() {
    const dialog = ref(null); const frame = ref(null); const closeButton = ref(null);
    const source = ref(''); const loading = ref(false); const currentHash = ref('#start');
    const standaloneUrl = computed(() => `/help.html${currentHash.value}`);
    // 상세 운영 매뉴얼은 관리자 전용 — 설명서(help.js)도 /api/me 의 role 로 관리자 절을 드러낸다
    const isAdmin = computed(() => state.me?.role === 'admin');
    let returnFocus = null; let frameDocument = null; let frameWindow = null;

    function close() {
      if (!dialog.value?.open) return;
      dialog.value.close();
      document.body.classList.remove('help-dialog-open');
      if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    }
    async function openTopic(hash = '#start', opener = null) {
      if (opener) returnFocus = opener;
      else if (!dialog.value?.open) returnFocus = document.activeElement;
      const target = `/help.html?embedded=1${hash || '#start'}`;
      currentHash.value = hash || '#start';
      // 같은 설명서의 목차 이동은 iframe을 다시 열지 않아 다운로드·주소 선택 등 사용 상태를 지킨다.
      if (frame.value?.contentWindow?.location.pathname === '/help.html') frame.value.contentWindow.location.hash = hash || '#start';
      else {
        loading.value = true;
        // 보조 자료로 이동한 뒤 같은 버튼을 다시 열어도 같은 src 문자열 때문에 갱신이 빠지지 않게 한다.
        if (frame.value?.contentWindow) frame.value.contentWindow.location.replace(target);
        else source.value = target;
      }
      await nextTick();
      if (!dialog.value.open) {
        dialog.value.showModal(); document.body.classList.add('help-dialog-open');
        closeButton.value?.focus({ preventScroll: true });
      }
    }
    function frameKey(event) {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopImmediatePropagation(); close();
    }
    function loaded() {
      loading.value = false;
      frameDocument?.removeEventListener('keydown', frameKey, true);
      frameWindow?.removeEventListener('hashchange', syncHash);
      frameDocument = frame.value?.contentDocument || null;
      frameWindow = frame.value?.contentWindow || null;
      frameDocument?.addEventListener('keydown', frameKey, true);
      frameWindow?.addEventListener('hashchange', syncHash);
      syncHash();
    }
    function syncHash() { currentHash.value = frameWindow?.location.hash || '#start'; }
    function backdrop(event) {
      if (event.target !== dialog.value) return;
      const r = dialog.value.getBoundingClientRect();
      if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) close();
    }
    function followHelp(event) {
      // Ctrl/⌘ 클릭 등 브라우저의 명시적인 새 탭 동작은 유지한다.
      if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const link = event.target.closest?.('a[href]');
      if (!link || link.hasAttribute('data-help-new-tab')) return;
      let url; try { url = new URL(link.href, location.href); } catch { return; }
      if (url.origin !== location.origin || url.pathname !== '/help.html') return;
      event.preventDefault(); event.stopPropagation(); openTopic(url.hash, link);
    }
    onMounted(() => { document.addEventListener('click', followHelp, true); openFromCode = openTopic; });
    onBeforeUnmount(() => {
      if (openFromCode === openTopic) openFromCode = null;
      document.removeEventListener('click', followHelp, true);
      frameDocument?.removeEventListener('keydown', frameKey, true);
      frameWindow?.removeEventListener('hashchange', syncHash);
      document.body.classList.remove('help-dialog-open');
    });
    return { dialog, frame, closeButton, source, loading, standaloneUrl, isAdmin, close, openTopic, loaded, backdrop };
  },
};
