"""관리자 서버 설정 화면: 격리 서버의 권한·저장, 재시작 UI·문서 보존을 확인한다."""
import atexit, copy, json, os, secrets, shutil, socket, subprocess, sys, tempfile, time, urllib.error, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding='utf-8', errors='replace')
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'tests' / 'out'
CHROME = '%USERPROFILE%/AppData/Local/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-win64/chrome-headless-shell.exe'


def main():
    OUT.mkdir(exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix='hwpx_admin_ui_'))

    def cleanup():
        assert tmp.resolve().parent == Path(tempfile.gettempdir()).resolve() and tmp.name.startswith('hwpx_admin_ui_')
        shutil.rmtree(tmp, ignore_errors=True)

    atexit.register(cleanup)
    admin_token, editor_token = secrets.token_hex(20), secrets.token_hex(20)
    sock = socket.socket(); sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]; sock.close()
    base = f'http://127.0.0.1:{port}'
    cfg = {'host':'127.0.0.1', 'port':port, 'dataDir':'./data', 'tutorial': {'enabled': False}, 'retainedTestSetting':{'keep':True},
           'users':[{'name':'관리시험','role':'admin','token':admin_token}, {'name':'편집시험','role':'editor','token':editor_token}],
           'ai':{'enabled':False,'keyFile':str(tmp/'no-key')}}
    config = tmp/'config.json'; config.write_text(json.dumps(cfg), encoding='utf-8')
    env = {k:v for k,v in os.environ.items() if not k.upper().startswith('HWPX_COWORK_')}
    env.update(HWPX_COWORK_CONFIG=str(config), HWPX_COWORK_DATA_DIR=str(tmp/'data'), HWPX_COWORK_AI='off')
    count = 0; errors = []

    def ok(value, message):
        nonlocal count
        assert value, message
        count += 1; print('  ✓ '+message, flush=True)

    def request(path, token=admin_token, method='GET', body=None):
        req = urllib.request.Request(base+path, data=json.dumps(body).encode() if body is not None else None,
                                     headers={'Authorization':'Bearer '+token, 'Content-Type':'application/json'}, method=method)
        try:
            with urllib.request.urlopen(req, timeout=5) as response: return response.status, json.load(response)
        except urllib.error.HTTPError as e: return e.code, json.load(e)

    with (OUT/'admin_ui_server.log').open('w', encoding='utf-8') as log:
        srv = subprocess.Popen(['node','server/index.js'], cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT)
        try:
            for _ in range(150):
                if srv.poll() is not None: raise RuntimeError('격리 시험 서버 시작 실패')
                try:
                    urllib.request.urlopen(base+'/api/config', timeout=1).close(); break
                except Exception: time.sleep(.1)
            else: raise RuntimeError('서버 준비 시간 초과')
            for path, method, body in [('/api/admin/server','GET',None),('/api/admin/server','PATCH',{'settings':{'port':8787}}),('/api/admin/restart','POST',{})]:
                status, _ = request(path, editor_token, method, body)
                ok(status == 403, f'편집자가 위조한 {method} {path} 요청은 403')
            _, original = request('/api/admin/server')
            status, _ = request('/api/admin/server', method='PATCH', body={'settings':{'host':'127.0.0.1','port':0,'publicUrl':''}, 'revision':original['revision']})
            ok(status == 400 and json.loads(config.read_text(encoding='utf-8')) == cfg, '잘못된 포트는 실제 API에서 거부하고 설정 파일 보존')
            upload = urllib.request.Request(base+'/api/docs', data=(ROOT/'tests/fixtures/tool_memo_tracked.hwpx').read_bytes(), headers={'Authorization':'Bearer '+admin_token,'Content-Type':'application/octet-stream','X-File-Name':'admin-test.hwpx'}, method='POST')
            with urllib.request.urlopen(upload) as response: doc = json.load(response)

            with sync_playwright() as p:
                br = p.chromium.launch(executable_path=CHROME)
                admin = br.new_context(viewport={'width':1280,'height':900})
                editor = br.new_context(viewport={'width':1280,'height':900})
                page = admin.new_page(); page.on('pageerror', lambda e: errors.append(str(e)))
                other = editor.new_page(); other.on('pageerror', lambda e: errors.append(str(e)))

                def login(target, token):
                    target.goto(base); target.locator('input[aria-label="접속 토큰"]').fill(token)
                    target.get_by_role('button', name='들어가기', exact=True).click()
                    target.locator('[data-testid="help-list"]').wait_for()

                login(other, editor_token)
                ok(other.locator('[data-testid="admin-list"]').count() == 0, '편집자 문서 목록에는 관리자 탭 없음')
                other.goto(base+'/#/admin'); other.locator('[data-testid="admin-denied"]').wait_for()
                ok(other.locator('[data-testid="admin-server"]').count() == 0, '편집자의 직접 관리자 주소 진입은 권한 안내')
                login(page, admin_token)
                page.locator('[data-testid="admin-list"]').click()
                panel = page.locator('[data-testid="admin-server"]'); panel.wait_for()
                page.locator('[data-testid="admin-port"]').wait_for()
                ok(page.url.endswith('#/admin'), '관리자는 목록의 관리자 탭으로 설정 화면 진입')
                ok(not page.locator('[data-testid="admin-restart"]').is_enabled(), '직접 실행한 서버는 재시작 지원 여부를 표시')
                page.locator('[data-testid="admin-port"]').fill('70000')
                page.locator('[data-testid="admin-save"]').click()
                ok(panel.get_by_text('포트는 1–65535 사이의 정수로 입력하세요.', exact=True).count() == 1, '잘못된 포트는 저장 전에 항목 옆에 안내')
                page.locator('[data-testid="admin-port"]').fill(str(port))
                page.locator('[data-testid="admin-public-url"]').fill('https://example.org/?token=private')
                page.locator('[data-testid="admin-save"]').click()
                ok(panel.get_by_text('인증정보·토큰·쿼리 없는 HTTP 또는 HTTPS 서버 주소를 입력하세요.', exact=True).count() == 1, '외부 공유 주소에 토큰·쿼리 입력 거부')
                page.locator('[data-testid="admin-public-url"]').fill('https://cowork.example.org')
                page.locator('[data-testid="admin-save"]').click()
                page.locator('[data-testid="admin-notice"]').wait_for()
                saved = json.loads(config.read_text(encoding='utf-8'))
                ok(saved['publicUrl'] == 'https://cowork.example.org' and saved['users'] == cfg['users'] and saved['retainedTestSetting'] == cfg['retainedTestSetting'], '실제 설정 저장은 사용자·기존 설정을 보존')
                ok('재시작 대기' in page.locator('[data-testid="admin-current"]').inner_text(), '저장된 설정과 실행 중인 설정을 구분')
                ok(admin_token not in panel.inner_text() and str(tmp) not in panel.inner_text(), '관리자 화면은 사용자 토큰·설정 파일 경로를 표시하지 않음')

                # 재시작 API는 모의 처리하고 같은 origin의 과거 nonce를 완료로 오인하지 않는지 검증한다.
                _, mock = request('/api/admin/server')
                mock['restart'] = {'supported':True, 'busy':False}
                mock['saved']['publicUrl'] = f'http://localhost:{port}'
                mock['running']['publicUrl'] = base
                mock['saved']['port'] = port
                mock['restartRequired'] = False
                restart_posts = []; poll_count = [0]; fail_restart = [False]; restart_epoch = [0]; restore_previous = [False]; fail_save = [False]; simulate_poll = [False]
                nonce = mock['running']['instanceId']
                with urllib.request.urlopen(base+'/api/config') as response: public_config = json.load(response)

                def mock_server(route):
                    nonlocal mock
                    if route.request.method == 'PATCH':
                        if fail_save[0]: route.fulfill(status=409, json={'error':'CONFIG_CHANGED','message':'설정 충돌'}); return
                        mock['saved'] = route.request.post_data_json['settings']; mock['revision'] += '-saved'; mock['restartRequired'] = True
                    route.fulfill(status=200, json=mock)

                def mock_restart(route):
                    restart_posts.append(route.request.post_data_json)
                    if fail_restart[0]: route.fulfill(status=503, json={'error':'RESTART_FAILED','message':'재시작 시험 오류'}); return
                    restart_epoch[0] += 1; poll_count[0] = 0; simulate_poll[0] = True
                    mock['restart']['busy'] = True
                    route.fulfill(status=202, json={**mock,'accepted':True,'restartId':'test-restart'})

                def mock_config(route):
                    if not simulate_poll[0]: route.fulfill(status=200, json={**public_config, 'nonce':mock['running']['instanceId']}); return
                    poll_count[0] += 1
                    if poll_count[0] >= 3:
                        mock['restart']['busy'] = False; mock['running'] = {**mock['saved'], 'instanceId':nonce+f'-new-{restart_epoch[0]}'}; mock['restartRequired'] = restore_previous[0]
                        if restore_previous[0]: mock['running']['port'] = port
                        simulate_poll[0] = False
                    previous_nonce = nonce if restart_epoch[0] <= 1 else nonce+f'-new-{restart_epoch[0]-1}'
                    route.fulfill(status=200, json={**public_config, 'nonce':previous_nonce if poll_count[0] < 3 else nonce+f'-new-{restart_epoch[0]}'})

                page.route('**/api/admin/server', mock_server); page.route('**/api/admin/restart', mock_restart); page.route('**/api/config', mock_config)
                page.reload(); page.locator('[data-testid="admin-port"]').wait_for()
                page.locator('[data-testid="admin-access"]').select_option('lan')
                page.locator('[data-testid="admin-port"]').fill(str(port+1))
                page.locator('[data-testid="admin-save-restart"]').click()
                ok(not restart_posts and page.locator('[data-testid="admin-restart-review"]').is_visible(), '저장·재시작은 주소 변경 미리보기와 인라인 확인을 거침')
                page.locator('[data-testid="admin-restart-confirm"]').click()
                page.wait_for_timeout(1500)
                ok(len(restart_posts) == 1 and '다시 시작되었습니다' not in panel.inner_text(), '기존 프로세스의 응답을 재시작 완료로 표시하지 않음')
                page.get_by_text('서버가 다시 시작되었습니다. 새 설정이 적용되었습니다.', exact=True).wait_for(timeout=12000)
                new_link = page.locator('[data-testid="admin-new-address"]').get_attribute('href')
                ok(new_link == f'http://127.0.0.1:{port+1}' and admin_token not in new_link, '기존 localhost 공유 주소가 있어도 새 포트 링크는 현재 호스트로 안내하고 토큰을 전달하지 않음')
                page.locator('[data-testid="admin-port"]').fill(str(port+2)); fail_restart[0] = True
                page.locator('[data-testid="admin-save-restart"]').click(); page.locator('[data-testid="admin-restart-confirm"]').click()
                page.get_by_text('설정은 저장했지만 재시작을 시작하지 못했습니다: 재시작 시험 오류', exact=True).wait_for()
                ok(page.locator('[data-testid="admin-port"]').input_value() == str(port+2) and mock['saved']['port'] == port+2, '저장 성공·재시작 실패 시 저장 상태와 입력 유지')
                fail_restart[0] = False; restore_previous[0] = True
                page.locator('[data-testid="admin-restart-confirm"]').click()
                page.get_by_text('서버가 다시 시작되었지만 요청한 설정과 실행 상태가 다릅니다. 이전 설정으로 복구되었을 수 있습니다. 위 실행 중 주소와 저장한 설정을 확인하세요.', exact=True).wait_for(timeout=12000)
                ok('새 설정이 적용되었습니다' not in page.locator('[data-testid="admin-notice"]').inner_text(), '새 nonce라도 이전 설정으로 복구되면 적용 완료로 표시하지 않음')
                fail_save[0] = True
                page.locator('[data-testid="admin-port"]').fill(str(port+3)); page.locator('[data-testid="admin-save"]').click()
                page.get_by_text('다른 관리자가 설정을 바꿨습니다. 상태 새로고침으로 확인한 뒤 다시 저장하세요. 입력한 값은 유지했습니다.', exact=True).wait_for()
                ok(page.locator('[data-testid="admin-port"]').input_value() == str(port+3), '설정 충돌 오류에도 입력 유지')
                fail_save[0] = False
                page.screenshot(path=str(OUT/'admin_server_settings.png'))
                page.set_viewport_size({'width':390,'height':844})
                ok(panel.bounding_box()['width'] <= 390 and page.evaluate('document.documentElement.scrollWidth <= innerWidth'), '좁은 화면에서도 서버 설정이 가로 넘침 없이 표시')

                page.set_viewport_size({'width':1280,'height':900})
                mock['overrides'] = {'port':{'locked':True,'source':'HWPX_COWORK_PORT'}}
                mock['restart']['busy'] = True
                page.reload(); page.locator('[data-testid="admin-port"]').wait_for()
                ok(page.locator('[data-testid="admin-port"]').is_disabled() and not page.locator('[data-testid="admin-restart"]').is_enabled(), '환경 변수 고정 항목·진행 중인 재시작은 변경을 막고 이유 표시')
                mock['overrides'] = {}; mock['restart']['busy'] = False
                page.goto(base+'/#/doc/'+doc['id'])
                page.wait_for_function('window.__doc?.editor?.ready', timeout=120000)
                page.evaluate('''() => {
                    const d = window.__doc; window.__adminEditor = d.editor.frame();
                    d.openComposer({ref:'s0/p0',refs:['s0/p0'],start:0,end:0,text:'',display:'시험 문단'},'instruct');
                }''')
                composer = page.locator('.composer textarea').first; composer.fill('관리자 설정을 보는 동안 유지할 요청')
                document_url = page.url
                page.locator('[data-testid="admin-doc"]').click(); panel.wait_for(state='visible')
                page.locator('[data-testid="admin-port"]').wait_for()
                page.evaluate('''() => { const d = window.__doc; window.__adminOriginalSave = d.saveDraftNow; d.saveDraftNow = async()=>{ throw Error('시험 저장 실패'); }; d.s.draft.dirty = true; }''')
                posts_before = len(restart_posts)
                page.locator('[data-testid="admin-restart"]').click(); page.locator('[data-testid="admin-restart-confirm"]').click()
                page.get_by_text('문서에 아직 저장하지 못한 글이 있습니다. 관리자 창을 닫고 문서의 저장 상태를 확인한 뒤 다시 시도하세요.', exact=True).wait_for()
                ok(len(restart_posts) == posts_before, '문서에 저장하지 못한 글이 있으면 재시작 요청 차단')
                page.evaluate('''() => { window.__doc.saveDraftNow = window.__adminOriginalSave; window.__doc.s.draft.dirty = false; }''')
                page.locator('[data-testid="admin-close"]').click(); panel.wait_for(state='hidden')
                ok(page.url == document_url and page.evaluate('window.__adminEditor === window.__doc.editor.frame()'), '문서 관리자 창을 열고 닫아도 같은 편집기 유지')
                ok(composer.input_value() == '관리자 설정을 보는 동안 유지할 요청', '관리자 창을 닫은 뒤 작성 중인 요청 내용 보존')
                other.goto(base+'/#/doc/'+doc['id']); other.locator('[data-testid="help-doc"]').wait_for()
                ok(other.locator('[data-testid="admin-doc"]').count() == 0, '편집자의 문서 화면에도 관리자 탭 없음')
                ok(not errors, '관리자·편집자 화면 JavaScript 오류 없음')
                br.close()
            print(f'결과: {count}/{count} 통과', flush=True)
        finally:
            srv.terminate()
            try: srv.wait(timeout=10)
            except subprocess.TimeoutExpired: srv.kill(); srv.wait(timeout=5)
    cleanup()


if __name__ == '__main__': main()
