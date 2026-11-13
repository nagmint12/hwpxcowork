"""숨은 한/글 COM 시험의 소유권·파일 보안 모듈·종료를 함께 관리한다.

임시 폴더의 child.py에서도 runpy.run_path(이 파일의 절대 경로)로 사용한다.
"""
from contextlib import contextmanager
from pathlib import Path
import runpy
import threading
import time


@contextmanager
def owned_hwp(result):
    import psutil
    import pythoncom
    import win32api
    import win32com.client
    import win32con
    import win32event
    import win32job
    import win32process

    hwp = window = None
    owned = False
    job = win32job.CreateJobObject(None, '')
    limits = win32job.QueryInformationJobObject(job, win32job.JobObjectExtendedLimitInformation)
    limits['BasicLimitInformation']['LimitFlags'] = win32job.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    win32job.SetInformationJobObject(job, win32job.JobObjectExtendedLimitInformation, limits)
    pythoncom.CoInitializeEx(pythoncom.COINIT_APARTMENTTHREADED)
    try:
        mutex = win32event.CreateMutex(None, False, r'Local\HwpxCoworkHancomAutomationStart')
        locked = False
        try:
            status = win32event.WaitForSingleObject(mutex, 60000)
            if status not in (win32event.WAIT_OBJECT_0, win32event.WAIT_ABANDONED):
                raise TimeoutError('한/글 COM 시작 차례를 60초 안에 얻지 못했습니다')
            locked = True
            for attempt in range(1, 4):
                before = {p.pid for p in psutil.process_iter(['name'])
                          if (p.info.get('name') or '').lower() == 'hwp.exe'}
                result['hwp_start_attempts'] = attempt
                try:
                    hwp = win32com.client.DispatchEx('HWPFrame.HwpObject', clsctx=pythoncom.CLSCTX_LOCAL_SERVER)
                    break
                except pythoncom.com_error as error:
                    if (error.hresult & 0xFFFFFFFF) != 0x80080005 or attempt == 3:
                        raise
                    result.setdefault('hwp_start_retries', []).append(hex(error.hresult & 0xFFFFFFFF))
                    time.sleep(2 * attempt)
            window = hwp.XHwpWindows.Item(0)
            pid = win32process.GetWindowThreadProcessId(int(window.WindowHandle))[1]
            if pid in before or psutil.Process(pid).name().lower() != 'hwp.exe':
                raise RuntimeError(f'시험이 새로 만든 한/글인지 확인하지 못했습니다(PID {pid})')
            handle = win32api.OpenProcess(win32con.PROCESS_SET_QUOTA | win32con.PROCESS_TERMINATE, False, pid)
            try:
                win32job.AssignProcessToJobObject(job, handle)
            finally:
                handle.Close()
            owned = True
            result['hwp_pid'] = pid
            result['hwp_version'] = str(hwp.Version)
            window.Visible = False
            hwp.SetMessageBoxMode(0x00011011)
            security = runpy.run_path(str(Path(__file__).resolve().parents[2] / 'scripts' / 'native-clipboard.py'))
            module_name = security['find_security_module']()
            if not module_name:
                raise RuntimeError('한/글 Automation 파일 접근 보안 모듈이 없습니다. HKCU\\Software\\HNC\\HwpAutomation\\Modules 등록을 확인하세요')
            result['security_module'] = module_name
            result['security_registered'] = bool(hwp.RegisterModule('FilePathCheckDLL', module_name))
            if not result['security_registered']:
                raise RuntimeError(f'FilePathCheckDLL 등록 실패: {module_name}. 승인창을 띄우지 않도록 파일을 열지 않았습니다')
        finally:
            if locked:
                win32event.ReleaseMutex(mutex)
            mutex.Close()
        yield hwp
    finally:
        if owned:
            # Quit가 멈춰도 소유한 Job의 한/글만 종료한다. 다른 시험의 새 PID는 건드리지 않는다.
            finished = threading.Event()
            def deadline():
                if not finished.wait(8):
                    result['forced_hwp_cleanup'] = True
                    win32job.TerminateJobObject(job, 1)
            watch = threading.Thread(target=deadline, daemon=True)
            watch.start()
            try:
                try:
                    hwp.Clear(1)
                except Exception:
                    pass
                try:
                    hwp.Quit()
                except Exception:
                    pass
            finally:
                finished.set()
                watch.join(1)
        window = hwp = None
        job.Close()
        pythoncom.CoUninitialize()
