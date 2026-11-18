"""Chromium 한글 조합 중 반전 상자·일반 캐럿·실제 편집 글을 본문과 표 칸에서 확인한다.

    python -I tests/ui_ime_caret.py [문서.hwpx] [--body-ref s0/p7] [--cell-ref s0/p3/n1935]

HWPX_COWORK_STUDIO_DIR로 후보 번들을 고를 수 있다. 문서는 빈 포트의 임시 서버에 사본으로 올린다.
"""

import argparse
import hashlib
import socket
import sys
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ui_studio as ui


def check_composition(page, cdp, ref):
    frame = ui.editor_frame(page)
    original = ui.cw(page, 'cw.debug.text(arg)', ref)
    assert original is not None, f'문단을 찾을 수 없습니다. {ref}'
    offset = len(original)
    ui.cw(page, 'cw.focusRange({ref:arg, flash:false})', ref)
    assert ui.cw(page, 'cw.debug.select(arg[0], arg[1], arg[1])', [ref, offset])
    ui.settle(page)

    def compose(text):
        cdp.send('Input.imeSetComposition', {
            'text': text, 'selectionStart': len(text), 'selectionEnd': len(text),
        })

    def check(stage, suffix, active, relative_offset):
        state = frame.evaluate('''(ref) => {
            const overlay = document.querySelector('.caret-composition');
            const caret = document.querySelector('.caret');
            const rect = caret?.getBoundingClientRect();
            const cw = window.rhwpCowork;
            return {
                active: window.__imeCaretActive,
                overlay: !!overlay?.getClientRects().length,
                caret: !!rect && rect.width > 0 && rect.width < rect.height,
                offset: cw.debug.stats().editor.caret.charOffset,
                text: cw.debug.text(ref),
            };
        }''', ref)
        actual_text = state.pop('text')
        assert actual_text == original + suffix, f'{ref} {stage}: 편집기 글이 예상과 다릅니다.'
        assert state == {
            'active': active, 'overlay': False, 'caret': True, 'offset': base + relative_offset,
        }, f'{ref} {stage}: {state}'

    base = ui.cw(page, 'cw.debug.stats().editor.caret.charOffset')
    check('시작', '', False, 0)
    for syllable in ('ㅎ', '하', '한'):
        compose(syllable)
        check('조합 ' + syllable, syllable, True, 1)
    compose('')
    check('취소', '', False, 0)
    compose('ㅎ')
    check('다시 조합', 'ㅎ', True, 1)
    compose('한')
    check('확정 직전', '한', True, 1)
    cdp.send('Input.insertText', {'text': '한'})
    check('확정', '한', False, 1)
    page.keyboard.press('Control+z')
    ui.settle(page)
    check('한 번 되돌리기', '', False, 0)
    print(f'{ref} 통과 (시작, ㅎ→하→한, 취소, 다시 조합, 확정, 한 번 되돌리기)', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('document', nargs='?', type=Path,
                        default=Path(ui.ROOT, 'tests/fixtures/codes_hangul_cells.hwpx'))
    parser.add_argument('--body-ref')
    parser.add_argument('--cell-ref')
    args = parser.parse_args()
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        ui.PORT = sock.getsockname()[1]
    ui.BASE = f'http://localhost:{ui.PORT}'
    ui.REST = f'http://127.0.0.1:{ui.PORT}'
    with tempfile.TemporaryDirectory(prefix='hwpx-ime-caret-') as tmp:
        ui.OUT = tmp
        server, log, _ = ui.start_server(tmp)
        try:
            did = ui.upload(args.document, '한글 조합 시험.hwpx')['id']
            paras = ui.rest(f'/api/docs/{did}/paragraphs')
            body = args.body_ref or next(p['ref'] for p in paras if '/n' not in p['ref'] and p['text'].strip())
            cell = args.cell_ref or next(p['ref'] for p in paras if p.get('cell') and p['text'].strip())
            wasm = hashlib.sha256(ui.rest('/studio/rhwp_bg.wasm')).hexdigest()
            print(f'문서 {args.document.name} · 임시 포트 {ui.PORT} · WASM SHA-256 {wasm}', flush=True)
            with sync_playwright() as playwright:
                with playwright.chromium.launch(executable_path=ui.CHROME) as browser:
                    page = browser.new_page(viewport={'width': 1440, 'height': 960})
                    page.goto(ui.BASE)
                    page.evaluate("t => localStorage.setItem('hwpx.token', t)", ui.A['token'])
                    ui.open_doc(page, did)
                    frame = ui.editor_frame(page)
                    frame.locator('[aria-label="문서 편집 입력"]').evaluate('''input => {
                        window.__imeCaretActive = false;
                        input.addEventListener('compositionstart', () => { window.__imeCaretActive = true; });
                        input.addEventListener('compositionend', () => { window.__imeCaretActive = false; });
                    }''')
                    cdp = page.context.new_cdp_session(page)
                    check_composition(page, cdp, cell)
                    check_composition(page, cdp, body)
        finally:
            server.terminate()
            server.wait(timeout=10)
            log.close()


if __name__ == '__main__':
    main()
