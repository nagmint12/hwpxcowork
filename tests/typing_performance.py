"""Isolated browser typing benchmark. Uses fixtures and a temporary server only.

python -I tests/typing_performance.py --label before [--cpu 4]
Results: tests/out/typing_performance_<label>.json (timings are observations,
not machine-independent real-time guarantees).
"""
import argparse
import importlib.util
import json
import os
import shutil
import statistics
import tempfile
import time
import base64
import io
import zipfile
from pathlib import Path

from playwright.sync_api import sync_playwright

spec = importlib.util.spec_from_file_location("studio_helpers", Path(__file__).with_name("studio_plugin.py"))
h = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h)


def percentile(values, p):
    return sorted(values)[min(len(values) - 1, int((len(values) - 1) * p))] if values else 0


def run():
    parser = argparse.ArgumentParser()
    parser.add_argument("--label", default="current")
    parser.add_argument("--cpu", type=int, default=1)
    parser.add_argument("--profile", action="store_true")
    parser.add_argument("--export", action="store_true", help="also verify typing during an off-thread export")
    args = parser.parse_args()
    if not args.label.replace("_", "").replace("-", "").isalnum():
        parser.error("label must contain letters, digits, underscores or hyphens")
    h.PORT = 0
    import socket
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        h.PORT = sock.getsockname()[1]
    h.BASE = f"http://localhost:{h.PORT}"
    h.REST = f"http://127.0.0.1:{h.PORT}"
    tmp = tempfile.mkdtemp(prefix="hwpx-typing-")
    srv = log = None
    result = {"label": args.label, "cpuSlowdown": args.cpu, "documents": []}
    try:
        srv, log, _ = h.start_server(tmp)
        result["build"] = h.rest('/studio/cowork-build.json')
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=h.CHROME, headless=True)
            context = browser.new_context(viewport={"width": 1440, "height": 1000})
            page = context.new_page()
            page.goto(h.BASE)
            page.evaluate("t => localStorage.setItem('hwpx.token', t)", h.ME["token"])
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            cdp = context.new_cdp_session(page)
            for name, fixture in [("small", h.FIX), ("report", h.BIG)]:
                if not os.path.exists(fixture):
                    continue
                doc = h.upload(fixture, f"typing-{name}.hwpx")
                h.open_doc(page, doc["id"])
                frame = next(f for f in page.frames if "/studio/" in f.url)
                target = page.evaluate("() => window.__paragraphs.filter(p => !p.parent && p.kind === 'text' && p.text.length > 15)[0]")
                assert target, "editable body paragraph required"
                page.evaluate("r => window.__cowork.focusRange({ref:r, flash:false})", target["ref"])
                page.evaluate("r => window.__cowork.debug.select(r, 1, 1)", target["ref"])
                h.settle(page)
                cdp.send("Emulation.setCPUThrottlingRate", {"rate": args.cpu})
                frame.evaluate("""() => {
                    window.__typingMeasures = [];
                    for (const type of ['keydown', 'input', 'beforeinput']) {
                        window.addEventListener(type, e => {
                            const start = performance.now();
                            queueMicrotask(() => window.__typingMeasures.push({
                                type, key: e.key || e.inputType, handlerMs: performance.now()-start
                            }));
                        }, true);
                    }
                }""")
                before = page.evaluate("window.__cowork.debug.stats()")
                if args.profile:
                    cdp.send("Profiler.enable")
                    cdp.send("Profiler.start")
                timings = []
                for op in ["insert", "delete"]:
                    wall = []
                    for _ in range(12):
                        start = time.perf_counter()
                        if op == "insert":
                            page.keyboard.insert_text("가")
                        else:
                            page.keyboard.press("Backspace")
                        wall.append((time.perf_counter() - start) * 1000)
                        page.wait_for_timeout(40)
                    timings.append({"operation": op, "count": len(wall), "medianMs": statistics.median(wall), "p95Ms": percentile(wall, .95), "maxMs": max(wall)})
                if args.profile:
                    profile = cdp.send("Profiler.stop")["profile"]
                    Path(h.OUT, f"typing_profile_{args.label}_{name}.json").write_text(json.dumps(profile), encoding="utf-8")
                    cdp.send("Profiler.disable")
                measures = frame.evaluate("window.__typingMeasures")
                h.settle(page)
                after = page.evaluate("window.__cowork.debug.stats()")
                actual = page.evaluate("r => window.__cowork.debug.text(r)", target["ref"])
                assert actual == target["text"], f"typing/deletion lost or duplicated content in {name}"
                entry = {"name": name, "pages": after["pages"], "paragraphs": len(page.evaluate("window.__paragraphs")), "timings": timings, "events": measures, "before": before, "after": after, "contentRestored": True}
                # Exercise real Chromium composition events rather than only
                # inserting already-composed Korean characters.
                ime_times = []
                for composition in ["ㅎ", "하", "한"]:
                    start = time.perf_counter()
                    cdp.send("Input.imeSetComposition", {"text": composition, "selectionStart": len(composition), "selectionEnd": len(composition)})
                    ime_times.append((time.perf_counter() - start) * 1000)
                cdp.send("Input.insertText", {"text": "한"})
                h.settle(page)
                ime_text = page.evaluate("r => window.__cowork.debug.text(r)", target["ref"])
                assert ime_text == target["text"][:1] + "한" + target["text"][1:], f"IME composition duplicated or lost text: {ime_text[:40]}"
                page.keyboard.press("Backspace")
                h.settle(page)
                assert page.evaluate("r => window.__cowork.debug.text(r)", target["ref"]) == target["text"]
                entry["ime"] = {"updatesMs": ime_times, "committedOnce": True, "contentRestored": True}
                if args.export:
                    count = frame.evaluate("performance.getEntriesByName('cowork.export.snapshot').length")
                    page.evaluate("""() => {
                        window.__exportDone = false;
                        const start = performance.now();
                        window.__exportPromise = window.__studio.exportHwpx().then(bytes => {
                            window.__exportBytes = bytes;
                            window.__exportMs = performance.now() - start;
                            window.__exportDone = true;
                        });
                    }""")
                    frame.wait_for_function("n => performance.getEntriesByName('cowork.export.snapshot').length > n || parent.__exportDone", arg=count, timeout=120000)
                    during = []
                    for char in "나다라마":
                        start = time.perf_counter()
                        page.keyboard.insert_text(char)
                        during.append((time.perf_counter() - start) * 1000)
                    page.evaluate("window.__exportPromise")
                    encoded = page.evaluate("""() => {
                        const bytes = window.__exportBytes;
                        let raw = '';
                        for (let i = 0; i < bytes.length; i += 32768) raw += String.fromCharCode(...bytes.subarray(i, i + 32768));
                        return btoa(raw);
                    }""")
                    output = base64.b64decode(encoded)
                    with zipfile.ZipFile(io.BytesIO(output)) as archive:
                        assert archive.infolist()[0].filename == "mimetype"
                        assert archive.infolist()[0].compress_type == zipfile.ZIP_STORED
                        xml = archive.read("Contents/section0.xml").decode("utf-8")
                        assert "나다라마" not in xml, "in-flight export snapshot must exclude later typing"
                    h.settle(page)
                    actual = page.evaluate("r => window.__cowork.debug.text(r)", target["ref"])
                    assert actual == target["text"][:1] + "나다라마" + target["text"][1:], "typing during export must stay in the editor"
                    assert page.evaluate("window.__cowork.draftState()")["dirty"], "later edits must remain dirty"
                    entry["export"] = {
                        "totalMs": page.evaluate("window.__exportMs"),
                        "measures": frame.evaluate("performance.getEntriesByName('cowork.export.snapshot').map(e => e.duration)"),
                        "typingDuringExportMs": during,
                        "bytes": len(output), "snapshotPreserved": True, "laterInputDirty": True,
                    }
                    print(json.dumps({"name": name, "export": entry["export"]}, ensure_ascii=False), flush=True)
                result["documents"].append(entry)
                print(json.dumps({k: entry[k] for k in ["name", "pages", "paragraphs", "timings", "contentRestored"]}, ensure_ascii=False), flush=True)
                cdp.send("Emulation.setCPUThrottlingRate", {"rate": 1})
            assert not errors, errors
            result["pageErrors"] = errors
            browser.close()
    finally:
        if srv:
            srv.terminate()
            try:
                srv.wait(timeout=10)
            except Exception:
                srv.kill()
                srv.wait(timeout=10)
        if log:
            log.close()
        shutil.rmtree(tmp, ignore_errors=True)
    Path(h.OUT, f"typing_performance_{args.label}.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    run()
