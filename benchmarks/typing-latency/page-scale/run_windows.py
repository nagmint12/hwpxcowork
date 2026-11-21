"""Apply verified Windows Job limits before Node starts, then collect peak commit."""
import argparse
import ctypes
import json
import os
from pathlib import Path
import shutil
import subprocess
import uuid

import win32api
import win32con
import win32event
import win32job
import win32process


class CpuRate(ctypes.Structure):
    _fields_ = [("flags", ctypes.c_uint32), ("rate", ctypes.c_uint32)]


def run(args):
    folder = Path(__file__).resolve().parent
    target = args.output.resolve() / args.open_mode
    target.mkdir(parents=True, exist_ok=True)
    name = f"{args.profile}-{args.pages}"
    if args.op:
        name += "-" + args.op
    if args.local_only:
        name += "-local"
    rows = target / (name + ".jsonl")
    summary = target / (name + "-job.json")
    if rows.exists() or summary.exists():
        raise FileExistsError(name)
    memory_mib = 512 if args.profile in ("limited", "memory") else 0
    rate = 200 if args.profile in ("limited", "cpu") else 5000  # 10000 = 100% of the host
    job = win32job.CreateJobObject(None, str(uuid.uuid4()))
    info_class = win32job.JobObjectExtendedLimitInformation
    info = win32job.QueryInformationJobObject(job, info_class)
    info["BasicLimitInformation"]["LimitFlags"] |= win32job.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if memory_mib:
        info["BasicLimitInformation"]["LimitFlags"] |= win32job.JOB_OBJECT_LIMIT_PROCESS_MEMORY
        info["ProcessMemoryLimit"] = memory_mib * 1048576
    win32job.SetInformationJobObject(job, info_class, info)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    handle = ctypes.c_void_p(int(job))
    limit = CpuRate(5, rate)  # ENABLE | HARD_CAP
    if not kernel.SetInformationJobObject(handle, 15, ctypes.byref(limit), ctypes.sizeof(limit)):
        raise ctypes.WinError(ctypes.get_last_error())
    actual = CpuRate()
    if not kernel.QueryInformationJobObject(handle, 15, ctypes.byref(actual), ctypes.sizeof(actual), None):
        raise ctypes.WinError(ctypes.get_last_error())
    assert (actual.rate, actual.flags) == (rate, 5)
    info = win32job.QueryInformationJobObject(job, info_class)
    assert info["ProcessMemoryLimit"] == memory_mib * 1048576
    node = shutil.which("node")
    cmd = [node, str(folder / "measure.mjs"), str(args.inputs.resolve() / f"scale-{args.pages}.hwpx"),
           str(rows), args.profile, str(args.repetitions), args.open_mode, args.op or "all",
           "local" if args.local_only else "complete"]
    proc, thread, pid, _ = win32process.CreateProcess(
        node, subprocess.list2cmdline(cmd), None, None, False, 4 | win32con.CREATE_NO_WINDOW,
        dict(os.environ), None, win32process.STARTUPINFO())
    try:
        win32job.AssignProcessToJobObject(job, proc)
    except Exception:
        win32api.TerminateProcess(proc, 1)
        raise
    win32process.ResumeThread(thread)
    win32event.WaitForSingleObject(proc, win32event.INFINITE)
    info = win32job.QueryInformationJobObject(job, info_class)
    result = dict(pid=pid, profile=args.profile, pages=args.pages, cpuPercent=actual.rate / 100,
                  commitLimitMiB=memory_mib or None, peakCommitBytes=info["PeakProcessMemoryUsed"],
                  exitCode=win32process.GetExitCodeProcess(proc))
    summary.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps(result), flush=True)
    return int(result["exitCode"] != 0)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("inputs", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("profile", choices=["normal", "limited", "cpu", "memory"])
    parser.add_argument("pages", type=int)
    parser.add_argument("--repetitions", type=int, default=5)
    parser.add_argument("--open-mode", choices=["progressive", "direct"], default="progressive")
    parser.add_argument("--op", choices=["text", "cell", "break"], help="isolate an operation after a failed run")
    parser.add_argument("--local-only", action="store_true", help="measure a text edit without forcing queued work")
    args = parser.parse_args()
    if args.local_only and args.op != "text":
        parser.error("--local-only is for --op text")
    # Serialize independent benchmark requests on this workstation.
    lock = win32event.CreateMutex(None, False, "Local\\HwpxCoworkPageScaleBenchmark")
    win32event.WaitForSingleObject(lock, win32event.INFINITE)
    try:
        exit_code = run(args)
    finally:
        win32event.ReleaseMutex(lock)
    raise SystemExit(exit_code)
