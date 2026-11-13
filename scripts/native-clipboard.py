"""Convert a copied HWPX fragment to Hancom's native block memory.

GetTextFile(HWP) exports the isolated selection document without touching the clipboard.
Only append Hwp Native if the browser's unique copy marker is still current.
No source documents, user windows or the ordinary text/HTML formats are changed.
"""
import base64
import json
import pathlib
import re
import sys
import tempfile
import time
import zipfile
import io
import hashlib
import math
import xml.etree.ElementTree as ET
import runpy

_resources = runpy.run_path(str(pathlib.Path(__file__).with_name('clipboard-resources.py')))


def prepare_native_fragment(data):
    """[hwpx-cowork] Repair angle-only rectangles on the native copy, not the portable source.

    The editor can store a new angle with an old identity rotation matrix.
    Hancom ignores that angle on open. Materialize the four corners before
    GetTextFile(HWP, saveblock), retaining other objects and package entries.
    Existing matrix rotations, text boxes and grouped shapes stay untouched.
    """
    hp = '{http://www.hancom.co.kr/hwpml/2011/paragraph}'
    hc = '{http://www.hancom.co.kr/hwpml/2011/core}'
    identity = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0]

    def matrix(node):
        return [float(node.get('e' + str(i + 1), default)) if node is not None else default
                for i, default in enumerate(identity)]

    def multiply(a, b):
        return [a[0]*b[0]+a[1]*b[3], a[0]*b[1]+a[1]*b[4], a[0]*b[2]+a[1]*b[5]+a[2],
                a[3]*b[0]+a[4]*b[3], a[3]*b[1]+a[4]*b[4], a[3]*b[2]+a[4]*b[5]+a[5]]

    changed = {}
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        for entry in archive.infolist():
            if not re.fullmatch(r'Contents/section\d+\.xml', entry.filename):
                continue
            xml = archive.read(entry)
            root = ET.fromstring(xml)
            dirty = False
            for rect in root.iter(hp + 'rect'):
                rotation = rect.find(hp + 'rotationInfo')
                angle = int(rotation.get('angle', '0')) if rotation is not None else 0
                if angle % 360 == 0 or rect.get('groupLevel', '0') != '0' or rect.find(hp + 'drawText') is not None:
                    continue
                rendering = rect.find(hp + 'renderingInfo')
                if rendering is not None and any(matrix(r) != identity for r in rendering.findall(hc + 'rotMatrix')):
                    continue
                nodes = [rect.find(hc + 'pt' + str(i)) for i in range(4)]
                if any(node is None for node in nodes):
                    continue
                points = [(float(p.get('x', '0')), float(p.get('y', '0'))) for p in nodes]
                if (points[0][1] != points[1][1] or points[1][0] != points[2][0]
                        or points[2][1] != points[3][1] or points[3][0] != points[0][0]
                        or points[1][0] < points[0][0] or points[2][1] < points[1][1]):
                    continue
                org, cur, size = [rect.find(hp + name) for name in ['orgSz', 'curSz', 'sz']]
                if any(node is None for node in [org, cur, size]):
                    continue
                transform = matrix(rendering.find(hc + 'transMatrix') if rendering is not None else None)
                if rendering is not None:
                    for scale in rendering.findall(hc + 'scaMatrix'):
                        transform = multiply(transform, matrix(scale))
                if transform == identity:
                    for index, key in [(0, 'width'), (4, 'height')]:
                        original = float(org.get(key, '0'))
                        if original > 0:
                            transform[index] = float(size.get(key, str(original))) / original
                radians = math.radians(angle)
                sin, cos = math.sin(radians), math.cos(radians)
                transform = multiply([cos, -sin, 0, sin, cos, 0], transform)
                points = [(transform[0]*x+transform[1]*y+transform[2], transform[3]*x+transform[4]*y+transform[5]) for x, y in points]
                min_x, min_y = min(p[0] for p in points), min(p[1] for p in points)
                width, height = max(p[0] for p in points)-min_x, max(p[1] for p in points)-min_y
                if not all(math.isfinite(v) and 0 < v <= 0x7fffffff for v in [width, height]):
                    continue
                width, height = math.floor(width + 0.5), math.floor(height + 0.5)
                if width == 0 or height == 0:
                    continue
                for node, (x, y) in zip(nodes, points):
                    node.set('x', str(math.floor(x-min_x+0.5)))
                    node.set('y', str(math.floor(y-min_y+0.5)))
                for node in [org, cur, size]:
                    node.set('width', str(width))
                    node.set('height', str(height))
                rotation.set('centerX', str(width // 2))
                rotation.set('centerY', str(height // 2))
                if rendering is not None:
                    for node in rendering:
                        if node.tag in {hc + 'transMatrix', hc + 'scaMatrix', hc + 'rotMatrix'}:
                            for i, value in enumerate(identity):
                                node.set('e' + str(i + 1), str(int(value)))
                dirty = True
            if dirty:
                for _, (prefix, uri) in ET.iterparse(io.BytesIO(xml), events=['start-ns']):
                    ET.register_namespace(prefix, uri)
                changed[entry.filename] = ET.tostring(root, encoding='utf-8', xml_declaration=True)
        if not changed:
            return data
        output = io.BytesIO()
        with zipfile.ZipFile(output, 'w') as target:
            for entry in archive.infolist():
                target.writestr(entry, changed.get(entry.filename, archive.read(entry)))
        return output.getvalue()


def check():
    try:
        import win32clipboard
        import win32com.client
        import winreg
        with winreg.OpenKey(winreg.HKEY_CLASSES_ROOT, r'HWPFrame.HwpObject\CLSID'):
            pass
        return {'available': True, 'securityModule': find_security_module() is not None}
    except (ImportError, OSError):
        return {'available': False, 'reason': 'HANGUL_REQUIRED'}


def find_security_module():
    """Use an explicitly installed Automation module; never disable global checks."""
    import winreg
    names = ['HwpxCoworkFilePathCheck', 'FilePathCheckerModuleExample', 'FilePathCheckerModule']
    for view in [winreg.KEY_WOW64_32KEY, winreg.KEY_WOW64_64KEY]:
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r'Software\HNC\HwpAutomation\Modules', 0, winreg.KEY_READ | view) as key:
                for name in names:
                    try:
                        path, kind = winreg.QueryValueEx(key, name)
                        if kind == winreg.REG_SZ and pathlib.Path(path).is_file():
                            return name
                    except OSError:
                        pass
        except OSError:
            pass
    return None


def register_file_security(hwp):
    name = find_security_module()
    return bool(name and hwp.RegisterModule('FilePathCheckDLL', name))


def open_clipboard(window=0):
    import win32clipboard as cb
    for attempt in range(20):
        try:
            cb.OpenClipboard(window)
            return
        except Exception:
            if attempt == 19:
                raise
            time.sleep(0.025)


def current_marker(token):
    import win32clipboard as cb
    fmt = cb.RegisterClipboardFormat('HTML Format')
    if not cb.IsClipboardFormatAvailable(fmt):
        return False
    data = cb.GetClipboardData(fmt)
    if isinstance(data, str):
        data = data.encode('utf-8')
    return ('<!--rhwp-studio-clipboard:' + token + '-->').encode('ascii') in data


def prove_clipboard(payload):
    token = payload.get('token', '')
    if not re.fullmatch(r'[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}', token):
        return {'ok': False}
    import win32clipboard as cb
    open_clipboard()
    try:
        return {'ok': current_marker(token)}
    finally:
        cb.CloseClipboard()


def read_native(payload):
    """Read one paste-authorized native block without changing the clipboard."""
    import win32clipboard as cb
    expected = payload.get('textHash', '')
    if not re.fullmatch(r'[0-9a-f]{64}', expected):
        return {'ok': False, 'reason': 'INVALID_REQUEST'}
    open_clipboard()
    try:
        text = cb.GetClipboardData(cb.CF_UNICODETEXT) if cb.IsClipboardFormatAvailable(cb.CF_UNICODETEXT) else ''
        normalized = text.replace('\r\n', '\n').replace('\r', '\n').strip()
        if hashlib.sha256(normalized.encode('utf-8')).hexdigest() != expected:
            return {'ok': False, 'reason': 'CLIPBOARD_CHANGED'}
        if payload.get('modelHash'):
            html_fmt = cb.RegisterClipboardFormat('HTML Format')
            html = cb.GetClipboardData(html_fmt).decode('utf-8') if cb.IsClipboardFormatAvailable(html_fmt) else ''
            marker = html.find('[data-hwpjson]')
            start = html.find('{', marker) if marker >= 0 else -1
            end = html.find('-->', start) if start >= 0 else -1
            model = html[start:end].strip() if start >= 0 and end >= 0 else ''
            if hashlib.sha256(model.encode('utf-8')).hexdigest() != payload['modelHash']:
                return {'ok': False, 'reason': 'CLIPBOARD_CHANGED'}
        fmt = cb.RegisterClipboardFormat('Hwp Native')
        if not cb.IsClipboardFormatAvailable(fmt):
            return {'ok': False, 'reason': 'NO_NATIVE_FORMAT'}
        native = cb.GetClipboardData(fmt)
        if not isinstance(native, bytes) or len(native) > 32 * 1024 * 1024:
            return {'ok': False, 'reason': 'FRAGMENT_TOO_LARGE'}
        return {'ok': True, 'native': base64.b64encode(native).decode('ascii')}
    finally:
        cb.CloseClipboard()


def import_native(payload):
    """Convert bytes supplied by a paste event. Never access the OS clipboard."""
    data = base64.b64decode(payload.get('native', ''), validate=True)
    if not data.startswith(bytes.fromhex('d0cf11e0a1b11ae1')) or len(data) > 32 * 1024 * 1024:
        return {'ok': False, 'reason': 'INVALID_FRAGMENT'}
    import win32com.client
    import win32process, win32api, win32con, win32job
    with tempfile.TemporaryDirectory(prefix='hwpx_native_import_') as tmp:
        inp, out = pathlib.Path(tmp) / 'copied.hwp', pathlib.Path(tmp) / 'copied.hwpx'
        inp.write_bytes(data)
        existing = set(win32process.EnumProcesses())
        hwp = win32com.client.DispatchEx('HWPFrame.HwpObject')
        own_process, job = False, None
        try:
            _, pid = win32process.GetWindowThreadProcessId(hwp.XHwpWindows.Item(0).WindowHandle)
            if pid in existing:
                return {'ok': False, 'reason': 'ISOLATED_HANGUL_REQUIRED'}
            own_process = True
            job = win32job.CreateJobObject(None, '')
            limits = win32job.QueryInformationJobObject(job, win32job.JobObjectExtendedLimitInformation)
            limits['BasicLimitInformation']['LimitFlags'] = win32job.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            win32job.SetInformationJobObject(job, win32job.JobObjectExtendedLimitInformation, limits)
            process = win32api.OpenProcess(win32con.PROCESS_SET_QUOTA | win32con.PROCESS_TERMINATE, False, pid)
            try:
                win32job.AssignProcessToJobObject(job, process)
            finally:
                process.Close()
            hwp.SetMessageBoxMode(0x00011011)
            hwp.XHwpWindows.Item(0).Visible = False
            if not register_file_security(hwp):
                return {'ok': False, 'reason': 'SECURITY_MODULE_REQUIRED'}
            if not hwp.Open(str(inp), 'HWP', 'forceopen:true'):
                return {'ok': False, 'reason': 'OPEN_FAILED'}
            if not hwp.SaveAs(str(out), 'HWPX', '') or not out.is_file():
                return {'ok': False, 'reason': 'CONVERSION_FAILED'}
            converted = out.read_bytes()
            if len(converted) > 32 * 1024 * 1024:
                return {'ok': False, 'reason': 'FRAGMENT_TOO_LARGE'}
            converted, warnings = _resources['repair_images'](converted)
            return {'ok': True, 'hwpx': base64.b64encode(converted).decode('ascii'), 'warnings': warnings}
        finally:
            try:
                if own_process:
                    try: hwp.Clear(1)
                    except Exception: pass
                    try: hwp.Quit()
                    except Exception: pass
            finally:
                if job is not None:
                    job.Close()


def publish_native(native, token):
    """Publish static Win32/OLE data consistently, with exact native byte length."""
    import win32clipboard as cb
    import win32gui, win32api
    bridge = runpy.run_path(str(pathlib.Path(__file__).with_name('hancom-clipboard-bridge.py')))
    window = win32gui.CreateWindowEx(0, 'STATIC', 'HwpxNativeCopy', 0, 0, 0, 0, 0, 0, 0, win32api.GetModuleHandle(None), None)
    items = []
    try:
        open_clipboard(window)
        try:
            if not current_marker(token):
                return False
            bridge['freeze_formats'](cb, items)
            if not current_marker(token):
                return False
            native_format = cb.RegisterClipboardFormat('Hwp Native')
            prepared = [(fmt, kind, value) for fmt, kind, value in items if fmt != native_format]
            prepared.append((native_format, 'memory', native))
            try:
                bridge['write_formats'](cb, prepared, 0, None)
            except Exception:
                bridge['write_formats'](cb, items, 0, None)
                raise
            return True
        finally:
            cb.CloseClipboard()
    finally:
        bridge['release_formats'](items)
        win32gui.DestroyWindow(window)


def convert(payload):
    import win32clipboard as cb
    import win32com.client
    token = payload.get('token', '')
    if not re.fullmatch(r'[A-Za-z0-9._:-]{1,100}', token):
        return {'ok': False, 'reason': 'INVALID_FRAGMENT'}
    data = base64.b64decode(payload['hwpx'], validate=True)
    if len(data) > 20 * 1024 * 1024:
        return {'ok': False, 'reason': 'FRAGMENT_TOO_LARGE'}
    data, warnings = _resources['repair_images'](data)
    open_clipboard()
    try:
        if not current_marker(token):
            return {'ok': False, 'reason': 'CLIPBOARD_CHANGED'}
    finally:
        cb.CloseClipboard()

    with tempfile.TemporaryDirectory(prefix='hwpx_clip_') as tmp:
        inp = pathlib.Path(tmp) / 'selection.hwpx'
        inp.write_bytes(prepare_native_fragment(data))
        import win32process
        existing_pids = set(win32process.EnumProcesses())
        hwp = win32com.client.DispatchEx('HWPFrame.HwpObject')
        job = None
        own_process = False
        try:
            # Own only the newly created COM window/process. A job guarantees
            # cleanup if the bridge times out or the server is stopped.
            import win32api, win32con, win32job, win32process
            hwnd = hwp.XHwpWindows.Item(0).WindowHandle
            _, pid = win32process.GetWindowThreadProcessId(hwnd)
            if pid in existing_pids:
                return {'ok': False, 'reason': 'ISOLATED_HANGUL_REQUIRED'}
            own_process = True
            job = win32job.CreateJobObject(None, '')
            limits = win32job.QueryInformationJobObject(job, win32job.JobObjectExtendedLimitInformation)
            limits['BasicLimitInformation']['LimitFlags'] = win32job.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            win32job.SetInformationJobObject(job, win32job.JobObjectExtendedLimitInformation, limits)
            process = win32api.OpenProcess(win32con.PROCESS_SET_QUOTA | win32con.PROCESS_TERMINATE, False, pid)
            try:
                win32job.AssignProcessToJobObject(job, process)
            finally:
                process.Close()
            hwp.SetMessageBoxMode(0x00011011)
            hwp.XHwpWindows.Item(0).Visible = False
            if not register_file_security(hwp):
                return {'ok': False, 'reason': 'SECURITY_MODULE_REQUIRED'}
            if not hwp.Open(str(inp), 'HWPX', 'forceopen:true'):
                return {'ok': False, 'reason': 'OPEN_FAILED'}
            # The opened document already contains only the copied fragment.
            # A second block-save changes document options (for example,
            # linkinfo.pageInherit=0 becomes 1). Export the entire isolated
            # fragment to keep its options, styles and geometry intact.
            block = hwp.GetTextFile('HWP', '')
            native = base64.b64decode(''.join(block.split()), validate=True) if block else b''
            if not native.startswith(bytes.fromhex('d0cf11e0a1b11ae1')):
                return {'ok': False, 'reason': 'CONVERSION_FAILED'}
        finally:
            try:
                if own_process:
                    try: hwp.Clear(1)
                    except Exception: pass
                    try: hwp.Quit()
                    except Exception: pass
            finally:
                if job is not None:
                    job.Close()
    if not publish_native(native, token):
        return {'ok': False, 'reason': 'CLIPBOARD_CHANGED'}
    return {'ok': True, 'format': 'Hwp Native', 'warnings': warnings}


if __name__ == '__main__':
    try:
        result = check() if '--check' in sys.argv else prove_clipboard(json.load(sys.stdin)) if '--proof' in sys.argv else read_native(json.load(sys.stdin)) if '--read' in sys.argv else import_native(json.load(sys.stdin)) if '--import' in sys.argv else convert(json.load(sys.stdin))
    except ValueError as error:
        result = {'ok': False, 'reason': str(error) if str(error) in ['FRAGMENT_TOO_LARGE', 'INVALID_FRAGMENT'] else 'CONVERSION_FAILED'}
    except Exception:
        result = {'ok': False, 'reason': 'CONVERSION_FAILED'}
    print(json.dumps(result))
