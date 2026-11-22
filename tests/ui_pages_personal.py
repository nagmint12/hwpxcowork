"""Exercise the personal app using only static hosting. Pass a built directory or its published HTTPS URL."""
import argparse
import functools
import http.server
import io
import pathlib
import tempfile
import threading
import urllib.parse
import xml.etree.ElementTree as ET
import zipfile
from contextlib import contextmanager
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[1]
FIXTURE = ROOT / 'tests/fixtures/hangul_trk_brk_base.hwpx'


@contextmanager
def site(target):
    if target.startswith('https://'):
        yield target.rstrip('/') + '/'
        return
    misses = []
    class Static(http.server.SimpleHTTPRequestHandler):
        def translate_path(self, path):
            return super().translate_path(path.removeprefix('/hwpxcowork'))
        def log_message(self, *_args):
            pass
        def send_error(self, code, *args):
            misses.append((code, self.path))
            return super().send_error(code, *args)
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Static, directory=target))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        yield f'http://127.0.0.1:{server.server_port}/hwpxcowork/'
        assert not [v for v in misses if '/api/' in v[1]], misses
    finally:
        server.shutdown()
        server.server_close()


def editor(page, doc=None):
    page.wait_for_function("""id => window.__doc?.editor.ready && !window.__doc.editor.locked
        && (!id || window.__doc.id === id)""", arg=doc, timeout=90000)
    return page.locator('[role=tabpanel]:visible .editorhost iframe').content_frame


def point(page, ref, offset):
    js = """async ([ref, offset]) => {
        const frame = document.querySelector('[role=tabpanel]:not([hidden]) .editorhost iframe');
        const cw = frame.contentWindow.rhwpCowork;
        await cw.debug.settled();
        const pt = await cw.debug.pointFor(ref,offset), box = frame.getBoundingClientRect();
        return [pt.x + box.x, pt.y + box.y];
    }"""
    return page.evaluate(js, [ref, offset])


def api(page, path, body=None, method='POST'):
    return page.evaluate("""async ([path,body,method]) => {
        const response = await fetch(new URL('api/' + path, location.href), body == null ? {} :
            {method, headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
        const value = await response.json();
        if (!response.ok) throw Error(path + ' ' + response.status + ' ' + JSON.stringify(value));
        return value;
    }""", [path, body, method])


def written_text(blob):
    with zipfile.ZipFile(io.BytesIO(blob)) as archive:
        sections = [n for n in archive.namelist() if n.startswith('Contents/section') and n.endswith('.xml')]
        return ''.join(s for n in sections for s in ET.fromstring(archive.read(n)).itertext())


