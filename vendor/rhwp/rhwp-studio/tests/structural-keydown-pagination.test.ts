import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

test('본문 Enter와 Ctrl+Enter는 성공 때만 이전 쪽 나눔을 인수하고 유휴 조판을 예약한다', async () => {
  const vite = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)), appType: 'custom', logLevel: 'silent',
    server: { middlewareMode: true, hmr: false },
  });
  try {
    const { onKeyDown } = await vite.ssrLoadModule('/src/engine/input-handler-keyboard.ts');
    const { InputHandler } = await vite.ssrLoadModule('/src/engine/input-handler.ts');
    const { DeferredPaginationRunner } = await vite.ssrLoadModule('/src/engine/deferred-pagination-runner.ts');
    const { CommandHistory } = await vite.ssrLoadModule('/src/engine/history.ts');
    const { pageCommands } = await vite.ssrLoadModule('/src/command/commands/page.ts');
    const { WasmBridge } = await vite.ssrLoadModule('/src/core/wasm-bridge.ts');
    const { EventBus } = await vite.ssrLoadModule('/src/core/event-bus.ts');
    const pageBreak = pageCommands.find(command => command.id === 'page:break');
    const pos = { sectionIndex: 0, paragraphIndex: 7, charOffset: 4 };
    const no = () => false;
    for (const ctrlKey of [false, true]) {
      for (const outcome of ['success', 'throw', 'reject']) {
        const calls = [];
        const timers = new Map();
        let nextTimer = 1;
        let tail = false;
        let idleCompleted = false;
        const mutate = name => {
          calls.push(name);
          if (outcome === 'throw') throw new Error('forced edit failure');
          if (outcome === 'reject') return '{"ok":false}';
          tail = true;
          return JSON.stringify({ ok: true, paraIdx: 8, charOffset: 0 });
        };
        const wasm = Object.create(WasmBridge.prototype);
        wasm.doc = {
          splitParagraph: () => mutate('enter'), insertPageBreak: () => mutate('ctrl-enter'),
          savePageBreakUndo: () => 1, restoreSnapshot: () => calls.push('rollback'), discardSnapshot: () => {},
          typesetTailPending: () => tail,
          flushDeferredPagination: () => { calls.push('sync-text'); return '{"ok":true,"status":"complete"}'; },
          flushTypesetTail: () => { calls.push('sync-tail'); return '{"ok":true,"status":"complete"}'; },
        };
        const status = value => ({ ok: true, status: value, pageCount: 3, revision: 0, fragmentsProcessed: 0 });
        const runner = new DeferredPaginationRunner({
          beginDeferredPagination: () => status('pending'),
          stepDeferredPagination: () => { calls.push('idle-step'); tail = false; return status('complete'); },
          cancelDeferredPagination: () => false,
        }, () => { idleCompleted = true; }, () => { assert.fail('unexpected idle fallback'); }, 1,
        callback => { const token = nextTimer++; timers.set(token, callback); return token; }, token => timers.delete(token));

        const history = new CommandHistory();
        const historyUnchanged = history.recoveryCheckpoint();
        let priorCancelled = false;
        const handler = Object.create(InputHandler.prototype);
        const oldTimer = setTimeout(() => {}, 60000);
        const events = new EventBus();
        Object.assign(handler, {
          active: true, wasm, eventBus: events, commandErrors: null,
          deferredPaginationPending: true, deferredPaginationFlushTimer: oldTimer,
          deferredPaginationRunner: { cancel: () => { priorCancelled = true; }, hasPendingWork: () => !priorCancelled },
          typesetTailRunner: runner,
          isOperationAllowedInEditMode: () => true,
          getPosition: () => pos, getCursorPosition: () => pos,
          cursor: {
            getPosition: () => pos, getRect: () => ({ pageIndex: 2 }), moveTo: value => calls.push(['caret', value.charOffset]),
            isInCell: no, isInHeaderFooter: no, isInFootnote: no, isInPictureObjectSelection: no,
            isInTableObjectSelection: no, isInBlockSelectionMode: no, isInCellSelectionMode: no,
            isProtectedCellSelectionMode: no,
            hasSelection: no, resetPreferredX: () => {}, invalidateFocusedCellCursorGeometry: () => {},
          },
          caretLayoutReveal: { requestFor: () => {} }, clearTableResizeRuntimeCache: () => {}, updateCaret: () => {},
          history,
          dispatcher: { isEnabled: id => id === 'page:break',
            dispatch: id => { assert.equal(id, 'page:break'); pageBreak.execute({ getInputHandler: () => handler }); } },
        });
        events.on('document-changed', () => handler.startTypesetTailIfPending());
        const event = { key: 'Enter', code: 'Enter', ctrlKey, shiftKey: false, metaKey: false, altKey: false, preventDefault: () => {} };
        const originalWarn = console.warn;
        try {
          if (outcome === 'throw' && ctrlKey) {
            console.warn = () => {};
            onKeyDown.call(handler, event);
          } else if (outcome === 'throw') assert.throws(() => onKeyDown.call(handler, event), /forced edit failure/);
          else onKeyDown.call(handler, event);
          assert.ok(calls.includes(ctrlKey ? 'ctrl-enter' : 'enter'));
          assert.ok(!calls.includes('sync-text') && !calls.includes('sync-tail'),
            `${ctrlKey ? 'Ctrl+Enter' : 'Enter'} ${outcome}: ${JSON.stringify(calls)}`);
          if (outcome !== 'success') {
            assert.ok(historyUnchanged() && !calls.some(call => Array.isArray(call) && call[0] === 'caret'));
            assert.equal(handler.deferredPaginationFlushTimer, oldTimer);
            assert.equal(handler.deferredPaginationPending, true);
            assert.equal(priorCancelled, false);
            assert.equal(timers.size, 0);
          } else {
            assert.ok(!historyUnchanged());
            assert.equal(handler.deferredPaginationFlushTimer, null);
            assert.equal(handler.deferredPaginationPending, false);
            assert.equal(priorCancelled, true);
            assert.ok(tail && timers.size === 1);
            while (timers.size) {
              const [token, callback] = timers.entries().next().value;
              timers.delete(token);
              callback();
            }
            assert.ok(idleCompleted && !tail && calls.includes('idle-step'));
          }
        } finally {
          clearTimeout(oldTimer);
          console.warn = originalWarn;
        }
      }
    }
  } finally {
    await vite.close();
  }
});
