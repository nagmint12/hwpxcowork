"""Carry an explicit Hancom copy into the browser without a network clipboard reader.

Only copies owned by installed Hwp.exe are enriched. Native/RTF/text/image formats
are retained; the existing CF_HTML receives the same native block as an invisible
portable fragment. No clipboard content is written to disk or to stdout.
"""
import base64
import os
import pathlib
import re
import sys
import threading
import time
import json

MAX_NATIVE = 32 * 1024 * 1024
MAX_FORMAT_BYTES = 192 * 1024 * 1024
MAX_SNAPSHOT_BYTES = 256 * 1024 * 1024
SIGNATURE = bytes.fromhex('d0cf11e0a1b11ae1')


def validate_format_size(size, total):
    # RTF expands embedded BMPs to hex; a modest HWPX may have 140 MiB of RTF.
    # Keep the entire original format, bounded separately from native uploads.
    if not size or size > MAX_FORMAT_BYTES or total + size > MAX_SNAPSHOT_BYTES:
        raise ValueError('FORMAT_TOO_LARGE_OR_UNSUPPORTED')


def empty_cf_html():
    body = b'<html><body><!--StartFragment--><!--EndFragment--></body></html>'
    template = b'Version:1.0\r\nStartHTML:%010d\r\nEndHTML:%010d\r\nStartFragment:%010d\r\nEndFragment:%010d\r\n'
    size = len(template % (0, 0, 0, 0))
    fragment = size + body.index(b'<!--EndFragment-->')
    return template % (size, size + len(body), fragment, fragment) + body + b'\0'


def portable_native_html(raw, native, version):
    if not isinstance(raw, bytes) or not isinstance(native, bytes):
        raise ValueError('INVALID_FORMAT')
    if not native.startswith(SIGNATURE) or len(native) > MAX_NATIVE or len(raw) > 48 * 1024 * 1024:
        raise ValueError('INVALID_NATIVE_BLOCK')
    if b'<!--rhwp-fragment-v1:' in raw:
        return raw
    offsets = {name: int(value) for name, value in re.findall(
        rb'(?m)^(StartHTML|EndHTML|StartFragment|EndFragment):(-?\d+)\r?$', raw[:4096])}
    sh, eh, sf, ef = [offsets.get(key, -1) for key in [b'StartHTML', b'EndHTML', b'StartFragment', b'EndFragment']]
    if not (0 <= sh <= sf <= ef <= eh <= len(raw)):
        raise ValueError('INVALID_CF_HTML_OFFSETS')
    body = raw[sh:eh]
    # Byte offsets, not Unicode character indices: Hangul occupies three UTF-8 bytes.
    start, end = sf - sh, ef - sh
    metadata = (b'<!--rhwp-native-source:hancom-' + str(version).encode('ascii') + b'-->'
                b'<!--rhwp-fragment-v1:' + base64.b64encode(native) + b'-->')
    body = body[:start] + metadata + body[start:]
    url = re.search(rb'(?m)^SourceURL:([^\r\n]*)', raw[:sh])
    source = b'SourceURL:' + url[1] + b'\r\n' if url else b''
    template = (b'Version:1.0\r\nStartHTML:%010d\r\nEndHTML:%010d\r\n'
                b'StartFragment:%010d\r\nEndFragment:%010d\r\n'
                b'StartSelection:%010d\r\nEndSelection:%010d\r\n')
    header_size = len(template % (0, 0, 0, 0, 0, 0)) + len(source)
    begin, finish = header_size + start, header_size + end + len(metadata)
    return template % (header_size, header_size + len(body), begin, finish, begin, finish) + source + body + b'\0'


