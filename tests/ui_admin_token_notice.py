"""관리자 접속 토큰 안내(web/admin-token-notice.js, 2026-11-17)와 '나가기' 뒤 동작.
시작 파일·앱처럼 토큰 주소(#/t/<토큰>)로 연 관리자에게 토큰을 보여 주고(보기·복사) 직접 정한 토큰으로 바꾸게 한다.
안내를 한 번 확인하면 다시 띄우지 않고, 나가기 뒤에는 로그인 화면(이 PC 안내 한 줄)이 남는다. 토큰 없는 접속은 들어오지 못한다.
화면 틀·저장소(localStorage)·클립보드는 브라우저에서만 동작하므로 브라우저로 확인한다(임시 개인 서버, 빈 포트).
   python -I tests/ui_admin_token_notice.py
"""
import atexit, json, os, shutil, socket, subprocess, sys, tempfile, urllib.error, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding='utf-8', errors='replace')
ROOT = Path(__file__).resolve().parent.parent
CHROME = '%USERPROFILE%/AppData/Local/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-win64/chrome-headless-shell.exe'


def free_port():
    sock = socket.socket(); sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]; sock.close()
    return port


def status(url, token=None):
    req = urllib.request.Request(url, headers={'Authorization': f'Bearer {token}'} if token else {})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code


def main():
    tmp = Path(tempfile.mkdtemp(prefix='hwpx_token_ui_'))
    atexit.register(lambda: shutil.rmtree(tmp, ignore_errors=True) if tmp.name.startswith('hwpx_token_ui_') else None)
    env = {k: v for k, v in os.environ.items() if not k.startswith(('HWPX_', 'ELECTRON_'))}
    env.update(HWPX_COWORK_USERDATA=str(tmp))
    proc = subprocess.Popen(['node', str(ROOT / 'deploy/portable/personal.mjs'), '--no-window', '--port', str(free_port())], cwd=str(ROOT), env=env,
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding='utf-8')
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
        cfg_file = tmp / 'config.json'
        token = json.loads(cfg_file.read_text(encoding='utf-8'))['users'][0]['token']
        base = f'http://localhost:{port}'
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=CHROME)
            ctx = browser.new_context(); ctx.grant_permissions(['clipboard-read', 'clipboard-write'], origin=base)
            page = ctx.new_page()
            page.goto(f'{base}/?teaser=0#/t/{token}')
            page.wait_for_selector('[data-testid=admin-token-notice]', timeout=30000)
            ok(True, '토큰 주소로 처음 들어온 관리자에게 토큰 안내가 뜬다')
            value = page.locator('[data-testid=admin-token-value]')
            ok(value.get_attribute('type') == 'password' and value.input_value() == token, '토큰은 가린 채 지금 토큰을 담는다')
            page.click('[data-testid=admin-token-notice] button:has-text("보기")'); ok(value.get_attribute('type') == 'text', '[보기]로 토큰을 보인다')
            page.click('[data-testid=admin-token-copy]')
            page.wait_for_selector('[data-testid=admin-token-status]')
            ok(page.evaluate('navigator.clipboard.readText()') == token, '[복사]가 토큰을 클립보드에 넣는다')
            page.click('[data-testid=admin-token-notice] summary')
            page.fill('[data-testid=admin-token-custom]', 'short1')
            ok(page.is_visible('[data-testid=admin-token-weak]'), '12자보다 짧으면 권고 문구를 보인다')
            mine = 'my-own-admin-token-2026'
            page.fill('[data-testid=admin-token-custom]', mine)
            page.click('[data-testid=admin-token-change]')
            page.wait_for_function("document.querySelector('[data-testid=admin-token-status]')?.textContent.includes('바꿨습니다')", timeout=15000)
            ok(json.loads(cfg_file.read_text(encoding='utf-8'))['users'][0]['token'] == mine, '직접 정한 토큰이 이 PC 설정 파일에 저장된다(다음 시작부터 새 토큰)')
            ok(page.evaluate("localStorage.getItem('hwpx.token')") == mine and value.input_value() == mine, '이 브라우저도 새 토큰으로 이어 간다')
            ok(status(f'{base}/api/me', token) == 401 and status(f'{base}/api/me', mine) == 200, '이전 토큰은 끊기고 새 토큰만 들어온다')
            page.click('[data-testid=admin-token-ok]')
            page.wait_for_selector('[data-testid=admin-token-notice]', state='detached')
            page.goto(f'{base}/?teaser=0#/t/{mine}'); page.reload()
            page.wait_for_selector('.listpage', timeout=30000)
            ok(not page.is_visible('[data-testid=admin-token-notice]'), '확인한 브라우저에는 다시 띄우지 않는다')
            page.click('text=나가기')
            page.wait_for_selector('.login', timeout=10000)
            ok(page.evaluate("localStorage.getItem('hwpx.token')") is None, '나가기는 이 브라우저의 토큰을 지운다')
            ok(page.is_visible('[data-testid=login-local-hint]'), '이 PC 화면의 로그인에는 시작 아이콘 안내가 한 줄 있다')
            page.reload(); page.wait_for_selector('.login', timeout=10000)
            ok(not page.is_visible('.listpage'), '나가기 뒤 새로고침해도 자동으로 들어가지 않는다')
            other = browser.new_context().new_page()   # 토큰 주소 없이 들어온 다른 사람
            other.goto(f'{base}/?teaser=0'); other.wait_for_selector('.login', timeout=10000)
            ok(not other.is_visible('[data-testid=admin-token-notice]') and not other.is_visible('.listpage'), '토큰 없는 접속은 로그인 화면에 머문다(안내도 뜨지 않는다)')
            page.fill('input[aria-label="접속 토큰"]', mine); page.click('.login form button[type=submit]')   # 11-18 로그인 화면 제목 '문서함에 들어가기'와 겹치지 않게 단추로 찾는다
            page.wait_for_selector('.listpage', timeout=15000)
            ok(not page.is_visible('[data-testid=admin-token-notice]'), '토큰을 직접 넣어 들어오면 안내를 띄우지 않는다')
            browser.close()
        print(f'통과 {count}개')
    finally:
        try:
            proc.stdin.write('quit\n'); proc.stdin.flush(); proc.wait(timeout=30)
        except Exception:
            proc.kill()


if __name__ == '__main__':
    main()
