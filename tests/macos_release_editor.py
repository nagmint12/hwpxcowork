"""Run the actual downloaded standalone app in an isolated macOS runner."""
import argparse
import io
import pathlib
import subprocess
import tempfile
import time
import zipfile
import xml.etree.ElementTree as ET
from playwright.sync_api import sync_playwright
from ui_pages_fonts import WATCH, COMPARE, body_document, check_paint


def inspect_app(bundle, temp):
    profile = temp / 'profile'
    app = subprocess.Popen([str(bundle / 'Contents/MacOS/Hwpx Editor'),
                            f'--user-data-dir={profile}', '--remote-debugging-port=0',
                            '--remote-debugging-address=127.0.0.1'])
    try:
        port_file = profile / 'DevToolsActivePort'
        deadline = time.monotonic() + 60
        while not port_file.exists():
            if app.poll() is not None or time.monotonic() > deadline:
                raise RuntimeError('The packaged editor did not start')
            time.sleep(0.25)
        port = port_file.read_text().splitlines()[0]
        with sync_playwright() as pw:
            browser = pw.chromium.connect_over_cdp(f'http://127.0.0.1:{port}')
            context = browser.contexts[0]
            page = context.pages[0] if context.pages else context.wait_for_event('page')
            page.wait_for_url('hwpx-local://editor/**')
            page.wait_for_function("window.rhwpStudio?.automation && document.querySelector('#sb-message')?.textContent.includes('새 문서')")
            page.evaluate("""async () => {
              const api = window.rhwpStudio.automation;
              api.registerCommand({id:'ext:release-check',label:'Release check',execute(s){window.releaseEditor=s}});
              await api.execute('ext:release-check');
            }""")
            data = bytes(page.evaluate('Array.from(releaseEditor.wasm.exportHwpx())'))
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                header = ET.fromstring(archive.read('Contents/header.xml'))
                style = header.find(".//{*}style[@name='바탕글']")
                shape = header.find(f".//{{*}}charPr[@id='{style.get('charPrIDRef')}']")
                assert shape.get('height') == '1000'
                refs = shape.find('{*}fontRef').attrib
                assert len(refs) == 7
                for slot, index in refs.items():
                    group = header.find(f".//{{*}}fontface[@lang='{slot.upper()}']")
                    assert group.find(f"{{*}}font[@id='{index}']").get('face') == 'Noto Sans KR'
            print('PASS native new document, seven body font slots at 10pt', flush=True)
            page.evaluate(WATCH)
            for family in ['Noto Sans KR', 'KoPub돋움체', 'Wingdings']:
                fixture = temp / (family + '.hwpx')
                fixture.write_bytes(body_document(family)['buffer'])
                page.evaluate('bodyDraws.clear()')
                subprocess.run(['open', '-a', str(bundle), str(fixture)], check=True)
                page.wait_for_function("name => releaseEditor.wasm.fileName === name && ['a','2','.','한'].every(c=>bodyDraws.has(c))",
                                       arg=fixture.name, timeout=60000)
                rows = page.evaluate(COMPARE, {'family': family})
                check_paint(rows, family)
                print('PASS native file open and glyphs', family, 'installed Wingdings:', rows[0]['hasWingdings'], flush=True)
                page.evaluate("window.rhwpStudio.automation.execute('file:new-doc', {}, {allowDialog:true})")
                page.wait_for_function("releaseEditor.wasm.fileName === '새 문서.hwp'")
    finally:
        if app.poll() is None:
            app.terminate()
            try:
                app.wait(10)
            except subprocess.TimeoutExpired:
                app.kill()
                app.wait()


if __name__ == '__main__':
    cli = argparse.ArgumentParser()
    cli.add_argument('bundle', type=pathlib.Path)
    args = cli.parse_args()
    with tempfile.TemporaryDirectory() as directory:
        inspect_app(args.bundle.resolve(), pathlib.Path(directory))
