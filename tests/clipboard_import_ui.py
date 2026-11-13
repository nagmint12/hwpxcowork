"""Real browser paste: same editor, another tab, Hancom native and HWP JSON."""
import base64
import io
import json
import pathlib
import re
import runpy
import subprocess
import sys
import tempfile
import time
import urllib.request
import zipfile
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / 'artifacts' / 'clipboard-import-2026-10-28'
CHROME = '%USERPROFILE%/AppData/Local/ms-playwright/chromium-1223/chrome-win64/chrome.exe'
FRAME = "document.querySelector('.editorhost iframe')"
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
sys.stderr.reconfigure(encoding='utf-8', errors='replace')

COPY = r'''
import pathlib,sys,time,struct,shutil
import win32com.client,win32clipboard as cb,win32api,win32con,win32job,win32process
before=set(win32process.EnumProcesses())
hwp=win32com.client.DispatchEx('HWPFrame.HwpObject')
_,pid=win32process.GetWindowThreadProcessId(hwp.XHwpWindows.Item(0).WindowHandle)
assert pid not in before
job=win32job.CreateJobObject(None,'')
info=win32job.QueryInformationJobObject(job,win32job.JobObjectExtendedLimitInformation)
info['BasicLimitInformation']['LimitFlags']=win32job.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
win32job.SetInformationJobObject(job,win32job.JobObjectExtendedLimitInformation,info)
proc=win32api.OpenProcess(win32con.PROCESS_SET_QUOTA|win32con.PROCESS_TERMINATE,False,pid)
try: win32job.AssignProcessToJobObject(job,proc)
finally: proc.Close()
try:
    hwp.SetMessageBoxMode(0x00011011)
    hwp.XHwpWindows.Item(0).Visible=False
    assert hwp.Open(str(pathlib.Path(sys.argv[1]).resolve()),'HWPX','forceopen:true')
    hwp.HAction.Run('SelectAll')
    assert hwp.HAction.Run('Copy')
    for attempt in range(40):
        try:
            cb.OpenClipboard()
            break
        except Exception:
            if attempt==39: raise
            time.sleep(.025)
    try:
        formats=[cb.RegisterClipboardFormat('Hwp Native'),cb.RegisterClipboardFormat('HTML Format'),cb.CF_UNICODETEXT]
        values=[(fmt,cb.GetClipboardData(fmt)) for fmt in formats]
        # Force a preview image to coexist with rich document data. Paste must
        # select the actual structure, not this one-pixel raster preview.
        dib=struct.pack('<IiiHHIIiiII',40,1,1,1,24,0,4,0,0,0,0)+bytes([255,0,0,0])
        cb.EmptyClipboard()
        for fmt,value in values: cb.SetClipboardData(fmt,value)
        cb.SetClipboardData(cb.CF_DIB,dib)
    finally: cb.CloseClipboard()
finally:
    try: hwp.Clear(1)
    except Exception: pass
    try: hwp.Quit()
    except Exception: pass
    job.Close()
'''


def counts(data):
    z = zipfile.ZipFile(io.BytesIO(data))
    s = z.read('Contents/section0.xml').decode('utf-8')
    return {kind: len(re.findall('<hp:' + kind + r'\b', s)) for kind in ['tbl', 'pic', 'caption', 'autoNum']}


