"""Browser Ctrl+C/Ctrl+X -> actual Hancom paste (Windows + Hancom + Playwright).
Uses an isolated server, temporary documents and hidden COM windows only.
python -I tests/clipboard_hangul.py
"""
import base64
import io
import hashlib
import json
import pathlib
import re
import runpy
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
import zipfile
import xml.etree.ElementTree as ET

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
sys.stderr.reconfigure(encoding='utf-8', errors='replace')
OUT = ROOT / 'artifacts' / 'clipboard-2026-10-28'
CHROME = '%USERPROFILE%/AppData/Local/ms-playwright/chromium-1223/chrome-win64/chrome.exe'
FRAME = "document.querySelector('.editorhost iframe')"
PASTE = r'''
import pathlib, sys, time, win32com.client, win32clipboard as cb
import win32api, win32con, win32job, win32process
jobs=[]
def new_hwp():
    before=set(win32process.EnumProcesses())
    hwp=win32com.client.DispatchEx('HWPFrame.HwpObject')
    _,pid=win32process.GetWindowThreadProcessId(hwp.XHwpWindows.Item(0).WindowHandle)
    assert pid not in before, 'COM window must be isolated'
    job=win32job.CreateJobObject(None,'')
    info=win32job.QueryInformationJobObject(job,win32job.JobObjectExtendedLimitInformation)
    info['BasicLimitInformation']['LimitFlags']=win32job.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    win32job.SetInformationJobObject(job,win32job.JobObjectExtendedLimitInformation,info)
    proc=win32api.OpenProcess(win32con.PROCESS_SET_QUOTA|win32con.PROCESS_TERMINATE,False,pid)
    try: win32job.AssignProcessToJobObject(job,proc)
    finally: proc.Close()
    jobs.append(job)
    hwp.SetMessageBoxMode(0x00011011)
    hwp.XHwpWindows.Item(0).Visible=False
    return hwp
hwp = new_hwp()
try:
    if len(sys.argv) > 2:
        assert hwp.Open(str(pathlib.Path(sys.argv[2]).resolve()), 'HWPX', 'forceopen:true')
        hwp.HAction.Run('SelectAll')
        assert hwp.HAction.Run('Copy')
        # Render delayed HWP clipboard data before closing its source window.
        for attempt in range(50):
            try:
                cb.OpenClipboard()
                break
            except Exception:
                if attempt == 49: raise
                time.sleep(0.025)
        try:
            fmt=cb.RegisterClipboardFormat('Hwp Native')
            native=cb.GetClipboardData(fmt)
            cb.EmptyClipboard()
            cb.SetClipboardData(fmt,native)
        finally: cb.CloseClipboard()
        hwp.Clear(1)
        hwp.Quit()
        hwp=new_hwp()
    hwp.HAction.Run('FileNew')
    assert hwp.HAction.Run('Paste'), 'Hancom Paste failed'
    assert hwp.SaveAs(str(pathlib.Path(sys.argv[1]).resolve()), 'HWPX', '')
finally:
    try: hwp.Clear(1)
    except Exception: pass
    try: hwp.Quit()
    except Exception: pass
    for job in jobs: job.Close()
'''


def inspect(data):
    zip = zipfile.ZipFile(io.BytesIO(data))
    xml = zip.read('Contents/section0.xml').decode('utf-8')
    ns = {'hp': 'http://www.hancom.co.kr/hwpml/2011/paragraph', 'hh': 'http://www.hancom.co.kr/hwpml/2011/head'}
    header = ET.fromstring(zip.read('Contents/header.xml'))
    fonts = {}
    for face in header.findall('.//hh:fontface', ns):
        for font in face.findall('hh:font', ns):
            fonts[(face.get('lang'), font.get('id'))] = font.get('face')
    styles = {}
    for style in header.findall('.//hh:charPr', ns):
        ref = style.find('hh:fontRef', ns)
        styles[style.get('id')] = (
            style.get('height'),
            tuple(fonts.get((lang.upper(), ref.get(lang))) for lang in ['hangul', 'latin']) if ref is not None else (),
            style.find('hh:bold', ns) is not None, style.find('hh:italic', ns) is not None)
    text_styles = set()
    for run in ET.fromstring(xml).findall('.//hp:run', ns):
        for text in run.findall('hp:t', ns):
            value = ''.join(text.itertext()).strip()
            if value:
                text_styles.add((value, styles[run.get('charPrIDRef')]))
    return {
        'tables': len(re.findall(r'<hp:tbl\b', xml)),
        'pictures': len(re.findall(r'<hp:pic\b', xml)),
        'numbers': re.findall(r'<hp:autoNum\b[^>]*numType="([^"]+)"', xml),
        'sizes': re.findall(r'<hp:sz\b[^>]*width="(\d+)"[^>]*height="(\d+)"', xml),
        'spans': re.findall(r'<hp:cellSpan\b[^>]*colSpan="(\d+)"[^>]*rowSpan="(\d+)"', xml),
        'imageCount': len([n for n in zip.namelist() if n.startswith('BinData/') and not n.endswith('/')]),
        'imageHashes': sorted(hashlib.sha256(zip.read(n)).hexdigest() for n in zip.namelist() if n.startswith('BinData/') and not n.endswith('/')),
        'textStyles': sorted(text_styles),
    }