def source_version(owner):
    import ctypes
    import win32process
    import win32api
    if not owner:
        return None
    _, pid = win32process.GetWindowThreadProcessId(owner)
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.OpenProcess.restype = ctypes.c_void_p
    kernel.QueryFullProcessImageNameW.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_wchar_p, ctypes.POINTER(ctypes.c_ulong)]
    kernel.CloseHandle.argtypes = [ctypes.c_void_p]
    process = kernel.OpenProcess(0x1000, False, pid)
    if not process:
        return None
    try:
        buffer = ctypes.create_unicode_buffer(32768)
        length = ctypes.c_ulong(len(buffer))
        if not kernel.QueryFullProcessImageNameW(process, 0, buffer, ctypes.byref(length)):
            return None
        image = pathlib.Path(buffer.value)
    finally:
        kernel.CloseHandle(process)
    roots = [pathlib.Path(value) / 'Hnc' for value in [os.environ.get('ProgramFiles(x86)', ''), os.environ.get('ProgramFiles', '')] if value]
    if image.name.lower() != 'hwp.exe' or not any(image.is_relative_to(root) for root in roots):
        return None
    info = win32api.GetFileVersionInfo(str(image), '\\')
    major = info['FileVersionMS'] >> 16
    return {10: 2018, 12: 2022}.get(major, 'v' + str(major))


# Hangul marks its own copy with Hwp_Native_Info (8 bytes: copying process id and a handle).
# When that process pastes and sees its own id, it asks its OLE data object instead of
# reading 'Hwp Native'. This bridge must drop the OLE object to publish the enriched HTML,
# so a kept marker made Ctrl+V in the same Hangul window fail after every copy
# (2026-11-03, 2018 10.0.0.6415 and 2022 12.0.0.3146). Without it the same window and
# other windows paste the materialized 'Hwp Native' block (text, styles, objects equal).
SAME_PROCESS_FORMATS = ['DataObject', 'Ole Private Data', 'Hwp_Native_Info']


def freeze_formats(cb, items):
    """Materialize copy data, excluding OLE's process/window transport pointers."""
    import ctypes
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.GlobalSize.argtypes = [ctypes.c_void_p]; kernel.GlobalSize.restype = ctypes.c_size_t
    kernel.GlobalLock.argtypes = [ctypes.c_void_p]; kernel.GlobalLock.restype = ctypes.c_void_p
    kernel.GlobalUnlock.argtypes = [ctypes.c_void_p]
    fmt = 0; total = 0
    while True:
        fmt = cb.EnumClipboardFormats(fmt)
        if not fmt:
            break
        try:
            if cb.GetClipboardFormatName(fmt) in SAME_PROCESS_FORMATS:
                continue
        except Exception:
            pass
        handle = cb.GetClipboardDataHandle(fmt)
        if fmt in [2, 0x82, 14, 0x8e]:
            # Preserve image/metafile previews using a duplicate owned by us.
            if fmt in [2, 0x82]:
                copy = ctypes.windll.user32.CopyImage
                copy.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_int, ctypes.c_uint]; copy.restype = ctypes.c_void_p
                duplicate = copy(handle, 0, 0, 0, 0x2000)
                kind = 'bitmap'
            else:
                copy = ctypes.windll.gdi32.CopyEnhMetaFileW
                copy.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p]; copy.restype = ctypes.c_void_p
                duplicate = copy(handle, None)
                kind = 'emf'
            if not duplicate:
                raise ValueError('PREVIEW_COPY_FAILED')
            items.append((fmt, kind, duplicate))
            continue
        size = kernel.GlobalSize(handle)
        validate_format_size(size, total)
        pointer = kernel.GlobalLock(handle)
        if not pointer:
            raise ValueError('FORMAT_UNAVAILABLE')
        try:
            data = ctypes.string_at(pointer, size)
        finally:
            kernel.GlobalUnlock(handle)
        # A METAFILEPICT contains an owned GDI handle; do not copy a stale pointer.
        if fmt in [3, 0x83]:
            raise ValueError('LEGACY_METAFILE_PREVIEW')
        items.append((fmt, 'memory', data)); total += size
    return items


def release_formats(items):
    import ctypes
    for _, kind, value in items:
        if kind == 'bitmap':
            ctypes.windll.gdi32.DeleteObject(ctypes.c_void_p(value))
        elif kind == 'emf':
            ctypes.windll.gdi32.DeleteEnhMetaFile(ctypes.c_void_p(value))