def main():
    Server = runpy.run_path(str(ROOT / 'tests' / 'export_hangul.py'))['Server']
    OUT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='hwpx_import_ui_') as tmp:
        tmp = pathlib.Path(tmp)
        srv = Server(tmp)
        try:
            source = (ROOT / 'testdata' / '매크로테스트용_저장.hwpx').read_bytes()
            source_file = tmp / 'source.hwpx'
            source_file.write_bytes(source)
            token = srv.tokens['a']
            def upload():
                req = urllib.request.Request(srv.base + '/api/docs', data=source, method='POST', headers={
                    'Authorization': 'Bearer ' + token, 'Content-Type': 'application/octet-stream', 'x-file-name': 'clipboard.hwpx'})
                with urllib.request.urlopen(req) as r: return json.load(r)['id']
            with sync_playwright() as p:
                br = p.chromium.launch(executable_path=CHROME, headless=False,
                    args=['--window-position=-32000,-32000', '--disable-backgrounding-occluded-windows'])
                ctx = br.new_context(viewport={'width': 1440, 'height': 960})
                ctx.grant_permissions(['clipboard-read', 'clipboard-write'], origin=srv.base)
                ctx.add_init_script("localStorage.setItem('hwpx.token', " + json.dumps(token) + ");")
                # Web-to-web must work without Windows/COM export support.
                ctx.route('**/api/clipboard/status', lambda route: route.fulfill(json={'available': False}))
                errors = []
                def open_doc():
                    pg = ctx.new_page()
                    pg.on('pageerror', lambda e: errors.append(str(e)))
                    pg.goto(srv.base + '/#/doc/' + upload())
                    pg.wait_for_function('window.__doc?.editor?.ready === true', timeout=120000)
                    pg.wait_for_function(FRAME + '?.contentWindow?.rhwpCowork', timeout=30000)
                    pg.evaluate('async () => await ' + FRAME + '.contentWindow.rhwpCowork.debug.settled()')
                    frame = next(f for f in pg.frames if '/studio/' in f.url)
                    frame.evaluate('''() => {
                      const api=window.rhwpStudio.automation;
                      api.registerCommand({id:'ext:clipboard-test',label:'test',execute(s){
                        window.clipTest={wasm:s.wasm,input:s.getInputHandler()};
                      }}); api.execute('ext:clipboard-test');
                    }''')
                    focus(pg, 's0/p0')
                    return pg, frame
                def focus(pg, ref, start=0, end=None):
                    point = pg.evaluate('(ref) => ' + FRAME + '.contentWindow.rhwpCowork.debug.pointFor(ref, 0)', ref)
                    offset = pg.evaluate('() => { const r=' + FRAME + '.getBoundingClientRect(); return {x:r.left,y:r.top}; }')
                    pg.mouse.click(point['x'] + offset['x'] + 2, point['y'] + offset['y'] + 2)
                    selected = pg.evaluate('([ref,start,end]) => ' + FRAME + '.contentWindow.rhwpCowork.debug.select(ref,start,end)', [ref,start,start if end is None else end])
                    assert selected
                def snapshot(frame):
                    raw = frame.evaluate('''() => {
                      const b=window.clipTest.wasm.exportHwpx();let s='';
                      for(let i=0;i<b.length;i+=32768)s+=String.fromCharCode(...b.subarray(i,i+32768));
                      return btoa(s);
                    }''')
                    return base64.b64decode(raw)
                def wait_counts(frame, expected, name):
                    until = time.time() + 25
                    while time.time() < until:
                        data = snapshot(frame)
                        actual = counts(data)
                        if actual == expected:
                            (OUT / (name + '.hwpx')).write_bytes(data)
                            print(name + ': ' + json.dumps(actual), flush=True)
                            return
                        time.sleep(.15)
                    raise AssertionError({'case':name,'expected':expected,'actual':actual})
                original = {'tbl':4,'pic':3,'caption':7,'autoNum':7}
                doubled = {'tbl':8,'pic':6,'caption':14,'autoNum':14}
                first, ff = open_doc()
                first.locator('[data-testid=document-view-options] summary').click()
                first.locator('[data-testid=show-control-codes]').click()
                assert first.locator('[data-testid=show-control-codes]').get_attribute('aria-checked') == 'true'
                assert first.locator('[data-testid=show-paragraph-marks]').get_attribute('aria-checked') == 'true'
                assert ff.evaluate('window.rhwpStudio.automation.getContext().showControlCodes') is True
                first.screenshot(path=str(OUT / 'view-options.png'))
                ff.wait_for_function("() => { const b=window.clipTest.wasm; return b.getPageLayerTree(0).includes('[번호]'); }", timeout=15000)
                first.locator('[data-testid=document-view-options] summary').click()
                focus(first, 's0/p5/n0', 3)
                first.keyboard.press('Shift+ArrowLeft')
                first.keyboard.press('Control+c')
                focus(first, 's0/p5/n0', 0)
                first.keyboard.press('Control+v')
                with_number = {**original, 'autoNum':8}
                wait_counts(ff, with_number, 'same-editor-number')
                first.keyboard.press('Control+z')
                wait_counts(ff, original, 'number-undo')
                first.keyboard.press('Control+y')
                wait_counts(ff, with_number, 'number-redo')
                first.close()
                for copy_key, label in [('Control+c', 'copy'), ('Control+x', 'cut')]:
                    source_pg, sf = open_doc()
                    source_pg.keyboard.press('Control+a')
                    source_pg.keyboard.press(copy_key)
                    if label == 'cut': wait_counts(sf, {kind:0 for kind in original}, 'cut-source')
                    target_pg, tf = open_doc()
                    focus(target_pg, 's0/p3')
                    target_pg.keyboard.press('Control+v')
                    wait_counts(tf, doubled, 'other-tab-full-document-' + label)
                    source_pg.close(); target_pg.close()
                for kind, para, expected in [('image',7,{**original,'pic':4,'caption':8,'autoNum':8}),
                                              ('table',5,{**original,'tbl':5,'caption':8,'autoNum':8})]:
                    pg, frame = open_doc()
                    if kind == 'image':
                        frame.evaluate("window.clipTest.input.selectPictureObject(0,7,0,'image')")
                    else:
                        frame.evaluate('window.clipTest.input.cursor.enterTableObjectSelectionDirect(0,5,0)')
                    pg.keyboard.press('Control+c')
                    pg.wait_for_function("async () => (await navigator.clipboard.readText()) === " + json.dumps('[그림]' if kind == 'image' else '[표]'))
                    target, target_frame = open_doc()
                    focus(target, 's0/p3')
                    target.keyboard.press('Control+v')
                    wait_counts(target_frame, expected, 'object-' + kind)
                    pg.close(); target.close()
                for case, use_native in [('hancom-native', True), ('hancom-json', False)]:
                    pg, frame = open_doc()
                    if not use_native:
                        pg.route('**/api/clipboard/read-native', lambda route: route.fulfill(status=409, json={'ok':False,'reason':'NO_NATIVE_FORMAT'}))
                    result = subprocess.run([sys.executable,'-I','-c',COPY,str(source_file)], capture_output=True, timeout=40)
                    assert result.returncode == 0, result.stderr.decode('utf-8','replace')
                    focus(pg, 's0/p3')
                    pg.keyboard.press('Control+v')
                    wait_counts(frame, doubled, case)
                    pg.screenshot(path=str(OUT / (case + '.png')))
                    pg.close()
                pg, frame = open_doc()
                focus(pg, 's0/p3', 0, 3)
                before_text = pg.evaluate('() => ' + FRAME + '.contentWindow.rhwpCowork.debug.text("s0/p3")')
                bad_model = {'ro': {'hp':'p','p':{'np':'','ru':[{'cp':'','ch':[{'cc':11,'ci':1,'co':'bad'}]}]}}, 'cs':{'bad':{'ci':1}}}
                html = '<p>failed structural paste</p><!--[data-hwpjson]' + json.dumps(bad_model) + '-->'
                frame.evaluate('''html => {
                  const data=new DataTransfer();data.setData('text/plain','failed structural paste');data.setData('text/html',html);
                  window.clipTest.input.textarea.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));
                }''', html)
                frame.get_by_text('한글 원본 구조를 읽지 못했습니다.', exact=False).wait_for(timeout=15000)
                wait_counts(frame, original, 'invalid-structure-rollback')
                assert pg.evaluate('() => ' + FRAME + '.contentWindow.rhwpCowork.debug.text("s0/p3")') == before_text
                pg.close()
                assert not errors, errors
                br.close()
        finally:
            srv.stop()


if __name__ == '__main__': main()