def wait_for(fn, timeout=50):
    deadline = time.time() + timeout
    while time.time() < deadline:
        value = fn()
        if value:
            return value
        time.sleep(0.1)
    raise AssertionError('timed out waiting for native clipboard')


def main():
    from playwright.sync_api import sync_playwright
    import win32clipboard as cb
    helper = runpy.run_path(str(ROOT / 'tests' / 'export_hangul.py'))
    OUT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='hwpx_clip_ui_') as tmp:
        tmp = pathlib.Path(tmp)
        srv = helper['Server'](tmp)
        report = []
        try:
            token = srv.tokens['a']
            source = (ROOT / 'testdata' / '매크로테스트용_저장.hwpx').read_bytes()
            headers = {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/octet-stream', 'x-file-name': urllib.parse.quote('복사시험.hwpx')}
            req = urllib.request.Request(srv.base + '/api/docs', data=source, headers=headers, method='POST')
            with urllib.request.urlopen(req) as response:
                docid = json.load(response)['id']
            with sync_playwright() as p:
                # Headless Chromium owns a virtual clipboard, so use the real
                # Windows clipboard in an offscreen window for this boundary.
                browser = p.chromium.launch(executable_path=CHROME, headless=False,
                    args=['--window-position=-32000,-32000', '--disable-backgrounding-occluded-windows'])
                context = browser.new_context(viewport={'width': 1440, 'height': 960})
                context.grant_permissions(['clipboard-read', 'clipboard-write'], origin=srv.base)
                context.add_init_script("localStorage.setItem('hwpx.token', " + json.dumps(token) + ");")
                pg = context.new_page()
                errors = []
                pg.on('pageerror', lambda error: errors.append(str(error)))
                requests = []
                pg.on('request', lambda request: requests.append(request) if request.url.endswith('/api/clipboard/native') else None)
                pg.goto(srv.base + '/#/doc/' + docid)
                pg.wait_for_function("window.__doc?.editor?.ready === true", timeout=120000)
                pg.wait_for_function(FRAME + '?.contentWindow?.rhwpCowork', timeout=30000)
                pg.evaluate('async () => await ' + FRAME + '.contentWindow.rhwpCowork.debug.settled()')
                frame = next(f for f in pg.frames if '/studio/' in f.url)
                point = pg.evaluate('() => ' + FRAME + '.contentWindow.rhwpCowork.debug.pointFor("s0/p0", 0)')
                offset = pg.evaluate('() => { const r=' + FRAME + '.getBoundingClientRect(); return {x:r.left,y:r.top}; }')
                pg.mouse.click(point['x'] + offset['x'] + 2, point['y'] + offset['y'] + 2)

                for label, action in [('copy', 'Control+c'), ('cut', 'Control+x'), ('number', 'Control+c')]:
                    if label == 'number':
                        # Each destructive scenario uses a temporary document.
                        # Start a fresh source after the whole-document cut.
                        with urllib.request.urlopen(req) as uploaded:
                            fresh = json.load(uploaded)['id']
                        pg.goto(srv.base + '/#/doc/' + fresh)
                        pg.wait_for_function("window.__doc?.editor?.ready === true", timeout=120000)
                        pg.wait_for_function(FRAME + '?.contentWindow?.rhwpCowork', timeout=30000)
                        pg.evaluate('async () => await ' + FRAME + '.contentWindow.rhwpCowork.debug.settled()')
                        frame = next(f for f in pg.frames if '/studio/' in f.url)
                        pg.wait_for_function('() => (' + FRAME + '.contentWindow.rhwpCowork.debug.text("s0/p5/n0") || "").length > 3', timeout=30000)
                        point = pg.evaluate('() => ' + FRAME + '.contentWindow.rhwpCowork.debug.pointFor("s0/p5/n0", 0)')
                        pg.mouse.click(point['x'] + offset['x'] + 2, point['y'] + offset['y'] + 2)
                        selected = pg.evaluate('() => ' + FRAME + '.contentWindow.rhwpCowork.debug.select("s0/p5/n0", 3, 3)')
                        assert selected, 'caption selection failed'
                        # Base refs omit the generated number; after positioning
                        # before ']', select the actual rendered number by key.
                        pg.keyboard.press('Shift+ArrowLeft')
                    else:
                        pg.keyboard.press('Control+a')
                    with pg.expect_response(lambda response: response.url.endswith('/api/clipboard/native'), timeout=60000) as pending:
                        pg.keyboard.press(action)
                    response = pending.value
                    result = response.json()
                    if not result.get('ok'):
                        cb.OpenClipboard()
                        try:
                            html = cb.GetClipboardData(cb.RegisterClipboardFormat('HTML Format'))
                            (OUT / 'failed-clipboard.html').write_bytes(html)
                        finally:
                            cb.CloseClipboard()
                        print('request token:', json.loads(requests[-1].post_data)['token'], flush=True)
                    assert result.get('ok'), result
                    fragment = base64.b64decode(json.loads(requests[-1].post_data)['hwpx'])
                    expected = inspect(fragment)
                    if label != 'number':
                        assert (expected['tables'], expected['pictures'], len(expected['numbers'])) == (4, 3, 7), expected
                    else:
                        assert expected['numbers'] == ['TABLE'] and expected['tables'] == 0, expected
                    # Native augmentation must retain browser formats and its unique marker.
                    cb.OpenClipboard()
                    try:
                        assert cb.IsClipboardFormatAvailable(cb.RegisterClipboardFormat('Hwp Native'))
                        assert cb.IsClipboardFormatAvailable(cb.CF_UNICODETEXT)
                        assert b'rhwp-studio-clipboard:' in cb.GetClipboardData(cb.RegisterClipboardFormat('HTML Format'))
                    finally:
                        cb.CloseClipboard()
                    out = tmp / (label + '.hwpx')
                    child = subprocess.run([sys.executable, '-I', '-c', PASTE, str(out)], capture_output=True, timeout=40)
                    assert child.returncode == 0, child.stderr.decode('utf-8', 'replace')
                    actual = inspect(out.read_bytes())
                    # HWP's normal paste resolves named styles against the
                    # destination and omits some review metadata. Use an
                    # independent Hancom Ctrl+C as the oracle for that behavior.
                    original = tmp / (label + '-source.hwpx')
                    original.write_bytes(fragment)
                    baseline = tmp / (label + '-baseline.hwpx')
                    direct = subprocess.run([sys.executable, '-I', '-c', PASTE, str(baseline), str(original)], capture_output=True, timeout=40)
                    assert direct.returncode == 0, direct.stderr.decode('utf-8', 'replace')
                    expected['textStyles'] = inspect(baseline.read_bytes())['textStyles']
                    if actual != expected:
                        (OUT / (label + '-difference.json')).write_text(json.dumps({'expected': expected, 'actual': actual}, ensure_ascii=False, indent=2), encoding='utf-8')
                        mismatches = [key for key in expected if actual[key] != expected[key]]
                        raise AssertionError(f'{label}: differing properties {mismatches}; see artifacts/clipboard-2026-10-28/{label}-difference.json')
                    shutil.copyfile(out, OUT / (label + '-pasted.hwpx'))
                    frame.locator('#sb-message').screenshot(path=str(OUT / (label + '-status.png')))
                    report.append({'case': label, 'result': actual})
                    print(label + ': native paste preserved tables, pictures, numbers, sizes and cell spans', flush=True)
                    if label == 'cut':
                        # Cut really removed the source; its native snapshot survived.
                        assert not pg.evaluate('() => ' + FRAME + '.contentWindow.rhwpCowork.debug.text("s0/p0")').strip()
                assert not errors, errors
                # An older request must never overwrite a newer OS clipboard.
                cb.OpenClipboard()
                try:
                    cb.EmptyClipboard()
                    cb.SetClipboardData(cb.CF_UNICODETEXT, 'newer clipboard content')
                finally:
                    cb.CloseClipboard()
                stale = urllib.request.Request(srv.base + '/api/clipboard/native',
                    data=requests[-1].post_data.encode('utf-8'),
                    headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'}, method='POST')
                try:
                    urllib.request.urlopen(stale)
                    raise AssertionError('stale copy was accepted')
                except urllib.error.HTTPError as error:
                    assert error.code == 409 and json.load(error)['reason'] == 'CLIPBOARD_CHANGED'
                cb.OpenClipboard()
                try:
                    assert cb.GetClipboardData(cb.CF_UNICODETEXT) == 'newer clipboard content'
                finally:
                    cb.CloseClipboard()
                browser.close()
            (OUT / 'ui-results.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        finally:
            srv.stop()


if __name__ == '__main__':
    main()