def write_formats(cb, items, html_format, html):
    import ctypes
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.GlobalAlloc.argtypes = [ctypes.c_uint, ctypes.c_size_t]; kernel.GlobalAlloc.restype = ctypes.c_void_p
    kernel.GlobalLock.argtypes = [ctypes.c_void_p]; kernel.GlobalLock.restype = ctypes.c_void_p
    kernel.GlobalUnlock.argtypes = [ctypes.c_void_p]; kernel.GlobalFree.argtypes = [ctypes.c_void_p]
    setter = ctypes.windll.user32.SetClipboardData
    setter.argtypes = [ctypes.c_uint, ctypes.c_void_p]; setter.restype = ctypes.c_void_p
    prepared = [(fmt, kind, html if fmt == html_format and html is not None else value) for fmt, kind, value in items]
    if html is not None and not any(fmt == html_format for fmt, _, _ in prepared):
        prepared.append((html_format, 'memory', html))
    cb.EmptyClipboard()
    for fmt, kind, value in prepared:
        if kind == 'memory':
            handle = kernel.GlobalAlloc(0x42, len(value))
            if not handle:
                raise MemoryError('CLIPBOARD_ALLOCATION_FAILED')
            pointer = kernel.GlobalLock(handle)
            if not pointer:
                kernel.GlobalFree(handle); raise MemoryError('CLIPBOARD_ALLOCATION_FAILED')
            ctypes.memmove(pointer, value, len(value)); kernel.GlobalUnlock(handle)
        elif kind == 'bitmap':
            copier = ctypes.windll.user32.CopyImage
            copier.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_int, ctypes.c_uint]; copier.restype = ctypes.c_void_p
            handle = copier(value, 0, 0, 0, 0x2000)
        else:
            copier = ctypes.windll.gdi32.CopyEnhMetaFileW
            copier.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p]; copier.restype = ctypes.c_void_p
            handle = copier(value, None)
        if not handle or not setter(fmt, handle):
            if handle and kind == 'memory':kernel.GlobalFree(handle)
            raise OSError('CLIPBOARD_WRITE_FAILED')


def enrich_clipboard(window=0):
    import win32clipboard as cb
    import ctypes
    # The sequence and payload are checked again after delayed rendering and before
    # replacement. A new copy always wins over a fragment being prepared.
    version = source_version(cb.GetClipboardOwner())
    if version is None:
        return {'ok': False, 'reason': 'OTHER_SOURCE'}
    html_format = cb.RegisterClipboardFormat('HTML Format')
    native_format = cb.RegisterClipboardFormat('Hwp Native')
    items = []
    cb.OpenClipboard(window)
    try:
        if not cb.IsClipboardFormatAvailable(native_format):
            return {'ok': False, 'reason': 'NO_NATIVE_FORMAT'}
        raw = cb.GetClipboardData(html_format) if cb.IsClipboardFormatAvailable(html_format) else None
        raw = raw.encode('utf8') if isinstance(raw, str) else raw
        if raw is not None and b'<!--rhwp-fragment-v1:' in raw:
            return {'ok': False, 'reason': 'ALREADY_PORTABLE'}
        native = cb.GetClipboardData(native_format)
        try:
            freeze_formats(cb, items)
        except Exception:
            release_formats(items)
            raise
        sequence = ctypes.windll.user32.GetClipboardSequenceNumber()
    finally:
        cb.CloseClipboard()
    try:
        html = portable_native_html(raw if raw is not None else empty_cf_html(), native, version)
        cb.OpenClipboard(window)
        try:
            if ctypes.windll.user32.GetClipboardSequenceNumber() != sequence:
                return {'ok': False, 'reason': 'CLIPBOARD_CHANGED'}
            # Chrome can ask Hancom's OLE IDataObject for the old HTML even after
            # SetClipboardData replaces CF_HTML. Publish a complete static copy so
            # OLE and Win32 readers both receive the same fragment, including after
            # the source document is closed. Preserve all materialized data formats.
            try:
                write_formats(cb, items, html_format, html)
            except Exception:
                write_formats(cb, items, html_format, None)
                raise
        finally:
            cb.CloseClipboard()
    finally:
        release_formats(items)
    return {'ok': True, 'sourceVersion': version, 'nativeBytes': len(native)}