def test_app(pw, url, profile, channel):
    options = dict(headless=True, viewport={'width': 1500, 'height': 900}, accept_downloads=True)
    if channel:
        options['channel'] = channel
    ctx = pw.chromium.launch_persistent_context(profile, **options)
    page = ctx.pages[0]
    errors = []
    hosts = set()
    ctx.on('request', lambda req: hosts.add(urllib.parse.urlsplit(req.url).netloc) if req.url.startswith(('http:', 'https:')) else None)
    page.on('pageerror', lambda err: errors.append(str(err)))
    page.on('dialog', lambda dialog: dialog.accept())
    page.goto(url)
    page.get_by_test_id('office-open-files').wait_for()
    page.get_by_test_id('office-file-input').set_input_files(FIXTURE)
    frame = editor(page)
    doc = page.evaluate('window.__doc.id')
    personal_url = page.url
    mark = 'Pages-local-edit'
    memo = '근거를 확인했습니다 Pages 메모'
    page.mouse.click(*point(page, 's0/p0', 2))
    page.keyboard.type(mark)
    page.wait_for_function("mark => window.__doc.s.paragraphs.some(p => p.text.includes(mark))", arg=mark, timeout=45000)
    # Exercise the browser/Haansoft HTML path in both directions, without touching the system clipboard.
    copied = page.evaluate("""async (mark) => {
        const f = document.querySelector('[role=tabpanel]:not([hidden]) .editorhost iframe').contentWindow;
        const debug = f.rhwpCowork.debug;
        const line = debug.text('s0/p0'), at = line.indexOf(mark);
        if (at < 0) throw Error('복사할 글 누락');
        await debug.select('s0/p0', at, at + mark.length);
        const input = f.document.querySelector('[aria-label="문서 편집 입력"]');
        const transfer = new f.DataTransfer();
        input.dispatchEvent(new f.ClipboardEvent('copy', {bubbles:true, cancelable:true, clipboardData:transfer}));
        const board = new f.DOMParser().parseFromString(transfer.getData('text/html'), 'text/html').getElementById('hwpEditorBoardContent');
        if (!board?.innerHTML.includes('[data-hwpjson]')) throw Error('한/글 문서모델이 빠졌습니다');
        const incoming = new f.DataTransfer();
        incoming.setData('text/html', board.outerHTML);
        incoming.setData('text/plain', 'plain-text-fallback');
        await debug.select('s0/p0', at + mark.length, at + mark.length);
        input.dispatchEvent(new f.ClipboardEvent('paste', {bubbles:true, cancelable:true, clipboardData:incoming}));
        return transfer.getData('text/plain');
    }""", mark)
    assert copied == mark, copied
    page.wait_for_function("mark => window.__doc.s.paragraphs.some(p => p.text.includes(mark + mark))", arg=mark, timeout=45000)
    print('PASS browser copy and paste through the Hangul HTML document model', flush=True)
    page.mouse.click(*point(page, 's0/p1', 3), button='right')
    frame.locator('[data-cowork-action=memo]').click()
    page.locator('.popover textarea').fill(memo)
    page.locator('.popover .memoedit button.primary').click()
    page.wait_for_function("memo => window.__doc.s.memos.some(m => m.text.includes(memo))", arg=memo)
    with page.expect_download() as download:
        page.get_by_test_id('save-hangul').click()
    result = written_text(pathlib.Path(download.value.path()).read_bytes())
    assert mark in result and memo in result, '내려받은 HWPX에 편집 글과 메모가 있어야 합니다'
    print('PASS file picker, editing, memo menu, HWPX download', flush=True)

    page.get_by_test_id('office-app-menu').click()
    page.get_by_test_id('cowork-tutorial').click()
    menu = page.get_by_test_id('tutorial-menu')
    menu.locator('[data-tutorial=report] button').click()
    page.wait_for_function("old => window.__doc?.id && window.__doc.id !== old && window.__doc.editor.ready", arg=doc, timeout=90000)
    tutorial = page.evaluate('window.__doc.id')
    courses = api(page, 'tutorial')
    assert any(s['docId'] == tutorial for s in courses['sessions'])
    assert {'report', 'ai-work', 'ai-advanced', 'clipboard'} <= {item['id'] for item in courses['items']}
    prefix = 'docs/' + tutorial
    find = '일정 부분 기여한 것으로 보인다'
    replacement = '일정 부분 기여한 것으로 나타났다'
    para = next(p for p in api(page, prefix + '/paragraphs') if find in p['text'])
    start = para['text'].index(find)
    payload = dict(kind='instruct', instruction='‘보인다’ 말고, 적절한 표현으로', target=dict(ref=para['ref'], start=start, end=start+len(find), text=find))
    page.locator('.tour-close:visible').click(timeout=30000)
    page.locator('.tour-pause:visible').click()
    page.locator('.tour:visible').wait_for(state='hidden')
    for action in ['reject', 'apply']:
        page.evaluate("target => window.__doc.openComposer(target, 'instruct')", payload['target'])
        composer = page.locator('.composer-win:visible')
        composer.locator('.cmp-instr').fill(payload['instruction'])
        composer.locator('.cmp-send').click()
        button = composer.locator('.result .rs-reject' if action == 'reject' else '.result .rs-adopt').first
        button.click(timeout=45000)
        page.wait_for_function("""async ([prefix, action, ref, value]) => {
            const get = suffix => fetch('./api/' + prefix + '/' + suffix).then(r => r.json());
            const proposals = await get('proposals');
            const proposal = proposals.at(-1);
            return proposal?.status === (action === 'reject' ? 'rejected' : 'applied') &&
                (await get('paragraphs')).some(p => p.ref === ref && p.text.includes(value));
        }""", arg=[prefix, action, para['ref'], find if action == 'reject' else replacement], timeout=30000)
        request = api(page, prefix + '/requests')[-1]
        assert request['status'] == 'done' and request['handledBy'] == '예시 답변', request
    print('PASS tutorial menu, canned response, reject, apply to the actual document', flush=True)
    guide = api(page, 'tutorial/definition')
    guide['definition']['courses'][0]['title'] = '내 연습 과정'
    updated = api(page, 'tutorial/definition', {'revision': guide['revision'], 'definition': guide['definition']}, method='PUT')
    assert updated['revision'] != guide['revision']
    advanced = api(page, 'tutorial/start', {'tutorialId': 'ai-advanced'})['docId']
    work = 'docs/' + advanced
    api(page, work + '/requests', {'kind': 'instruct', 'target': {'scope': 'document'}, 'instruction': '이 표를 시각화하여 제시해줘', 'tutorialStep': 'S1', 'route': 'example'})
    demo = api(page, work + '/requests')[-1]
    assert demo['status'] == 'done' and demo['handledBy'] == '예시 답변' and '넣지 못했습니다' not in demo['summary'], demo
    assert any(p['type'] == 'figure' for p in api(page, work + '/proposals'))
    print('PASS customizing a tutorial and generating its canned figure proposal', flush=True)
    assert not errors, errors
    assert hosts == {urllib.parse.urlsplit(url).netloc}, hosts
    page.goto('about:blank')
    ctx.close()

    # A fresh browser process exercises IndexedDB hydration, including the tutorial document and session.
    ctx = pw.chromium.launch_persistent_context(profile, **options)
    page = ctx.pages[0]
    page.goto(personal_url)
    editor(page, doc)
    assert any(memo in m['text'] for m in api(page, 'docs/' + doc + '/memos'))
    assert any(mark in p['text'] for p in api(page, 'docs/' + doc + '/paragraphs'))
    assert any(replacement in p['text'] for p in api(page, prefix + '/paragraphs'))
    assert api(page, 'tutorial/definition')['revision'] == updated['revision']
    page.get_by_test_id('office-file-input').set_input_files(ROOT / 'vendor/rhwp/saved/blank2010.hwp')
    page.wait_for_function("old => window.__doc?.id !== old && window.__doc?.s.info?.fileName === 'blank2010.hwpx' && window.__doc.editor.ready", arg=doc, timeout=45000)
    with page.expect_download() as legacy:
        page.get_by_test_id('save-hangul').click()
    written_text(pathlib.Path(legacy.value.path()).read_bytes())
    print('PASS HWP import and HWPX download', flush=True)
    page.goto('about:blank')
    ctx.close()
    print('PASS reopening personal and tutorial files from browser storage', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('target')
    parser.add_argument('--channel', default='')
    args = parser.parse_args()
    with site(args.target) as url, tempfile.TemporaryDirectory() as profile, sync_playwright() as pw:
        test_app(pw, url, profile, args.channel)
