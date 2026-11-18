"""GitHub Pages 입구(deploy/github-pages/app.html, 2026-11-18): 다른 주소의 페이지가 이 서버 화면을 iframe 으로 그대로 보여 줄 때
- 첫 방문 소개 영상으로 넘어갔다 와도 'GitHub 페이지' 로 알아본다(iframe 이름 — web/pages-host.js FRAME_NAME)
- 로그인·문서함은 서버 주소로 연 것과 같고, '내 AI 키' 는 저장 칸 대신 안내 한 줄, 저장 요청은 서버가 거절(PAGES_NO_SECRETS)
- 화면 안 주소(#)가 바깥 주소에 맞춰지고, /download 는 새 탭으로 연다
- 대조군: 같은 서버를 직접 연 화면은 저장 칸이 그대로
iframe·postMessage·창 이름·탭 저장소는 브라우저에서만 동작하므로 브라우저로 확인한다(AGENTS.md §2.1 예외 — 임시 개인 서버, 빈 포트).
   python -I tests/ui_pages_host.py
"""
import atexit, json, os, shutil, socket, subprocess, sys, tempfile, time
from pathlib import Path
from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding='utf-8', errors='replace')
ROOT = Path(__file__).resolve().parent.parent
CHROME = '%USERPROFILE%/AppData/Local/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-win64/chrome-headless-shell.exe'


def free_port():
    sock = socket.socket(); sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]; sock.close()
    return port


def main():
    tmp = Path(tempfile.mkdtemp(prefix='hwpx_pages_ui_'))
    atexit.register(lambda: shutil.rmtree(tmp, ignore_errors=True) if tmp.name.startswith('hwpx_pages_ui_') else None)
    env = {k: v for k, v in os.environ.items() if not k.startswith(('HWPX_', 'ELECTRON_'))}
    env.update(HWPX_COWORK_USERDATA=str(tmp / 'userdata'))
    proc = subprocess.Popen(['node', str(ROOT / 'deploy/portable/personal.mjs'), '--no-window', '--port', str(free_port())], cwd=str(ROOT), env=env,
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding='utf-8')
    site = tmp / 'site'; site.mkdir()
    static = None
    count = 0

    def ok(value, message):
        nonlocal count
        assert value, message
        count += 1; print('  ✓ ' + message, flush=True)

    try:
        port = None
        for _ in range(2000):
            line = proc.stdout.readline()
            if not line: break
            if line.startswith('PERSONAL '): port = int(line.split()[1]); break
        assert port, '임시 개인 서버가 켜지지 않았습니다'
        token = json.loads((tmp / 'userdata' / 'config.json').read_text(encoding='utf-8'))['users'][0]['token']
        server = f'http://localhost:{port}'
        # 입구 페이지는 다른 주소(127.0.0.1 의 다른 포트)에서 연다 — 실제 Pages 처럼 서버와 다른 출처
        shell = (ROOT / 'deploy/github-pages/app.html').read_text(encoding='utf-8').replace('__HWPX_SERVER__', json.dumps(server + '/'))
        (site / 'index.html').write_text(shell, encoding='utf-8')
        sport = free_port()
        static = subprocess.Popen([sys.executable, '-m', 'http.server', str(sport), '--bind', '127.0.0.1', '--directory', str(site)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        shell_url = f'http://127.0.0.1:{sport}/'
        for _ in range(50):
            try:
                with socket.create_connection(('127.0.0.1', sport), timeout=0.5): break
            except OSError: time.sleep(0.2)
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=CHROME)
            ctx = browser.new_context()
            page = ctx.new_page()
            page.goto(shell_url)
            frame = page.frame_locator('#app')
            app = None
            for _ in range(150):
                app = next((f for f in page.frames if f.url.startswith(server)), None)
                if app and app.url and ('/teaser/' in app.url or app.query_selector('.login')): break
                time.sleep(0.2)
            ok(app is not None, '입구 페이지가 서버 화면을 iframe 으로 연다')
            if '/teaser/' in app.url:
                ok(True, '첫 방문은 서버와 같이 소개 영상으로 간다')
                app.goto(server + '/?teaser=0')
            app.wait_for_selector('.login', timeout=30000)
            ok(app.evaluate("() => import('/pages-host.js').then((m) => m.PAGES_HOST)"), '소개 영상을 거쳐 와도 GitHub 페이지 화면으로 알아본다(iframe 이름)')
            app.fill('#login-token', token); app.click('.login form button[type=submit]')
            app.wait_for_selector('.listpage', timeout=30000)
            ok(True, '로그인·문서함은 서버 주소로 연 것과 같다')
            ok(app.query_selector('[data-testid=personal-ai-pages]') is not None and app.query_selector('[data-testid=personal-ai-save]') is None, "'내 AI 키' 는 저장 칸 대신 안내 한 줄")
            code = app.evaluate("""() => import('/util.js').then((m) => m.api('/api/me/ai', { method: 'PUT', body: { gateway: 'direct', provider: 'openai', model: 'gpt-test', key: 'sk-test-0000000000000000000000' } }).then(() => 'saved', (e) => e.code))""")
            ok(code == 'PAGES_NO_SECRETS', f'화면에서 보낸 키 저장 요청을 서버가 거절한다({code})')
            app.evaluate("() => { location.hash = '#/admin' }")
            page.wait_for_function("() => location.hash === '#/admin'", timeout=10000)
            ok(True, '화면 안 주소(#/admin)가 바깥 주소에 맞춰진다')
            with ctx.expect_page(timeout=15000) as popup:
                app.evaluate("() => { const a = document.createElement('a'); a.href = '/download'; document.body.append(a); a.click(); a.remove(); }")
            ok(popup.value.url.startswith(server + '/download'), '/download 는 새 탭으로 연다(다른 창 안에서는 열리지 않는 쪽)')
            popup.value.close()

            direct = browser.new_context().new_page()
            direct.goto(f'{server}/?teaser=0#/t/{token}')
            direct.wait_for_selector('.listpage', timeout=30000)
            ok(not direct.evaluate("() => import('/pages-host.js').then((m) => m.PAGES_HOST)") and direct.query_selector('[data-testid=personal-ai-save]') is not None, '대조군: 서버 주소로 직접 연 화면은 저장 칸이 그대로')
            browser.close()
        print(f'통과 {count}개')
    finally:
        if static: static.kill()
        try:
            proc.stdin.write('quit\n'); proc.stdin.flush(); proc.wait(timeout=30)
        except Exception:
            proc.kill()


if __name__ == '__main__':
    main()