def watch():
    import win32gui
    import win32api
    import win32event
    import win32security
    import win32con
    import ctypes
    import pythoncom
    pythoncom.OleInitialize()
    token = win32security.OpenProcessToken(win32api.GetCurrentProcess(), win32con.TOKEN_QUERY)
    try:
        sid = win32security.ConvertSidToStringSid(win32security.GetTokenInformation(token, win32security.TokenUser)[0])
    finally:
        token.Close()
    mutex = win32event.CreateMutex(None, False, 'Local\\HwpxCoworkClipboardBridge-' + sid)
    if win32api.GetLastError() == 183:
        mutex.Close()
        return {'ok': False, 'reason': 'ALREADY_RUNNING'}
    pending, stopped = threading.Event(), threading.Event()

    def input_closed():
        for line in sys.stdin:
            if line.strip() == 'stop':
                break
        stopped.set()

    def window_proc(hwnd, message, wparam, lparam):
        if message == 0x031D:
            pending.set()
            return 0
        return win32gui.DefWindowProc(hwnd, message, wparam, lparam)

    window_class = win32gui.WNDCLASS()
    window_class.hInstance = win32api.GetModuleHandle(None)
    window_class.lpszClassName = 'HwpxCoworkClipboardBridge'
    window_class.lpfnWndProc = window_proc
    atom = win32gui.RegisterClass(window_class)
    hwnd = win32gui.CreateWindow(atom, '', 0, 0, 0, 0, 0, 0, 0, window_class.hInstance, None)
    if not ctypes.windll.user32.AddClipboardFormatListener(hwnd):
        raise OSError('CLIPBOARD_LISTENER_FAILED')
    threading.Thread(target=input_closed, daemon=True).start()
    print(json.dumps({'event': 'ready', 'ok': True, 'pid': os.getpid()}), flush=True)
    # Do not process the clipboard present at startup; only subsequent copy events.
    previous_sequence = ctypes.windll.user32.GetClipboardSequenceNumber()
    retries = 0
    try:
        while not stopped.is_set():
            pythoncom.PumpWaitingMessages()
            sequence = ctypes.windll.user32.GetClipboardSequenceNumber()
            if sequence != previous_sequence:
                previous_sequence = sequence
                pending.set()
                retries = 0
            if pending.is_set() or retries:
                pending.clear()
                started = time.perf_counter()
                try:
                    result = enrich_clipboard(hwnd)
                    retries = 0
                    if result.get('ok'):
                        print(json.dumps({'event': 'enriched', **result, 'ms': round((time.perf_counter() - started) * 1000, 2)}), flush=True)
                    elif '--diagnose' in sys.argv:
                        print(json.dumps({'event': 'skipped', **result}), flush=True)
                except Exception as error:
                    # Delayed rendering can briefly hold the clipboard after the
                    # update event. Retry the current copy with a bounded budget.
                    retries = retries + 1 if retries < 30 else 0
                    if '--diagnose' in sys.argv and retries == 1:
                        print(json.dumps({'event': 'retry', 'errorType': type(error).__name__, 'errorCode': getattr(error, 'winerror', None), 'method': getattr(error, 'funcname', None)}), flush=True)
            stopped.wait(0.025)
    finally:
        ctypes.windll.user32.RemoveClipboardFormatListener(hwnd)
        win32gui.DestroyWindow(hwnd)
        win32gui.UnregisterClass(window_class.lpszClassName, window_class.hInstance)
        mutex.Close()
        ctypes.windll.ole32.OleUninitialize()
    return {'ok': True, 'event': 'stopped'}


if __name__ == '__main__':
    try:
        answer = watch()
    except Exception as error:
        answer = {'ok': False, 'reason': 'BRIDGE_UNAVAILABLE', 'errorType': type(error).__name__, 'errorCode': getattr(error, 'winerror', None)}
    print(json.dumps(answer), flush=True)
