"""개인 토큰 스스로 발급(2026-11-18): 관리자 [기능 설정] 탭에서 켜고 → 로그인 화면 [개인 토큰 발급받기] → 이름 → 토큰 한 번 보기·복사 →
[이 토큰으로 들어가기]로 문서함까지. 끄면 로그인 화면에서 사라진다. 관리자 [사용자] 탭에 '스스로 발급' 표시.
화면 틀(탭·단추·입력)·클립보드·저장소(localStorage)는 브라우저에서만 동작하므로 브라우저로 확인한다(AGENTS.md §2.1 예외 — 임시 개인 서버, 빈 포트).
   python -I tests/ui_self_issue.py
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
    tmp = Path(tempfile.mkdtemp(prefix='hwpx_selfissue_ui_'))
    atexit.register(lambda: shutil.rmtree(tmp, ignore_errors=True) if tmp.name.startswith('hwpx_selfissue_ui_') else None)
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
            # 토큰 안내(admin-token-notice)는 이미 본 것으로 둔다 — 이 시험은 기능 설정만 본다
            admin_ctx = browser.new_context()
            admin_ctx.add_init_script("try { localStorage.setItem('hwpx.adminTokenNotice', '1') } catch (e) {}")
            visitor = browser.new_context(); visitor.grant_permissions(['clipboard-read', 'clipboard-write'], origin=base)

            v = visitor.new_page()
            v.goto(f'{base}/?teaser=0'); v.wait_for_selector('.login', timeout=30000)
            ok(not v.is_visible('[data-testid=login-self-issue]'), '기본(끔): 로그인 화면에 발급 단추가 없다')

            a = admin_ctx.new_page()
            a.goto(f'{base}/?teaser=0#/t/{token}'); a.wait_for_selector('.listpage', timeout=30000)
            a.goto(f'{base}/?teaser=0#/admin/features'); a.reload()
            a.wait_for_selector('[data-testid=admin-features]', timeout=15000)
            ok(a.is_visible('[data-testid=admin-tab-features]') and a.get_attribute('[data-testid=admin-tab-features]', 'aria-selected') == 'true', '관리자 설정에 [기능 설정] 탭이 있고 주소로 바로 열린다')
            ok(not a.is_checked('[data-testid=admin-self-issue]') and a.is_disabled('[data-testid=admin-features-save]'), '처음에는 꺼져 있고 바꾼 것이 없으면 [저장]이 잠긴다')
            a.check('[data-testid=admin-self-issue]')
            a.select_option('[data-testid=admin-self-issue-role]', 'viewer')
            a.fill('[data-testid=admin-self-issue-max]', '0')
            a.click('[data-testid=admin-features-save]')
            ok(a.is_visible('[data-testid=admin-features] .err'), '범위 밖 한도는 저장하지 않고 알린다')
            a.fill('[data-testid=admin-self-issue-max]', '5')
            a.click('[data-testid=admin-features-save]')
            a.wait_for_selector('[data-testid=admin-features-notice]', timeout=10000)
            saved = json.loads(cfg_file.read_text(encoding='utf-8'))['accounts']['selfIssue']
            ok(saved == {'enabled': True, 'role': 'viewer', 'max': 5}, '저장하면 설정 파일에 남는다(켜짐·보기만·5개)')

            v.reload(); v.wait_for_selector('[data-testid=login-self-issue-open]', timeout=10000)
            ok(True, '켜면 재시작 없이 로그인 화면에 [개인 토큰 발급받기]가 보인다')
            v.click('[data-testid=login-self-issue-open]')
            ok(v.is_disabled('[data-testid=login-self-issue-submit]'), '이름이 비면 [발급받기]가 잠긴다')
            v.fill('[data-testid=login-self-issue-name]', '*')
            v.click('[data-testid=login-self-issue-submit]')
            v.wait_for_selector('#login-issue-error', timeout=10000)
            ok('이름' in v.inner_text('#login-issue-error'), '쓸 수 없는 이름은 서버가 거절하고 그 이유를 보인다')
            v.fill('[data-testid=login-self-issue-name]', '새 손님')
            v.click('[data-testid=login-self-issue-submit]')
            v.wait_for_selector('[data-testid=login-issued]', timeout=10000)
            issued = v.inner_text('[data-testid=login-issued-token]').strip()
            ok(len(issued) == 32 and status(f'{base}/api/me', issued) == 200, '발급한 토큰(32자)이 한 번 보이고 그 토큰으로 접속된다')
            v.click('[data-testid=login-issued-copy]')
            ok(v.evaluate('navigator.clipboard.readText()') == issued, '[복사]가 토큰을 클립보드에 넣는다')
            v.click('[data-testid=login-issued-enter]')
            v.wait_for_selector('.listpage', timeout=15000)
            ok(v.evaluate("localStorage.getItem('hwpx.token')") == issued, '[이 토큰으로 들어가기]로 문서함에 들어가고 이 브라우저가 토큰을 기억한다')

            a.click('[data-testid=admin-tab-users]')
            a.wait_for_selector('[data-user="새 손님"] [data-testid=admin-user-self-issued]', timeout=10000)
            ok(a.inner_text('[data-user="새 손님"] select option:checked').strip() == '보기만', '[사용자] 탭에 스스로 발급 표시와 관리자가 정한 역할(보기만)이 보인다')

            a.click('[data-testid=admin-tab-features]')
            a.wait_for_selector('[data-testid=admin-self-issue-count]', timeout=10000)
            ok('발급 1개' in a.inner_text('[data-testid=admin-self-issue-count]'), '기능 설정에 지금까지 발급한 수가 보인다')
            a.uncheck('[data-testid=admin-self-issue]'); a.click('[data-testid=admin-features-save]')
            a.wait_for_function("document.querySelector('[data-testid=admin-features-notice]')?.textContent.includes('받지 않습니다')", timeout=10000)
            other = browser.new_context().new_page()
            other.goto(f'{base}/?teaser=0'); other.wait_for_selector('.login', timeout=30000)
            ok(not other.is_visible('[data-testid=login-self-issue]'), '끄면 로그인 화면에서 사라진다')
            ok(status(f'{base}/api/me', issued) == 200, '끈 뒤에도 이미 받은 토큰은 그대로 쓴다')
            browser.close()
        print(f'통과 {count}개')
    finally:
        try:
            proc.stdin.write('quit\n'); proc.stdin.flush(); proc.wait(timeout=30)
        except Exception:
            proc.kill()


if __name__ == '__main__':
    main()
