"""Alt+C choices, repeated/cross-tab use, one undo, clipboard independence."""
import json
import pathlib
import runpy
import sys
import tempfile
import urllib.request
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / 'artifacts' / 'format-brush-2026-10-28'
CHROME = '%USERPROFILE%/AppData/Local/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-win64/chrome-headless-shell.exe'
FRAME = "document.querySelector('.editorhost iframe')"
sys.stdout.reconfigure(encoding='utf-8', errors='replace')


def main():
    Server = runpy.run_path(str(ROOT / 'tests' / 'export_hangul.py'))['Server']
    OUT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='hwpx_format_ui_') as tmp:
        srv = Server(pathlib.Path(tmp))
        try:
            source = (ROOT / 'testdata' / '매크로테스트용_저장.hwpx').read_bytes()
            token = srv.tokens['a']
            def upload():
                req = urllib.request.Request(srv.base + '/api/docs', data=source, method='POST', headers={
                    'Authorization': 'Bearer ' + token, 'Content-Type': 'application/octet-stream', 'x-file-name': 'format.hwpx'})
                with urllib.request.urlopen(req) as r: return json.load(r)['id']
            with sync_playwright() as p:
                br = p.chromium.launch(executable_path=CHROME)
                ctx = br.new_context(viewport={'width': 1440, 'height': 960}, accept_downloads=True)
                ctx.grant_permissions(['clipboard-read', 'clipboard-write'], origin=srv.base)
                ctx.add_init_script("localStorage.setItem('hwpx.token', " + json.dumps(token) + ");")
                ctx.route('**/api/clipboard/status', lambda r: r.fulfill(json={'available': False}))
                errors = []
                def open_doc():
                    pg = ctx.new_page()
                    pg.on('pageerror', lambda e: errors.append(str(e)))
                    pg.goto(srv.base + '/#/doc/' + upload())
                    pg.wait_for_function('window.__doc?.editor?.ready === true', timeout=120000)
                    pg.evaluate('async () => await ' + FRAME + '.contentWindow.rhwpCowork.debug.settled()')
                    f = next(f for f in pg.frames if '/studio/' in f.url)
                    f.evaluate('''() => {
                      const api=window.rhwpStudio.automation;
                      api.registerCommand({id:'ext:format-test',label:'test',execute(s){
                        window.fmtTest={wasm:s.wasm,input:s.getInputHandler()};
                      }}); api.execute('ext:format-test');
                    }''')
                    focus(pg, 's0/p0', 1)
                    return pg, f
                def focus(pg, ref, start, end=None):
                    point = pg.evaluate('(ref) => ' + FRAME + '.contentWindow.rhwpCowork.debug.pointFor(ref,0)', ref)
                    offset = pg.evaluate('() => {const r=' + FRAME + '.getBoundingClientRect();return {x:r.left,y:r.top}}')
                    pg.mouse.click(point['x']+offset['x']+2, point['y']+offset['y']+2)
                    assert pg.evaluate('([ref,s,e]) => ' + FRAME + '.contentWindow.rhwpCowork.debug.select(ref,s,e)', [ref,start,start if end is None else end])
                def props(f, para):
                    return f.evaluate('p=>({c:window.fmtTest.wasm.getCharPropertiesAt(0,p,0),p:window.fmtTest.wasm.getParaPropertiesAt(0,p)})', para)
                pg, f = open_doc()
                focus(pg, 's0/p0', 0, 1)
                f.evaluate('window.fmtTest.input.applyCharFormat({fontSize:2100,bold:true,textColor:"#b00000"})')
                f.evaluate('window.fmtTest.input.applyParaFormat({alignment:"center"})')
                focus(pg, 's0/p0', 1)
                pg.evaluate("navigator.clipboard.writeText('untouched-Ctrl-C')")
                pg.keyboard.press('Alt+c')
                dlg = f.get_by_role('dialog', name='모양 복사')
                dlg.wait_for()
                assert dlg.locator('input[type=radio]').count() == 5
                assert dlg.locator('[value=characterStyle]').is_disabled()
                dlg.locator('[value=both]').check()
                pg.screenshot(path=str(OUT / 'alt-c-dialog.png'))
                dlg.get_by_role('button', name='복사', exact=True).click()
                assert pg.evaluate('navigator.clipboard.readText()') == 'untouched-Ctrl-C'
                before = props(f, 1)
                focus(pg, 's0/p1', 0, 3)
                pg.keyboard.press('Alt+c')
                f.wait_for_function('window.fmtTest.wasm.getCharPropertiesAt(0,1,0).fontSize===2100')
                after = props(f, 1)
                assert after['p']['alignment'] == 'center'
                assert after['c']['bold'] is True
                assert f.get_by_role('dialog', name='모양 복사').count() == 0
                pg.keyboard.press('Control+z')
                assert props(f, 1) == before, 'both kinds must undo together'
                pg.keyboard.press('Control+y')
                assert props(f, 1) == after
                focus(pg, 's0/p2', 0, 3)
                pg.keyboard.press('Alt+c')
                assert props(f, 2)['c']['fontSize'] == 2100, 'buffer remains usable'
                other, of = open_doc()
                of.wait_for_function('window.fmtTest.input.hasCopiedFormat()')
                focus(other, 's0/p1', 0, 3)
                other.keyboard.press('Alt+c')
                assert props(of, 1)['c']['fontSize'] == 2100, 'format crosses documents/tabs'
                assert props(of, 1)['p']['alignment'] == 'center'
                # Caption text receives a real character-format change.
                focus(other, 's0/p5/n0', 0, 3)
                other.keyboard.press('Alt+c')
                assert of.evaluate('window.fmtTest.wasm.getCellCharPropertiesAt(0,5,0,65534,0,0).fontSize') == 2100
                # Cancelling a new source chooser retains the previous brush.
                focus(other, 's0/p3', 1)
                other.keyboard.press('Alt+c')
                of.get_by_role('dialog', name='모양 복사').wait_for()
                other.keyboard.press('Escape')
                focus(other, 's0/p4', 0, 2)
                other.keyboard.press('Alt+c')
                assert props(of, 4)['c']['fontSize'] == 2100
                # A plain HWPX handoff works with the local bridge unavailable.
                of.evaluate('window.fmtTest.input.cursor.enterTableObjectSelectionDirect(0,5,0)')
                other.keyboard.press('Control+c')
                with other.expect_download() as download:
                    of.evaluate("window.rhwpStudio.automation.execute('edit:save-copied-hwpx')")
                saved = OUT / 'copied-table.hwpx'
                download.value.save_as(str(saved))
                import zipfile
                with zipfile.ZipFile(saved) as z:
                    assert '<hp:autoNum ' in z.read('Contents/section0.xml').decode('utf-8')
                assert not errors, errors
                (OUT / 'result.json').write_text(json.dumps({'ok':True,'cases':['five choices','clipboard unchanged','both undo/redo','repeat','cross tab','caption','cancel','HWPX handoff']},ensure_ascii=False,indent=2),encoding='utf-8')
                print('PASS Alt+C: choices, undo/redo, repeated, cross-tab, captions, cancellation, clipboard independence, HWPX handoff')
                br.close()
        finally:
            srv.stop()


if __name__ == '__main__': main()
