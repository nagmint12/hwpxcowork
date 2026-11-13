"""Optional Windows/Hancom benchmark. Uses only fixture fragments and own COM jobs."""
import json
import pathlib
import subprocess
import sys
import time
import uuid
import psutil
import win32clipboard as cb

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / 'artifacts' / 'format-brush-2026-10-28'
sys.stdout.reconfigure(encoding='utf-8')
source = r'''
import fs from 'node:fs';
import {initSync,HwpDocument} from './vendor/rhwp/pkg/rhwp.js';
initSync({module:fs.readFileSync('vendor/rhwp/pkg/rhwp_bg.wasm')});
const d=new HwpDocument(fs.readFileSync('testdata/'+fs.readdirSync('testdata').find(x=>x.endsWith('\uc800\uc7a5.hwpx'))));
const last=d.getParagraphCount(0)-1;
d.copySelection(0,0,0,last,d.getParagraphLength(0,last));
process.stdout.write(Buffer.from(d.exportClipboardHwpx()).toString('base64'));d.free();
'''
fragment = subprocess.run(['node','--input-type=module'],input=source,cwd=ROOT,text=True,encoding='utf-8',capture_output=True,check=True).stdout
runs = []
for n in range(3):
    token = 'bench-' + uuid.uuid4().hex
    cb.OpenClipboard()
    try:
        cb.EmptyClipboard()
        cb.SetClipboardData(cb.CF_UNICODETEXT, 'clipboard benchmark')
        cb.SetClipboardData(cb.RegisterClipboardFormat('HTML Format'), ('<!--rhwp-studio-clipboard:' + token + '-->').encode('ascii'))
    finally: cb.CloseClipboard()
    before = {p.pid for p in psutil.process_iter(['name']) if (p.info['name'] or '').lower()=='hwp.exe'}
    started = time.perf_counter()
    proc = subprocess.Popen([sys.executable,'-I',str(ROOT/'scripts/native-clipboard.py')],
        stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,creationflags=subprocess.CREATE_NO_WINDOW)
    proc.stdin.write(json.dumps({'token':token,'hwpx':fragment}).encode('utf-8'));proc.stdin.close()
    peak_hwp = 0
    peak_helper = 0
    while proc.poll() is None:
        try: peak_helper=max(peak_helper,psutil.Process(proc.pid).memory_info().rss)
        except psutil.Error: pass
        for p in psutil.process_iter(['name']):
            if p.pid not in before and (p.info['name'] or '').lower()=='hwp.exe':
                try: peak_hwp=max(peak_hwp,p.memory_info().rss)
                except psutil.Error: pass
        if time.perf_counter()-started>50:
            proc.kill()  # Only our helper; its job closes its own COM process.
            raise TimeoutError('native helper exceeded 50 seconds')
        time.sleep(.05)
    result=json.loads(proc.stdout.read().decode('utf-8'))
    assert proc.returncode==0 and result.get('ok'), result
    runs.append({'seconds':round(time.perf_counter()-started,3),'peakHwpMiB':round(peak_hwp/1048576,1),'peakPythonMiB':round(peak_helper/1048576,1)})
OUT.mkdir(parents=True,exist_ok=True)
result={'runs':runs,'note':'Each run starts a separate hidden Hancom COM instance, including Python startup and conversion; native clipboard writing only. Windows caches already warm. Peak sampled at 50ms.'}
(OUT/'benchmark-native.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
print(json.dumps(result,indent=2))
