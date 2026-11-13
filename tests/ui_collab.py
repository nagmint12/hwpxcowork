# 협업 화면 시험(docs/V3_SPEC.md §5.1 레일·탭 · §5.3 변경 요청 · §3.6 메모 스레드 · §2.2 AI 경로):
#   python -I tests/ui_collab.py   → 스크린숏 tests/out/collab_*.png, 서버 기록 tests/out/collab_server.log
# 서버: 포트 8792(UI_COLLAB_PORT), 임시 data 폴더 + 임시 config(관리자·홍길동(a)·김검토(b), 토큰은 매번 새로) + 모의 AI.
#       진짜 config.json·data/ 는 읽지도 쓰지도 않는다. 편집기 빌드(studio/dist, cowork 플러그인)가 있어야 한다.
# 준비는 진짜 서버 API 로: 시험 문서·a 의 수정본은 tests/helpers/make_draft.mjs(엔진으로 고친 HWPX → PUT /drafts/mine) —
#   편집기 껍데기의 자동 저장에 기대지 않는다.
# 흐름: b 가 문서를 열면 레일에 a 의 '✎ 수정 중' 카드(hover = 편집기 강조, 누름 = 깜빡임) → 변경 요청 탭에 a 의 초안 →
#       a 가 [검토 요청](창: 제목 기본값) → b 가 레일 카드·상세에서 덩어리에 의견 + 승인 → a 가 반영 → 변경 추적 탭에 교체 묶음(같이 수락·거절) →
#       메모(API) 답글·해결(레일 카드) → 검토 탭 '해결됨'·↑↓ →
#       작성자가 더 고쳐 저장해(hid 바뀜)도 의견 칸·쓰던 글·고름·스레드 유지(덩어리 열쇠, 옛 hid NO_HUNK 다시 시도) →
#       긴 문서에서 답글을 쓰다가 스크롤해도 카드·글 유지(레일 끝에 붙임) · Ctrl+Enter 두 번 = 한 번 →
#       AI 작업 탭(연결 없음: 종류 칩 요청·다듬기 · 보낼 곳 · '?'·상단 AI 알약 → 설명서 #ai · 프롬프트 복사 · 상태 칩 하나) →
#       가짜 에이전트 SSE(a, ?channel=1, 머리글 토큰) → ● · [보내기](title 'PyAgent에 보냅니다') → 보낸 요청이 SSE 로 감 → 끊으면 ○ →
#       좁은 창의 검토 요청 창(탭·창 폭을 바꿔도 창·글 유지) → 편집기는 하나: 옛 주소(?legacy=1)도 같은 편집기 화면, 옛 검토 보기(review.js) 없음
#       ('기준에 바로 적용'은 관리자 또는 /api/config allowDirectApply 일 때만) → 문서 목록(역할 한국어 · 창으로 돌아오면 다시 읽음)
# 다듬기 확인: 초안에는 [승인] 막힘('검토 요청 후 승인할 수 있습니다') · 판단 이름 '수정 요청' · 제목 기본값 = 바뀐 낱말('「4월부터」 수정 외 1곳') ·
#       반영 막힘 설명은 한 번만 · 작성자에게 의견·수정 요청·승인 알림과 상단 칩 수 · 작성자는 의견만 · 반영된 변경 요청의 [편집기에서 보기]
# v0.3.1(docs/V3_SPEC.md §9.7): 상단 사람용 버전 v1 → 변경 요청 반영 뒤 v2(알림 '(v2)', 'v2로 반영됨') · [5b] 이력 탭 'v2 이후 변경 이력 n개' →
#       [버전 저장](한 줄 메모) → v3(남에게 알림 · 지금 · 내려받기 '제목_v3.hwpx' · 기록 번호 없음) · 문서 목록 v ·
#       [12] AI 작업 요청 단위: 진행 줄 '제안 4건 — 남음 4'(AI 작업 탭·레일) · 남의 요청은 진행 줄과 [하나씩 보기]만 · 제안 카드 'AI 작업 #n' ·
#       하나 거절 → [모두 반영 (3)] = 남은 것만 편집기에 한 번에(resolve 한 번) → 완료(레일 카드 사라짐 · 검토 탭 완료: 칩 '완료' · '반영 3 · 거절 1') ·
#       [남은 n건 거절] → 그 자리 확인 줄([취소]면 그대로) → AI 작업 탭 카드 칩 '완료' · '거절 2'. 개발용: UI_COLLAB_ONLY=jobs 면 [12]만
import datetime, http.client, json, os, re, secrets, shutil, socket, subprocess, sys, tempfile, threading, time, traceback, urllib.parse, urllib.request
from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding='utf-8', errors='replace')
ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')).replace('\\', '/')
OUT = f'{ROOT}/tests/out'
os.makedirs(OUT, exist_ok=True)
PORT = int(os.environ.get('UI_COLLAB_PORT', '8792'))
BASE = f'http://localhost:{PORT}'          # 브라우저 주소(CLAUDE.md)
REST = f'http://127.0.0.1:{PORT}'          # 시험 코드의 REST
CHROME = '%USERPROFILE%/AppData/Local/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-win64/chrome-headless-shell.exe'
USERS = [
    {'name': '관리자', 'role': 'admin', 'token': secrets.token_hex(16)},
    {'name': '홍길동', 'role': 'editor', 'token': secrets.token_hex(16)},
    {'name': '김검토', 'role': 'editor', 'token': secrets.token_hex(16)},
]
ADMIN, A, B = USERS
RESULTS = []
DIALOGS = []
ERRORS = []


class OnlyJobs(Exception):
    """UI_COLLAB_ONLY=jobs 로 [12]만 돈 뒤 나머지를 건너뛴다(개발용)"""


def ok(cond, msg):
    RESULTS.append((bool(cond), msg))
    print(('  ✓ ' if cond else '  ✗ ') + msg, flush=True)
    if not cond:
        raise AssertionError(msg)


def rest(path, method='GET', body=None, headers=None, raw=False, token=None):
    h = {'Authorization': f'Bearer {token or A["token"]}'}
    h.update(headers or {})
    data = None
    if body is not None:
        if raw:
            data = body
        else:
            data = json.dumps(body).encode('utf-8'); h['Content-Type'] = 'application/json'
    req = urllib.request.Request(REST + path, data=data, headers=h, method=method)
    with urllib.request.urlopen(req, timeout=60) as r:
        b = r.read()
        return json.loads(b) if 'json' in (r.headers.get('content-type') or '') else b


def wait_until(fn, timeout=20, step=0.15, msg='조건'):
    t0 = time.time(); last = None
    while time.time() - t0 < timeout:
        try:
            last = fn()
            if last:
                return last
        except Exception as e:  # noqa: BLE001
            last = e
        time.sleep(step)
    raise AssertionError(f'시간 초과: {msg} ({last})')


def shot(pg, name):
    pg.screenshot(path=f'{OUT}/collab_{name}.png')
    print(f'    → tests/out/collab_{name}.png', flush=True)


def shot31(pg, name):
    """v0.3.1 새 화면(§9.7) 스크린숏 — tests/out/v031_collab_<name>.png"""
    pg.screenshot(path=f'{OUT}/v031_collab_{name}.png')
    print(f'    → tests/out/v031_collab_{name}.png', flush=True)


def port_busy(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.3)
        return s.connect_ex(('127.0.0.1', port)) == 0


def node_helper(args, token=None):
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith('HWPX_')}
    if token:
        env['HWPX_TEST_TOKEN'] = token
    r = subprocess.run(['node', 'tests/helpers/make_draft.mjs', *args], cwd=ROOT, env=env, capture_output=True, text=True, encoding='utf-8')
    if r.returncode != 0:
        raise RuntimeError(f'make_draft.mjs {args[0]} 실패: {r.stderr.strip()}')
    return json.loads(r.stdout.strip().splitlines()[-1])


def start_server(tmp):
    """임시 data·config 로 서버를 띄우고, 우리 토큰이 통하는(= 우리가 띄운) 서버인지 확인한다"""
    if port_busy(PORT):
        raise RuntimeError(f'포트 {PORT} 를 이미 다른 프로세스가 쓰고 있습니다(남은 시험 서버를 끄고 다시 실행하세요)')
    data = os.path.join(tmp, 'data'); os.makedirs(data, exist_ok=True)
    cfg = {
        'host': '127.0.0.1', 'port': PORT, 'dataDir': './data', 'tutorial': {'enabled': False}, 'allowAgentApply': True, 'users': USERS,
        # 키 파일은 없는 경로: 어떤 경우에도 실제 API 를 부르지 않는다(모의 AI 만)
        'ai': {'enabled': False, 'mock': False, 'keyFile': os.path.join(tmp, 'no-such-key.txt'), 'model': 'claude-opus-5-5', 'effort': 'medium', 'maxProposals': 10},
        'studio': {'mode': 'local'}, 'agents': {'leaseMinutes': 15, 'othersCanTake': False}, 'changeRequests': {'requireApprovals': 1},
        # v0.4: 지금까지의 시험(승인 방식 흐름)은 그대로 — 새 문서는 승인 방식·작업 기록 메모 자세히(v0.3.1 꼴). v0.4 절은 문서 설정을 바꿔 쓴다
        'documents': {'defaultEditMode': 'review', 'defaultAiMemo': 'detail'},
    }
    cfg_path = os.path.join(tmp, 'config.json')
    with open(cfg_path, 'w', encoding='utf-8', newline='') as f:
        json.dump(cfg, f, ensure_ascii=False, indent=1)
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith('HWPX_COWORK_')}
    env.update(HWPX_COWORK_CONFIG=cfg_path, HWPX_COWORK_DATA_DIR=data, HWPX_COWORK_AI_MOCK='1', HWPX_COWORK_PORT=str(PORT), HWPX_COWORK_HOST='127.0.0.1')
    log = open(f'{OUT}/collab_server.log', 'w', encoding='utf-8', newline='')
    srv = subprocess.Popen(['node', 'server/index.js'], cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT)
    conf = None
    for _ in range(160):
        if srv.poll() is not None:
            raise RuntimeError(f'서버가 시작하다 끝났습니다(code {srv.returncode}) — tests/out/collab_server.log')
        try:
            conf = json.loads(urllib.request.urlopen(REST + '/api/config', timeout=2).read())
            if conf.get('nonce'):
                break
        except Exception:  # noqa: BLE001
            time.sleep(0.25)
    if not conf or not conf.get('nonce'):
        raise RuntimeError('서버가 뜨지 않았습니다')
    me = rest('/api/me')
    if me.get('name') != A['name']:
        raise RuntimeError(f'포트 {PORT} 의 서버가 이 시험의 서버가 아닙니다: {me}')
    return srv, log, conf


class Sse:
    """가짜 개인 에이전트: GET /api/agent/events(채널 세션, 토큰은 머리글만) 를 붙잡고 이벤트를 모은다"""
    def __init__(self, token, agent='PyAgent', session=None):
        self.session = session or ('py' + secrets.token_hex(6))
        q = urllib.parse.urlencode({'channel': '1', 'agent': agent, 'session': self.session, 'client': 'ui_collab'})
        self.conn = http.client.HTTPConnection('127.0.0.1', PORT, timeout=120)
        self.conn.request('GET', f'/api/agent/events?{q}', headers={'Authorization': f'Bearer {token}', 'Accept': 'text/event-stream'})
        self.sock = self.conn.sock
        self.resp = self.conn.getresponse()
        self.status = self.resp.status
        self.events = []
        self.closed = False
        self.t = threading.Thread(target=self._run, daemon=True)
        self.t.start()

    def _run(self):
        ev = None; data = []
        try:
            while True:
                line = self.resp.readline()
                if not line:
                    break
                line = line.decode('utf-8').rstrip('\r\n')
                if line == '':
                    if ev:
                        try:
                            self.events.append((ev, json.loads('\n'.join(data)) if data else None))
                        except Exception:  # noqa: BLE001
                            self.events.append((ev, '\n'.join(data)))
                    ev = None; data = []
                elif line.startswith('event:'):
                    ev = line[6:].strip()
                elif line.startswith('data:'):
                    data.append(line[5:].strip())
        except Exception:  # noqa: BLE001
            pass
        self.closed = True

    def names(self):
        return [e for e, _ in self.events]

    def close(self):
        for fn in (lambda: self.sock.shutdown(socket.SHUT_RDWR), self.sock.close, self.resp.close, self.conn.close):
            try:
                fn()
            except Exception:  # noqa: BLE001
                pass


def mcp(token, name, args, agent='PyAgent', session=None):
    """HTTP MCP 도구 한 번(브리지가 하는 것처럼 X-Hwpx-Agent-Session 머리글로 세션을 알린다)"""
    body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call', 'params': {'name': name, 'arguments': args}}).encode('utf-8')
    h = {'Authorization': f'Bearer {token}', 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream'}
    if session:
        h['X-Hwpx-Agent-Session'] = session
    req = urllib.request.Request(f'{REST}/mcp?agent={urllib.parse.quote(agent)}', data=body, method='POST', headers=h)
    raw = urllib.request.urlopen(req, timeout=30).read().decode('utf-8')
    line = next((l for l in raw.splitlines() if l.startswith('data:')), None)
    out = json.loads(line[5:] if line else raw)
    if 'error' in out or out.get('result', {}).get('isError'):
        raise RuntimeError(f'MCP {name} 실패: {json.dumps(out, ensure_ascii=False)[:300]}')
    return out


def ai_job(did, token, ref, text, changes, insert=None, agent='PyAgent'):
    """AI 작업 하나(대기열 — REST) → 가짜 에이전트(MCP, 요청자 토큰)가 그 요청(request_id)으로 제안 여러 건(바꿈 + 문단 추가)을 남기고 완료.
    → (rid, [pid…] pid 순). 요청에 딸린 제안은 제안 메모 없이 그 요청의 작업 기록 메모 하나에 모인다(§9.3)"""
    r = rest(f'/api/docs/{did}/requests', 'POST', {'kind': 'instruct', 'instruction': '여러 곳 끝맺음 다듬기(시험)', 'route': 'queue',
                                                   'target': {'ref': ref, 'start': 0, 'end': len(text), 'text': text}}, token=token)
    rid = r['request']['rid']
    mcp(token, 'start_request', {'doc_id': did, 'request_id': rid}, agent=agent)
    mcp(token, 'propose_changes', {'doc_id': did, 'request_id': rid, 'proposals': changes}, agent=agent)
    if insert:
        mcp(token, 'propose_insert', {'doc_id': did, 'request_id': rid, 'after_ref': insert['after'], 'text': insert['text'], 'reason': '보완(시험)'}, agent=agent)
    mcp(token, 'complete_request', {'doc_id': did, 'request_id': rid, 'summary': '끝맺음 여러 곳을 다듬도록 제안함(시험)'}, agent=agent)
    return rid, sorted(p['pid'] for p in rest(f'/api/docs/{did}/proposals', token=token) if p.get('rid') == rid)


def v031_jobs(pa, pb, tmp):
    """[12] v0.3.1(docs/V3_SPEC.md §9.7) AI 작업을 요청 단위로: 진행 줄(AI 작업 탭·레일) · 남(b)의 요청이면 진행 줄과 [하나씩 보기]만 ·
    하나 거절 → [모두 반영 (3)] = 남은 것만 편집기에 한 번에(resolve adopt 한 번) → 해결(레일 카드·제안 카드 사라짐, 검토 탭 '해결됨') ·
    [남은 n건 거절] → 그 자리 확인 줄 → 거절(resolve reject 한 번) → 칩 '완료' · '거절 2'"""
    print('[12] v0.3.1 AI 작업 요청 단위: 진행 줄 · 남은 진행 줄만 · 하나 거절 → [모두 반영](남은 것만) → 해결 · [남은 n건 거절] 확인 줄', flush=True)
    built = node_helper(['build', '--out', os.path.join(tmp, 'jobs_doc.hwpx')])
    P = {p['ref']: p['text'] for p in built['paragraphs']}
    with open(built['out'], 'rb') as f:
        dj = rest('/api/docs', 'POST', f.read(), {'x-file-name': urllib.parse.quote('요청단위.hwpx'), 'Content-Type': 'application/octet-stream'}, raw=True, token=ADMIN['token'])['id']
    rid1, pids1 = ai_job(dj, A['token'], 's0/p3', P['s0/p3'], [
        {'ref': 's0/p3', 'find': '적습니다', 'replace': '적음', 'reason': '끝맺음(시험)'},
        {'ref': 's0/p4', 'find': '12월까지입니다', 'replace': '12월까지임', 'reason': '끝맺음(시험)'},
        {'ref': 's0/p5', 'find': '1억 원입니다', 'replace': '1억 원임', 'reason': '끝맺음(시험)'},
    ], insert={'after': 's0/p6', 'text': '보완 문단을 덧붙입니다(시험).'})
    props1 = {p['pid']: p for p in rest(f'/api/docs/{dj}/proposals') if p.get('rid') == rid1}
    ok(len(pids1) == 4 and all(p.get('memo') is False and not p.get('memoId') for p in props1.values()), f'AI 작업 #{rid1}: 제안 4건(바꿈 3 · 문단 추가 1) — 제안 메모 없음(요청마다 메모 하나)')
    rq1 = rest(f'/api/docs/{dj}/requests/{rid1}')
    ok(rq1['status'] == 'done' and rq1['outcome']['open'] == 4 and rq1['outcome']['resolved'] is False and rq1.get('memoId'), f"서버 outcome 남음 {rq1['outcome']['open']} · 해결 아님 · 작업 기록 메모 {rq1.get('memoId')}")
    mid1 = rq1['memoId']
    pid_of = {p['ref'] if (p.get('type') or 'replace') == 'replace' else 'insert': p['pid'] for p in props1.values()}

    open_doc(pa, dj)
    tab(pa, 'ai')
    card1 = pa.locator(f'.tab-ai .card.req[data-rid="{rid1}"]')
    wait_until(lambda: card1.count() == 1 and card1.locator('.ra-line').count() == 1, msg='AI 작업 탭 카드 진행 줄')
    ok(card1.locator('.ra-line').inner_text().strip() == '제안 4건 — 남음 4', f"AI 작업 탭 카드 진행 줄 「{card1.locator('.ra-line').inner_text().strip()}」")
    ok(card1.locator('.ra-adopt').inner_text().strip() == '모두 반영 (4)' and card1.locator('.ra-reject').inner_text().strip() == '남은 4건 거절', '요청자에게 [모두 반영 (4)] · [남은 4건 거절]')
    ok(card1.locator('.ra-apply').count() == 0, '편집자(allowDirectApply 꺼짐)에게는 [문서에 바로 적용 (n)] 없음')
    rc1 = pa.locator(f'.review-rail .rcard.k-request[data-id="{mid1}"]')
    wait_until(lambda: rc1.count() == 1 and '제안 4건 — 남음 4' in text_of(rc1), timeout=20, msg='레일 AI 작업 카드 진행 줄')
    ok(rc1.locator('.ra-adopt').count() == 1 and rc1.locator('.ra-one').count() == 1 and rc1.locator('.rc-reply').count() == 1 and rc1.locator('.rc-resolve').count() == 0,
       '레일 AI 작업 카드: 진행 줄 · [모두 반영] · [하나씩 보기] · [답글] — 메모 스레드 [해결] 단추 없음')
    shot31(pa, 'job_card')
    # 남(b)의 요청: 진행 줄과 [하나씩 보기]만
    open_doc(pb, dj)
    rcb = pb.locator(f'.review-rail .rcard.k-request[data-id="{mid1}"]')
    wait_until(lambda: rcb.count() == 1 and '제안 4건 — 남음 4' in text_of(rcb), timeout=20, msg='b 레일 AI 작업 카드')
    ok(rcb.locator('.ra-adopt').count() == 0 and rcb.locator('.ra-reject').count() == 0 and rcb.locator('.ra-one').count() == 1, '남(b)의 요청: 진행 줄과 [하나씩 보기]만(일괄 단추 없음)')
    rcb.locator('.ra-one').click()
    wait_until(lambda: doc_state(pb, 's.tab') == 'ai' and doc_state(pb, 's.activeRid') == rid1, msg='[하나씩 보기] → AI 작업 탭 결과')
    ok(pb.locator('.tab-ai .result-card .rs-open .prop').count() + pb.locator('.tab-ai .result-card .rs-open .alt').count() == 4, "[하나씩 보기] → 결과 창 '남은 제안 4건'")
    shot31(pb, 'job_other_view')

    # 하나 거절(레일 제안 카드 — 머리에 'AI 작업 #n' 꼬리표) → 진행 줄 거절 1 · 남음 3
    pc4 = pa.locator(f'.review-rail .rc-opt[data-pid="{pid_of["s0/p4"]}"]')
    wait_until(lambda: pc4.count() == 1, timeout=15, msg='레일 제안 카드(s0/p4)')
    pcard4 = pa.locator('.review-rail .rcard.k-proposal', has=pa.locator(f'.rc-opt[data-pid="{pid_of["s0/p4"]}"]'))
    ok(pcard4.locator('.rc-rtag').inner_text().strip() == f'AI 작업 #{rid1}', "제안 카드 머리에 'AI 작업 #n' 꼬리표")
    pc4.locator('.rc-reject').click()
    wait_until(lambda: next(x for x in rest(f'/api/docs/{dj}/proposals') if x['pid'] == pid_of['s0/p4'])['status'] == 'rejected', msg='하나 거절')
    wait_until(lambda: '제안 4건 — 거절 1 · 남음 3' in text_of(rc1), msg='진행 줄 거절 1 · 남음 3')
    ok(rc1.locator('.ra-adopt').inner_text().strip() == '모두 반영 (3)', '하나 거절 → [모두 반영 (3)](거절한 것은 빠짐)')
    # [모두 반영 (3)] → 남은 것만 편집기에 한 번에 → resolve { adopt } 한 번 → 해결
    rc1.locator('.ra-adopt').click()

    def ed_text(ref):
        return pa.evaluate(f"() => window.__doc.editor.frame().contentWindow.rhwpCowork.debug.text({json.dumps(ref)})")
    wait_until(lambda: ed_text('s0/p3') == P['s0/p3'].replace('적습니다', '적음') and ed_text('s0/p5') == P['s0/p5'].replace('1억 원입니다', '1억 원임'), timeout=15, msg='편집기에 한 번에')
    ins = pa.evaluate('async () => (await window.__doc.editor.draftState()).inserted')
    ok(ed_text('s0/p4') == P['s0/p4'] and any(x.get('afterRef') == 's0/p6' and '보완 문단' in x.get('text', '') for x in ins),
       '[모두 반영 (3)] → 편집기에 바꿈 2 + 문단 추가 1(거절한 s0/p4 는 그대로)')
    wait_until(lambda: rest(f'/api/docs/{dj}/requests/{rid1}')['outcome']['resolved'] is True, timeout=15, msg='서버: 요청 해결')
    rq1b = rest(f'/api/docs/{dj}/requests/{rid1}')
    adopted = [x['pid'] for x in rest(f'/api/docs/{dj}/proposals') if x.get('rid') == rid1 and A['name'] in (x.get('adoptedBy') or {})]
    ok(rq1b['outcome']['accepted'] == 3 and rq1b['outcome']['declined'] == 1 and rq1b['resolvedBy'] == A['name'] and sorted(adopted) == sorted(p for k, p in pid_of.items() if k != 's0/p4'),
       f"서버: 반영 3 · 거절 1 · 해결({rq1b['resolvedBy']}) — 반영 기록 {sorted(adopted)}")
    acts = [x for x in rest(f'/api/docs/{dj}/history')['activity'] if x.get('type') == 'request.resolve']
    ok(len(acts) == 1, f'resolve 한 번(제안마다 adopt 를 부르지 않음 — 활동 기록 request.resolve {len(acts)}개)')
    t_ad = wait_until(lambda: next((x for x in pa.locator('.toasts .toast').all_inner_texts() if f'AI 작업 #{rid1}: 3건을 내 수정본에 반영했습니다' in x), None), timeout=10, msg='알림')
    ok('Ctrl+Z 한 번' in t_ad, f'알림 「{t_ad}」')
    wait_until(lambda: rc1.count() == 0, timeout=15, msg='해결 → 레일 AI 작업 카드 사라짐')
    wait_until(lambda: pa.locator('.review-rail .rcard.k-proposal').count() == 0, timeout=10, msg='반영한 제안 카드도 빠짐')
    ok(True, '해결 → 레일의 AI 작업 카드·제안 카드가 사라짐(해결된 메모처럼)')
    ok(rest(f'/api/docs/{dj}')['milestone']['v'] == 1, '내 수정본에만 반영 → 사람용 버전은 그대로(v1)')
    mtext = next(x for x in rest(f'/api/docs/{dj}/memos') if x['id'] == mid1)['text']
    ok('반영 3건' in mtext and '✓ 해결' in mtext, '작업 기록 메모 하나: 결과 반영 3건 · ✓ 해결')
    tab(pa, 'review')
    pa.locator('.rt-filters [data-filter="resolved"]').click(); time.sleep(0.3)
    rv1 = pa.locator(f'.rt-list .rcard.k-request[data-id="{mid1}"]')
    # 카드 머리 상태 칩이 '완료'를 말하므로 끝난 줄은 수만(docs/UI_TERMS.md §1-2 — '완료'는 한 번)
    ok(rv1.count() == 1 and rv1.locator('.ra-done').inner_text().strip() == '반영 3 · 거절 1' and rv1.locator('.req-st').inner_text().strip() == '완료',
       f"검토 탭 '완료'에 그 AI 작업 — 칩 「{rv1.locator('.req-st').inner_text().strip() if rv1.count() else ''}」 · 한 줄 「{rv1.locator('.ra-done').inner_text().strip() if rv1.count() else ''}」")
    pa.locator('.rt-filters [data-filter="all"]').click(); time.sleep(0.2)
    ok(pa.locator(f'.rt-list .rcard.k-request[data-id="{mid1}"]').count() == 0, "검토 탭 '전체'에는 없음")
    shot31(pa, 'job_resolved')

    # [남은 n건 거절] → 그 자리 확인 줄 → [취소]면 그대로 · [거절] → 남은 것 모두 거절(resolve reject 한 번) → 해결
    rid2, pids2 = ai_job(dj, A['token'], 's0/p7', P['s0/p7'], [
        {'ref': 's0/p7', 'find': '맺음말입니다', 'replace': '맺음말임', 'reason': '끝맺음(시험)'},
        {'ref': 's0/p6', 'find': '정리합니다', 'replace': '정리함', 'reason': '끝맺음(시험)'},
    ])
    tab(pa, 'ai')
    card2 = pa.locator(f'.tab-ai .card.req[data-rid="{rid2}"]')
    wait_until(lambda: card2.count() == 1 and card2.locator('.ra-reject').count() == 1, timeout=15, msg='둘째 요청 카드')
    ok(card2.locator('.ra-line').inner_text().strip() == '제안 2건 — 남음 2', f"둘째 요청 진행 줄 「{card2.locator('.ra-line').inner_text().strip()}」")
    card2.locator('.ra-reject').click()
    cf2 = card2.locator('.confirm-row')
    cf2.wait_for(timeout=5000)
    ok('남은 2건을 거절할까요?' in cf2.inner_text() and card2.locator('.ra-adopt').count() == 0, f"[남은 2건 거절] → 그 자리 확인 줄 「{cf2.inner_text().strip()[:40]}」")
    shot31(pa, 'job_reject_confirm')
    cf2.locator('button:has-text("취소")').click()
    wait_until(lambda: card2.locator('.confirm-row').count() == 0 and card2.locator('.ra-adopt').count() == 1, msg='취소 → 단추로')
    ok(all(x['status'] == 'pending' for x in rest(f'/api/docs/{dj}/proposals') if x.get('rid') == rid2), '[취소] → 아무것도 거절하지 않음')
    card2.locator('.ra-reject').click()
    card2.locator('.confirm-row button:has-text("거절")').click()
    wait_until(lambda: rest(f'/api/docs/{dj}/requests/{rid2}')['outcome']['resolved'] is True, timeout=15, msg='남은 것 거절 → 해결')
    ok(all(x['status'] == 'rejected' for x in rest(f'/api/docs/{dj}/proposals') if x.get('rid') == rid2), '두 제안 모두 거절')
    wait_until(lambda: card2.locator('.ra-done').count() == 1, timeout=10, msg='카드 해결 줄')
    # AI 작업 탭 카드: 상태 칩이 '완료'를 말하므로 끝난 줄은 수만(docs/UI_TERMS.md §1-2)
    ok(card2.locator('.ra-done').inner_text().strip() == '거절 2' and card2.locator('.req-st').inner_text().strip() == '완료', f"카드 「{card2.locator('.ra-done').inner_text().strip()}」 · 칩 「{card2.locator('.req-st').inner_text().strip()}」")
    t_rj = wait_until(lambda: next((x for x in pa.locator('.toasts .toast').all_inner_texts() if f'AI 작업 #{rid2}' in x and '거절했습니다' in x), None), timeout=10, msg='거절 알림')
    ok(t_rj == f'AI 작업 #{rid2}: 남은 2건을 거절했습니다', f'알림 「{t_rj}」')
    shot31(pa, 'job_rejected')
    pa.evaluate('() => window.__doc.discardMine({ confirmFirst: false })')
    wait_until(lambda: rest(f'/api/docs/{dj}/drafts/mine')['cr'] is None, timeout=15, msg='정리(내 수정본 버림)')
    # 이력 탭의 복구: 누른 줄 바로 아래 그 자리 확인 줄(브라우저 확인 창 아님) → 알림은 사람용 이름(v1)
    pa.locator('[data-testid="version-pill"]').click()
    hv1 = pa.locator('.tab-history .hist-v[data-v="1"]')
    wait_until(lambda: hv1.count() == 1 and hv1.locator('.hist-restore').count() == 1, msg='v1 [이 버전으로 복구]')
    hv1.locator('.hist-restore').click()
    cfr = hv1.locator('.confirm-row')
    cfr.wait_for(timeout=5000)
    ok(cfr.inner_text().startswith('v1(') and '되돌릴까요' in cfr.inner_text(), f"복구 → 그 줄 아래 확인 줄 「{cfr.inner_text().splitlines()[0][:40]}」")
    cfr.locator('button:has-text("복구")').click()
    t_rs = wait_until(lambda: next((x for x in pa.locator('.toasts .toast').all_inner_texts() if x.startswith('v1')), None), timeout=15, msg='복구 알림')
    ok(t_rs.startswith('v1과 같습니다') or t_rs.startswith('v1 내용으로 복구했습니다'), f'복구 알림(사람용 이름 — 기록 번호 아님) 「{t_rs}」')
    shot31(pa, 'history_restore')


# ───────── 화면 도우미 ─────────

def open_doc(pg, did, reload=False, suffix=''):
    url = f'{BASE}/#/doc/{did}{suffix}'
    if reload and pg.url == url:
        pg.reload()   # 같은 주소(해시만)로 goto 하면 다시 열리지 않는다
    else:
        pg.goto(url)
    # 해시만 바뀌는 이동이면 잠깐 옛 문서의 store 가 window.__doc 에 남아 있다 — 이 문서(id)의 편집기를 기다린다
    pg.wait_for_function(f'() => !!(window.__doc && window.__doc.id === {json.dumps(did)} && window.__doc.editor && (window.__doc.editor.ready || window.__doc.editor.error))', timeout=120000)
    err = pg.evaluate('() => window.__doc.editor.error')
    ok(not err, f'편집기 준비{"" if not err else ": " + err}')
    pg.wait_for_function('() => window.__doc.s.loaded', timeout=30000)
    time.sleep(0.5)


def tab(pg, tid):
    pg.locator(f'.tabs button[data-tab="{tid}"]').click()
    time.sleep(0.25)


def doc_state(pg, expr):
    return pg.evaluate(f'() => {{ const d = window.__doc; const s = d.s; return {expr}; }}')


def overlays(pg):
    return pg.evaluate('() => { const f = window.__doc.editor.frame(); return f ? f.contentWindow.rhwpCowork.debug.overlays() : []; }')


def text_of(loc):
    return loc.inner_text().replace('\n', ' ')



def shot4(pg, name):
    """v0.4 새 화면(docs/V4_SPEC.md §7) 스크린숏 — tests/out/v04_<name>.png"""
    pg.screenshot(path=f'{OUT}/v04_{name}.png')
    print(f'    → tests/out/v04_{name}.png', flush=True)


def v04_panels(context, tmp):
    """[13] v0.4(docs/V4_SPEC.md §4·§5·§2.6·§7) 화면: 실시간 문서에서 AI 작업 결과 — 요청자 A 에게만 제안 카드(우클릭 '문서에 반영'), 남(B, '간단히')에게는 한 줄 요약 카드
    (`🤖 AI 작업 #n · 홍길동 · 완료` + 요약)·편집기 강조·우클릭 항목 없음 · [자세히] → AI 작업 탭 결과(읽기만) · 보기 '자세히' 전환(탭·카드, 다시 열어도 그대로) ·
    A [모두 반영] → 공유 문서에 바로 → B 편집기에도(다시 열지 않음) → B 요약 칩 ✓ · A [되돌리기] → B 편집기도 · 이력 탭 실시간 편집 묶음(펼침·이 시점으로 복구) ·
    승인 방식 때 남은 내 수정본 띠 [지금 문서에 반영] · 설정 창의 승인 → 실시간 경고 줄·오류 표시"""
    print('[13] v0.4 화면: 남의 AI 작업 한 줄 요약 · 요청자만 제안 · 모두 반영 → 남의 편집기에 바로 · 되돌리기 · 간단히/자세히 · 이력 실시간 묶음 · 남은 수정본 띠 · 설정 창', flush=True)
    built = node_helper(['build', '--out', os.path.join(tmp, 'v04_doc.hwpx')])
    P = {p['ref']: p['text'] for p in built['paragraphs']}

    def up(name):
        with open(built['out'], 'rb') as f:
            return rest('/api/docs', 'POST', f.read(), {'x-file-name': urllib.parse.quote(name), 'Content-Type': 'application/octet-stream'}, raw=True, token=ADMIN['token'])['id']

    def para(did, ref):
        return next((x['text'] for x in rest(f'/api/docs/{did}/paragraphs') if x['ref'] == ref), None)

    def ed_text(pg, ref):
        return pg.evaluate(f"() => window.__doc.editor.frame().contentWindow.rhwpCowork.debug.text({json.dumps(ref)})")

    def ed_type(pg, ref, off, s):
        pg.evaluate(f"() => window.__doc.editor.frame().contentWindow.rhwpCowork.debug.select({json.dumps(ref)}, {off}, {off})")
        time.sleep(0.15)
        pg.keyboard.type(s)

    def tabs_of(pg):
        return pg.evaluate("() => [...document.querySelectorAll('.panel .tabs [role=tab]')].map((b) => b.dataset.tab)")

    dv = up('실시간화면.hwpx')
    rest(f'/api/docs/{dv}/settings', 'PATCH', {'editMode': 'realtime', 'aiMemo': 'summary'}, token=ADMIN['token'])
    ctx_a, pa = context(A, view=None)
    ctx_b, pb = context(B, view=None)
    open_doc(pa, dv)
    open_doc(pb, dv)
    ok(doc_state(pa, 'd.editor.mode') == 'live' and doc_state(pb, 'd.editor.mode') == 'live' and doc_state(pb, 's.view') == 'simple', '실시간 문서 · 두 편집기 실시간 · 보기 기본 간단히')

    print('[13a] AI 작업 결과: 요청자 A 에게만 제안 카드 · B 에게는 한 줄 요약 카드만(강조·우클릭 항목 없음)', flush=True)
    rid, pids = ai_job(dv, A['token'], 's0/p3', P['s0/p3'], [
        {'ref': 's0/p3', 'find': '적습니다', 'replace': '적음', 'reason': '끝맺음(시험)'},
        {'ref': 's0/p4', 'find': '12월까지입니다', 'replace': '12월까지임', 'reason': '끝맺음(시험)'},
        {'ref': 's0/p5', 'find': '1억 원입니다', 'replace': '1억 원임', 'reason': '끝맺음(시험)'},
    ])
    pid_of = {p['ref']: p['pid'] for p in rest(f'/api/docs/{dv}/proposals') if p.get('rid') == rid}
    mid = rest(f'/api/docs/{dv}/requests/{rid}')['memoId']
    rca = pa.locator(f'.review-rail .rcard.k-request[data-id="{mid}"]')
    wait_until(lambda: rca.count() == 1 and '제안 3건 — 남음 3' in text_of(rca), timeout=20, msg='A 레일 AI 작업 카드')
    wait_until(lambda: pa.locator('.review-rail .rcard.k-proposal').count() == 3, timeout=15, msg='A 제안 카드 3')
    ok(rca.locator('.ra-adopt').inner_text().strip() == '모두 반영 (3)' and pa.locator('.review-rail .rcard.k-proposal .rc-adopt.rc-live').count() == 3
       and pa.locator('.review-rail .rc-apply').count() == 0 and rca.locator('.ra-apply').count() == 0,
       '요청자 A(간단히): AI 작업 카드 [모두 반영 (3)] · 제안 카드 3개마다 [반영](공유 문서에 바로 — [기준에 바로 적용] 없음)')
    rcb = pb.locator('.review-rail .rcard.k-summary')
    wait_until(lambda: rcb.count() == 1 and pb.locator(f'.review-rail .rail-slot.placed .rcard.k-summary').count() == 1, timeout=20, msg='B 한 줄 요약 카드')
    head = rcb.locator('.rc-sum-head').inner_text().strip()
    ok(head == f'AI 작업 #{rid} · {A["name"]}' and '끝맺음 여러 곳을 다듬도록 제안함' in rcb.locator('.rc-sum-text').inner_text()
       and rcb.locator('.rc-sum-chip').inner_text().strip() == '확인 필요' and pb.locator('.review-rail .rcard.k-proposal').count() == 0 and pb.locator('.review-rail .ra-adopt').count() == 0,
       f'B(간단히): 한 줄 요약 카드 「{head}」 + 상태 칩 하나(확인 필요 — 남은 제안 3) + 요약 — 제안 카드·[모두 반영] 없음')
    ok(not [x for x in overlays(pb) if x['kind'] == 'proposal'] and len({x['id'] for x in overlays(pa) if x['kind'] == 'proposal'}) == 3,
       'B 편집기: 남의 AI 작업 제안 강조 없음 · A 편집기에는 제안 3개 강조')
    fa = next(f for f in pa.frames if '/studio/' in f.url)
    fb = next(f for f in pb.frames if '/studio/' in f.url)
    pt = pb.evaluate("() => window.__doc.editor.frame().contentWindow.rhwpCowork.debug.pointFor('s0/p4', 20)")
    off = pb.evaluate("() => { const r = window.__doc.editor.frame().getBoundingClientRect(); return { x: r.left, y: r.top }; }")
    pb.mouse.click(off['x'] + pt['x'], off['y'] + pt['y'], button='right')
    fb.wait_for_selector('.context-menu [data-cowork-action="instruct"]', timeout=5000)
    ok(fb.locator('.context-menu [data-cowork-sub^="rv-proposal:"]').count() == 0, 'B 우클릭(남의 제안이 덮는 자리): 제안 하위 메뉴 없음')
    pb.keyboard.press('Escape')
    pt = pa.evaluate("() => window.__doc.editor.frame().contentWindow.rhwpCowork.debug.pointFor('s0/p4', 20)")
    off = pa.evaluate("() => { const r = window.__doc.editor.frame().getBoundingClientRect(); return { x: r.left, y: r.top }; }")
    pa.mouse.click(off['x'] + pt['x'], off['y'] + pt['y'], button='right')
    psub = f'[data-cowork-sub="rv-proposal:{pid_of["s0/p4"]}"]'
    fa.wait_for_selector(f'.context-menu {psub}', timeout=5000)
    fa.hover(f'.context-menu {psub}')
    item = fa.locator(f'.context-menu {psub} [data-cowork-action="proposal-adopt"]')
    item.wait_for(timeout=3000)
    ok(item.inner_text().strip().endswith('문서에 반영'), f"A 우클릭 제안 ▸ 「{item.inner_text().strip()}」(실시간 문서 — 내 수정본이 아니라 공유 문서에)")
    pa.keyboard.press('Escape')
    shot4(pb, 'summary_card_B')
    shot4(pa, 'requester_cards_A')

    print('[13b] B 요약 카드 [자세히] → AI 작업 탭 결과(읽기만)', flush=True)
    rcb.locator('.rc-result').click()
    wait_until(lambda: doc_state(pb, 's.tab') == 'ai' and doc_state(pb, 's.activeRid') == rid, msg='B AI 작업 탭')
    res_b = pb.locator('.tab-ai .result-card')
    wait_until(lambda: res_b.locator('.rs-open .prop').count() == 3, timeout=10, msg='B 결과 창')
    ok(res_b.locator('.rs-adopt').count() == 0 and res_b.locator('.rs-reject').count() == 0 and '반영·거절은 요청한 사람이 합니다' in res_b.locator('.rs-ro').inner_text(),
       f"B 결과 창: 남은 제안 3건이 보이되 읽기만 — 「{res_b.locator('.rs-ro').inner_text().strip()[:40]}…」")

    print("[13c] 보기 '자세히' 전환: 남의 제안 카드·여섯 탭 · 다시 열어도 그대로(localStorage) · '간단히'로 돌아옴", flush=True)
    ok(tabs_of(pb) == ['ai', 'review'], f'B 간단히 탭 {tabs_of(pb)}')
    pb.locator('[data-testid="view-toggle"] [data-view="detail"]').click()
    wait_until(lambda: pb.locator('.review-rail .rcard.k-proposal').count() == 3 and pb.locator('.review-rail .rcard.k-summary').count() == 0, timeout=10, msg='B 자세히')
    ok(tabs_of(pb) == ['ai', 'review', 'cr', 'change', 'attach', 'history'] and pb.evaluate("() => localStorage.getItem('hwpx.view')") == 'detail'
       and any(x['kind'] == 'proposal' for x in overlays(pb)),
       "B 자세히: 남의 제안 카드 3 · 편집기 강조 · 탭 여섯(v0.3.1 그대로) · localStorage hwpx.view = detail")
    shot4(pb, 'detail_view_B')
    open_doc(pb, dv, reload=True)
    ok(doc_state(pb, 's.view') == 'detail' and pb.locator('[data-testid="view-toggle"] [data-view="detail"].on').count() == 1, '다시 열어도 자세히(이 브라우저에 기억)')
    pb.locator('[data-testid="view-toggle"] [data-view="simple"]').click()
    wait_until(lambda: pb.locator('.review-rail .rcard.k-summary').count() == 1 and pb.locator('.review-rail .rcard.k-proposal').count() == 0, timeout=10, msg='B 간단히')
    ok(tabs_of(pb) == ['ai', 'review'], "'간단히'로 돌아옴 — 한 줄 요약 카드·네 탭")

    print('[13d] A [모두 반영 (3)] → 공유 문서에 바로 → B 편집기에도(다시 열지 않음) · B 요약 칩 ✓', flush=True)
    opens_b = doc_state(pb, 'd.editor.opens')
    want = {'s0/p3': P['s0/p3'].replace('적습니다', '적음'), 's0/p4': P['s0/p4'].replace('12월까지입니다', '12월까지임'), 's0/p5': P['s0/p5'].replace('1억 원입니다', '1억 원임')}
    # AI 작업 해결 버전은 마지막 버전에서 30분(config.documents.aiMilestoneMinutes 기본)이 지나야 생긴다(V4 §2.6) — 올림(v1)을 31분 전으로
    mp = os.path.join(tmp, 'data', 'docs', dv, 'meta.json')
    with open(mp, encoding='utf-8') as f: mm = json.load(f)
    mm['milestones'][-1]['at'] = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(minutes=31)).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
    with open(mp, 'w', encoding='utf-8', newline='') as f: json.dump(mm, f, ensure_ascii=False, indent=1)
    rca.locator('.ra-adopt').click()
    wait_until(lambda: all(para(dv, r) == t for r, t in want.items()), timeout=15, msg='서버에 반영')
    t_ad = wait_until(lambda: next((x for x in pa.locator('.toasts .toast').all_inner_texts() if f'AI 작업 #{rid}: 3건을 문서에 반영했습니다' in x), None), timeout=10, msg='A 알림')
    wait_until(lambda: all(ed_text(pb, r) == t for r, t in want.items()), timeout=10, msg='B 편집기')
    ok(doc_state(pb, 'd.editor.opens') == opens_b and doc_state(pb, 's.live.syncs') >= 1, f"A 알림 「{t_ad[:40]}…」 → B 편집기에 바로(맞추기 — 다시 열지 않음)")
    rq = rest(f'/api/docs/{dv}/requests/{rid}')
    ok(rq['outcome']['resolved'] is True and rq['outcome']['applied'] == 3 and rest(f'/api/docs/{dv}')['milestone']['v'] == 2, '서버: 적용 3 · 해결 · 사람용 버전 v2(AI 작업 해결)')
    wait_until(lambda: pb.locator('.review-rail .rcard.k-summary').count() == 0, timeout=10, msg='해결 → 레일에서 빠짐')
    tab(pb, 'review')
    pb.locator('.rt-filters [data-filter="resolved"]').click(); time.sleep(0.3)
    scard = pb.locator(f'.rt-list .rcard.k-summary[data-rid="{rid}"]')
    wait_until(lambda: scard.count() == 1 and scard.locator('.rc-sum-chip').inner_text().strip() == '완료', timeout=10, msg='완료 요약 카드 칩')
    ok('반영 3건' in (scard.locator('.rc-sum-chip').get_attribute('title') or ''),
       "B 검토 탭 '완료': 한 줄 요약 카드 칩 '완료'(title 에 '반영 3건')")
    pb.locator('.rt-filters [data-filter="all"]').click()
    shot4(pb, 'applied_B')

    print('[13e] A [되돌리기](AI 작업 탭 — 실시간 문서는 글 되돌리기) → B 편집기도', flush=True)
    pa.evaluate(f"() => {{ const s = window.__doc.s; s.tab = 'ai'; s.activeRid = {rid}; }}")
    acc = pa.locator(f'.tab-ai .result-card .rs-accepted [data-pid="{pid_of["s0/p5"]}"]')
    wait_until(lambda: acc.count() == 1 and acc.locator('.rs-undo').count() == 1, timeout=10, msg="A 결과 창 '반영한 제안'")
    ok(acc.locator('.rs-undo').inner_text().strip() == '되돌리기' and pa.locator('.tab-ai .result-card .rs-apply').count() == 0, "반영한 제안에 [되돌리기]")
    acc.locator('.rs-undo').click()
    wait_until(lambda: para(dv, 's0/p5') == P['s0/p5'], timeout=10, msg='서버 되돌림')
    wait_until(lambda: ed_text(pb, 's0/p5') == P['s0/p5'] and ed_text(pa, 's0/p5') == P['s0/p5'], timeout=10, msg='B 편집기 되돌림')
    ok(para(dv, 's0/p3') == want['s0/p3'], '[되돌리기] → 그 제안의 글만 원문으로(서버·두 편집기) · 다른 반영은 그대로')

    print('[13f] 이력 탭: 같은 사람의 이어진 실시간 편집은 한 줄(펼치면 기록마다 · 이 시점으로 복구)', flush=True)
    base6 = ed_text(pa, 's0/p6')
    for w in (' 하나', ' 둘', ' 셋'):
        cur = ed_text(pa, 's0/p6')
        ed_type(pa, 's0/p6', len(cur), w)
        wait_until(lambda: para(dv, 's0/p6') == cur + w, timeout=10, msg=f'밀어 넣기 {w}')
        time.sleep(0.3)
    # 이력 탭은 '자세히' 보기에만 있다(web/view.js panelTabIds) — 버전 칩으로 열기 전에 자세히로
    pa.locator('[data-testid="view-toggle"] [data-view="detail"]').click(); time.sleep(0.5)
    pa.locator('[data-testid="version-pill"]').click()
    wait_until(lambda: doc_state(pa, 's.tab') == 'history', msg='이력 탭')
    top = pa.locator('.tab-history .hist-top')
    wait_until(lambda: top.locator('.hist-recs > summary').count() == 1, timeout=10, msg='변경 이력 보기')
    top.locator('.hist-recs > summary').click()
    grp = top.locator('.hist-live')
    wait_until(lambda: grp.count() == 1, timeout=10, msg='실시간 편집 묶음')
    lab = grp.locator('summary').inner_text().strip()
    ok(re.fullmatch(rf'{A["name"]} · 실시간 편집 3번 · \d\d:\d\d~\d\d:\d\d', lab) is not None and grp.get_attribute('data-count') == '3',
       f'이력: 「{lab}」(같은 사람의 이어진 실시간 편집 기록 3개 → 한 줄)')
    grp.locator('summary').click()
    rows = grp.locator('.hist-rec')
    ok(rows.count() == 3 and all('실시간 편집' in x for x in rows.all_inner_texts()) and grp.locator('.hist-rec-restore').count() >= 2,
       '펼치면 기록마다(시각 · 누가 · 실시간 편집) [이 시점으로 복구]')
    shot4(pa, 'history_live_group')
    first = rows.last   # 새것부터 — 맨 아래가 첫 실시간 편집(' 하나')
    first.locator('.hist-rec-restore').click()
    cf = grp.locator('.confirm-row')
    cf.wait_for(timeout=5000)
    cf.locator('button:has-text("복구")').click()
    t_rs = wait_until(lambda: next((x for x in pa.locator('.toasts .toast').all_inner_texts() if '기록 내용으로 복구했습니다' in x), None), timeout=15, msg='복구 알림')
    wait_until(lambda: para(dv, 's0/p6') == base6 + ' 하나' and ed_text(pb, 's0/p6') == base6 + ' 하나', timeout=15, msg='복구 → 두 편집기')
    ok(True, f'묶음 안 기록 [이 시점으로 복구] → 「{t_rs[:30]}…」 · B 편집기도 따라감')

    print('[13g] 설정 창: 승인 → 실시간 경고 줄(진행 중 변경 요청) · 남은 내 수정본 띠 [지금 문서에 반영] · 설정 오류 표시', flush=True)
    dr = up('남은수정본.hwpx')
    bres = node_helper(['draft', '--base', REST, '--doc', dr, '--edits', json.dumps([{'ref': 's0/p4', 'from': '3월부터', 'to': '4월부터'}], ensure_ascii=False)], token=B['token'])
    bcid = bres['cr']['cid']
    ctx_m, pm = context(ADMIN, view=None)
    open_doc(pm, dr)
    ok(doc_state(pm, 'd.editor.mode') == 'review' and pm.locator('[data-testid="doc-settings"]').count() == 1, '관리자: 승인 방식 문서 · ⚙ 문서 설정')
    # 간단히 + 승인 방식: 남의 '수정 중' 덩어리 카드는 변경 요청마다 한 줄 · 진행 중 변경 요청이 있으니 '변경 요청' 탭이 보임
    dline = pm.locator('.review-rail .rcard.k-draftline')
    wait_until(lambda: dline.count() == 1 and pm.locator('.review-rail .rail-slot.placed .rcard.k-draftline').count() == 1, timeout=20, msg='수정 중 한 줄')
    ok(dline.locator('.rc-draft-title').inner_text().strip() == f'✎ {B["name"]} 수정 중 · 1문단' and pm.locator('.review-rail .rcard.k-draft:not(.k-draftline)').count() == 0
       and tabs_of(pm) == ['ai', 'review', 'cr'],
       f"관리자(간단히): 남의 수정 중 = 변경 요청마다 한 줄 「{dline.locator('.rc-draft-title').inner_text().strip()}」 [보기] · 탭 {tabs_of(pm)}")
    dline.locator('.rc-show').click()
    wait_until(lambda: doc_state(pm, 's.tab') == 'cr' and pm.locator(f'.cr-detail[data-cid="{bcid}"]').count() == 1, timeout=10, msg='[보기] → 변경 요청 상세')
    ok(True, '[보기] → 변경 요청 탭 그 상세')
    shot4(pm, 'draft_line_simple')
    pm.click('[data-testid="doc-settings"]')
    dlg = pm.locator('[data-testid="settings-dialog"]')
    dlg.wait_for(timeout=5000)
    dlg.locator('[data-setting="editMode"] input[data-value="realtime"]').check()
    warn = dlg.locator('[data-testid="settings-warning"]')
    wait_until(lambda: warn.count() == 1, timeout=5, msg='경고 줄')
    ok(warn.inner_text().strip() == '⚠ 진행 중 변경 요청 1건을 먼저 반영하거나 닫으세요' and '열지 않습니다' in (warn.get_attribute('title') or ''), f"경고 줄 「{warn.inner_text().strip()}」(까닭은 title)")
    shot4(pm, 'settings_warning')
    pm.click('[data-testid="settings-save"]')
    wait_until(lambda: dlg.count() == 0 and rest(f'/api/docs/{dr}')['settings']['editMode'] == 'realtime', timeout=10, msg='실시간으로')
    open_doc(pb, dr)
    ban = pb.locator('[data-testid="leftover-banner"]')
    wait_until(lambda: ban.count() == 1 and doc_state(pb, 'd.editor.mode') == 'live', timeout=15, msg='남은 수정본 띠')
    ok(ban.locator('.lo-text').inner_text().strip() == f'남은 내 수정본 · 변경 요청 #{bcid} · 1문단' and ed_text(pb, 's0/p4') == P['s0/p4'],
       f"B(실시간 편집기 — 수정본을 열지 않음): 띠 「{ban.locator('.lo-text').inner_text().strip()}」")
    shot4(pb, 'leftover_banner')
    ban.locator('[data-testid="leftover-merge"]').click()
    wait_until(lambda: rest(f'/api/docs/{dr}/change-requests/{bcid}')['status'] == 'merged', timeout=20, msg='반영')
    wait_until(lambda: ban.count() == 0 and '4월부터' in (ed_text(pb, 's0/p4') or ''), timeout=20, msg='띠 사라짐 · 편집기')
    ok('4월부터' in para(dr, 's0/p4'), '띠 [반영] → 승인 없이 반영(실시간 문서 — 수정 권한) · 띠 사라짐 · 편집기·공유 문서에 그 글')
    # 설정 저장 실패(서버 오류) → 창 안에 오류 글(창은 그대로)
    pat = re.compile(r'/api/docs/[^/]+/settings$')
    pm.route(pat, lambda route: route.fulfill(status=403, content_type='application/json', body=json.dumps({'error': 'FORBIDDEN', 'message': '문서 설정은 관리자나 문서를 올린 사람만 바꿀 수 있습니다'}, ensure_ascii=False)))
    pm.click('[data-testid="doc-settings"]')
    dlg.wait_for(timeout=5000)
    dlg.locator('[data-setting="aiMemo"] input[data-value="summary"]').check()   # (시험 config 기본 = detail)
    pm.click('[data-testid="settings-save"]')
    err = dlg.locator('[data-testid="settings-error"]')
    wait_until(lambda: err.count() == 1, timeout=5, msg='오류 글')
    ok(err.inner_text().strip() == '문서 설정은 관리자나 문서를 올린 사람만 바꿀 수 있습니다' and dlg.count() == 1, f"저장 실패 → 창 안에 오류 「{err.inner_text().strip()}」(창은 그대로)")
    shot4(pm, 'settings_error')
    pm.unroute(pat)
    dlg.locator('.ds-foot button:has-text("취소")').click()
    wait_until(lambda: dlg.count() == 0, timeout=5, msg='창 닫힘')
    for c in (ctx_a, ctx_b, ctx_m):
        c.close()


def main():
    tmp = tempfile.mkdtemp(prefix='hwpx_ui_collab_')
    srv = log = None
    sse = None
    try:
        srv, log, conf = start_server(tmp)
        print(f'server up v{conf.get("version")} aiEnabled={conf.get("aiEnabled")} aiMock={conf.get("aiMock")} studio={conf.get("studio", {}).get("built")}', flush=True)
        ok(conf.get('aiMock') is True, '서버 AI = 모의')
        ok(conf.get('studio', {}).get('built') is True, '편집기 빌드(studio/dist) 있음')

        # ── 준비: 시험 문서(관리자 올림) + a 의 수정본(엔진으로 고친 HWPX) ──
        built = node_helper(['build', '--out', os.path.join(tmp, 'collab_doc.hwpx')])
        paras = {p['ref']: p['text'] for p in built['paragraphs']}
        with open(built['out'], 'rb') as f:
            doc = rest('/api/docs', 'POST', f.read(), {'x-file-name': urllib.parse.quote('협업시험.hwpx'), 'Content-Type': 'application/octet-stream'}, raw=True, token=ADMIN['token'])
        did = doc['id']
        v0 = rest(f'/api/docs/{did}')['version']
        dr = node_helper(['draft', '--base', REST, '--doc', did, '--edits', json.dumps([
            {'ref': 's0/p4', 'from': '3월부터', 'to': '4월부터'},
            {'ref': 's0/p5', 'from': '1억 원', 'to': '2억 원'},
        ], ensure_ascii=False)], token=A['token'])
        cr = dr['cr']
        ok(cr and cr['status'] == 'draft' and cr['hunkCount'] == 2, f"a 의 수정본 = 변경 요청 #{cr and cr['cid']}(초안, 덩어리 {cr and cr['hunkCount']})")
        cid = cr['cid']
        hunks = rest(f'/api/docs/{did}/change-requests/{cid}', token=B['token'])['hunks']
        ok([h['curRef'] for h in hunks] == ['s0/p4', 's0/p5'], f"덩어리 자리 {[h['curRef'] for h in hunks]}")

        with sync_playwright() as p:
            br = p.chromium.launch(executable_path=CHROME)

            def context(user, view='detail'):
                """view = 보기(localStorage hwpx.view) — 지금까지의 시험은 '자세히'(v0.3.1 화면 그대로), None 이면 적지 않는다(기본 '간단히')"""
                ctx = br.new_context(viewport={'width': 1480, 'height': 920}, device_scale_factor=1, accept_downloads=True)
                ctx.add_init_script(f"try {{ localStorage.setItem('hwpx.token', {json.dumps(user['token'])}); }} catch (e) {{}}")
                if view:
                    ctx.add_init_script(f"try {{ localStorage.setItem('hwpx.view', {json.dumps(view)}); }} catch (e) {{}}")
                ctx.grant_permissions(['clipboard-read', 'clipboard-write'], origin=BASE)
                pg = ctx.new_page()
                who = user['name']
                pg.on('pageerror', lambda e: ERRORS.append(f'[{who}] pageerror: {e}'))
                pg.on('console', lambda m: ERRORS.append(f'[{who}] console.error: {m.text} @ {(m.location or {}).get("url", "")}') if m.type == 'error' else None)
                pg.on('dialog', lambda d: (DIALOGS.append(f'[{who}] {d.type}: {d.message}'), d.dismiss()))
                return ctx, pg

            ctx_b, pb = context(B)
            ctx_a, pa = context(A)

            if os.environ.get('UI_COLLAB_ONLY') == 'jobs':   # 개발용: [12] AI 작업 요청 단위만(전체 시험은 이 변수 없이)
                v031_jobs(pa, pb, tmp)
                raise OnlyJobs()
            if os.environ.get('UI_COLLAB_ONLY') == 'v04':    # 개발용: [13] v0.4 화면만
                v04_panels(context, tmp)
                raise OnlyJobs()

            print('[1] b: 레일에 a 의 수정 중 카드', flush=True)
            open_doc(pb, did)
            ok(doc_state(pb, 's.railOpen') is True, '넓은 창 = 레일 펼침')
            card = pb.locator('.review-rail .rcard.k-draft')
            wait_until(lambda: card.count() == 2, timeout=30, msg='수정 중 카드 2개')
            # 카드는 자리를 잡을 때까지(다음 프레임) visibility:hidden — 그동안 innerText 는 빈 글이다
            wait_until(lambda: pb.locator('.review-rail .rail-slot.placed .rcard.k-draft').count() == 2, msg='수정 중 카드 자리 잡음')
            t = text_of(card.first)
            tag = card.first.locator('.rc-crtag')
            ok('✎ 홍길동 수정 중' in t and tag.inner_text().strip() == f'#{cid}' and '초안' in (tag.get_attribute('title') or ''), f'카드 머리: {t[:60]}(변경 요청 #{cid} · 초안은 title)')
            ok('3' in card.first.locator('.difftext del').inner_text() and '4' in card.first.locator('.difftext ins').inner_text(), '카드에 기준→수정 글자 차이(del 3 / ins 4)')
            who = pb.evaluate("() => getComputedStyle(document.querySelector('.review-rail .rcard.k-draft')).borderLeftColor")
            exp = pb.evaluate("() => { const c = window.__doc.colorOf('홍길동'); const h = c.replace('#', ''); return `rgb(${parseInt(h.slice(0,2),16)}, ${parseInt(h.slice(2,4),16)}, ${parseInt(h.slice(4,6),16)})`; }")
            ok(who == exp, f'카드 왼쪽 띠 = a 의 사람 색 {exp}')
            # 카드 자리: 강조 y(편집기 iframe → 레일 좌표)에 두고, 겹치면 아래로 8px 간격(v0.2 말풍선 규칙)
            lay = pb.evaluate('''() => {
              window.__rail.layout();
              const rail = document.querySelector('.review-rail').getBoundingClientRect().top;
              const off = window.__doc.editor.anchorToPage({ x: 0, y: 0 }).y - rail;
              return window.__rail.cards().map((c) => ({ ...c, want: c.y + off - 6, h: document.querySelector(`.rail-slot[data-key="${CSS.escape(c.key)}"]`).offsetHeight }))
                .sort((a, b) => a.top - b.top); }''')
            ok(len(lay) >= 2 and abs(lay[0]['top'] - lay[0]['want']) <= 1, f"첫 카드 = 그 강조 높이(카드 {lay[0]['top']:.0f} · 강조 {lay[0]['want']:.0f})")
            ok(all(c['top'] >= c['want'] - 0.5 for c in lay), '카드는 자기 강조보다 위로 가지 않음')
            gaps = [lay[k + 1]['top'] - (lay[k]['top'] + lay[k]['h']) for k in range(len(lay) - 1)]
            ok(all(g >= 7.5 for g in gaps), f'겹치지 않고 8px 이상 간격 {[round(g) for g in gaps]}')
            # 카드 열쇠 = 덩어리 열쇠(종류 + 기준 자리 — 작성자가 더 고쳐 hid 가 바뀌어도 같은 카드), id = 플러그인 강조 id 'cid:hid'
            k1, k2 = f'{cid}:{hunks[0]["hid"]}', f'{cid}:{hunks[1]["hid"]}'
            pos = {c['id']: c for c in lay}
            ok(pos[k1]['key'] == f'draft:{cid}:replace:s0/p4' and pos[k2]['key'] == f'draft:{cid}:replace:s0/p5', f"수정 중 카드 열쇠 = 덩어리 열쇠 {pos[k1]['key']} · {pos[k2]['key']}")
            ok(abs(pos[k2]['top'] - (pos[k1]['top'] + pos[k1]['h'] + 8)) <= 1, f"이웃 문단의 두 카드는 바로 아래로 쌓임({pos[k1]['top']:.0f} → {pos[k2]['top']:.0f})")
            shot(pb, '01_b_rail')
            # hover ↔ 편집기 강조, 누르기 → 깜빡임
            card.first.locator('.rc-head').hover()
            wait_until(lambda: (doc_state(pb, 's.hover') or {}).get('kind') == 'draft', msg='hover → s.hover')
            wait_until(lambda: any(o['kind'] == 'draft' and 'cw-active' in o['cls'] for o in overlays(pb)), msg='편집기 강조(cw-active)')
            ok(True, '카드 hover → 편집기의 그 수정 중 표시가 진해짐(setActive)')
            card.first.locator('.rc-head').click()
            wait_until(lambda: (doc_state(pb, 's.active') or {}).get('id') == f'{cid}:{hunks[0]["hid"]}', msg='누름 → s.active')
            wait_until(lambda: any('cw-flash' in o['cls'] for o in overlays(pb)), timeout=5, msg='깜빡임(focusRange)')
            ok(True, '카드 누르기 → 편집기 그 자리 깜빡임(focusRange)')
            pb.mouse.move(5, 5)
            wait_until(lambda: doc_state(pb, 's.hover') is None, msg='hover 풀림')
            # 상단 막대 접속자 창: 내 역할은 한국어로
            pb.hover('[data-testid="presence"]')
            pop = pb.locator('.whopop')
            pop.wait_for(state='visible', timeout=3000)
            ok(pop.locator('.wp-me').inner_text().strip() == '(나 · 편집자)', f"접속자 창: 「김검토 {pop.locator('.wp-me').inner_text().strip()}」(역할 한국어)")
            pb.mouse.move(5, 5)

            print('[2] b: 변경 요청 탭에 a 의 초안 — 초안에는 승인할 수 없음(검토 요청 뒤에)', flush=True)
            tab(pb, 'cr')
            c1 = pb.locator(f'.cr-card[data-cid="{cid}"]')
            c1.wait_for(timeout=10000)
            t = text_of(c1)
            # 'v1에서 고침' = 사람용 버전(§9.4 CRView baseV — 올린 문서가 v1), 기록 번호가 아니다.
            # 초안 카드는 승인 수·0 인 의견을 쓰지 않는다(상태는 머리 알약 '초안' 하나 — docs/UI_TERMS.md §1)
            for part in [f'#{cid}', '홍길동', '초안', '문단 2', 'v1에서 고침']:
                ok(part in t, f'변경 요청 카드에 「{part}」')
            ok('승인 0' not in t and '의견 0' not in t and t.count('초안') == 1, f'초안 카드: 승인 0·의견 0·상태를 되풀이하지 않음 「{t[:80]}」')
            ok('다른 사람이 수정 중' in pb.locator('.cr-list').inner_text(), '남의 초안은 "다른 사람이 수정 중" 묶음')
            shot(pb, '02_b_crlist')
            c1.click()
            detd = pb.locator(f'.cr-detail[data-cid="{cid}"]')
            detd.wait_for(timeout=10000)
            apd = detd.locator('.cr-approve')
            wait_until(lambda: apd.count() == 1, msg='초안 상세의 [승인]')
            ok(apd.is_disabled() and apd.get_attribute('title') == '검토 요청 후 승인할 수 있습니다' and '검토 요청 후 승인할 수 있습니다' in detd.locator('.cr-reviewbox').inner_text(),
               '초안(검토 요청 전)에는 [승인] 막힘 · 설명 「검토 요청 후 승인할 수 있습니다」')
            ok(detd.locator('.cr-changes').inner_text().strip() == '수정 요청' and '변경 요청' not in detd.locator('.cr-reviewbox').inner_text(),
               "검토 판단 단추는 '수정 요청'(변경 요청은 이 변경 요청 자체의 이름)")
            shot(pb, '02b_b_draft_no_approve')
            detd.locator('.cr-top button:has-text("목록")').click()
            wait_until(lambda: pb.locator('.cr-detail').count() == 0, msg='목록으로')

            print('[3] a: [검토 요청] → 창(제목 기본값) → 검토 중', flush=True)
            open_doc(pa, did)
            wait_until(lambda: doc_state(pa, 's.myCr && s.myCr.cid') == cid, msg='a 의 내 변경 요청')
            ok(doc_state(pa, 'd.editor.source') == 'draft', 'a 의 편집기 = 내 수정본')
            pa.locator('[data-testid="submit-cr"]').click()
            dlg = pa.locator('.floatwin.cr-submit')
            dlg.wait_for(timeout=10000)
            ttl = dlg.locator('.cr-submit-title')
            wait_until(lambda: ttl.input_value() != '', msg='제목 기본값')
            ok(ttl.input_value() == '「4월부터」 수정 외 1곳', f'제목 기본값 = 첫 덩어리에서 바뀐 낱말(+ 나머지 곳 수) 「{ttl.input_value()}」')
            ttl.fill('')
            dlg.locator('.cr-submit-go').click(); time.sleep(0.3)
            ok(dlg.is_visible() and '제목을 적어 주세요' in dlg.inner_text(), '제목 없이 누르면 막고 안내')
            ttl.fill('일정·예산 고침')
            dlg.locator('.cr-submit-desc').fill('일정은 4월 시작, 예산은 2억 원으로')
            shot(pa, '03_a_submit')
            dlg.locator('.cr-submit-go').click()
            wait_until(lambda: rest(f'/api/docs/{did}/change-requests/{cid}')['status'] == 'open', msg='검토 요청 → open')
            v = rest(f'/api/docs/{did}/change-requests/{cid}')
            ok(v['title'] == '일정·예산 고침' and v['description'] == '일정은 4월 시작, 예산은 2억 원으로', '제목·설명 저장')
            wait_until(lambda: pa.locator('.floatwin.cr-submit').count() == 0, msg='창 닫힘')
            wait_until(lambda: pa.locator(f'.cr-detail[data-cid="{cid}"]').count() == 1, msg='a: 변경 요청 상세')
            ok(doc_state(pa, 's.tab') == 'cr', 'a: 변경 요청 탭에서 상세가 열림')
            chip0 = f'검토 중 #{cid} · 승인 0'
            wait_until(lambda: pa.locator('[data-testid="cr-chip"]').count() == 1 and pa.locator('[data-testid="cr-chip"]').inner_text().strip() == chip0, msg='상단 칩')
            ok(True, f'상단 칩 「{chip0}」')
            # 승인 없이 반영 → NEED_APPROVAL: 막힘 이유 줄이 이미 그 까닭을 보이므로 설명은 한 번만(실패 줄을 또 쓰지 않고 그 막힘 줄을 짚는다)
            deta0 = pa.locator(f'.cr-detail[data-cid="{cid}"]')
            wait_until(lambda: deta0.locator('.blocker[data-code="NEED_APPROVAL"]').count() == 1, msg='막힘: 승인 필요')
            need = deta0.locator('.blocker[data-code="NEED_APPROVAL"]').inner_text().replace('⚠', '').strip()
            deta0.locator('.cr-merge').click()
            wait_until(lambda: deta0.locator('.blocker[data-code="NEED_APPROVAL"].hit').count() == 1, msg='반영 실패 → 그 막힘 줄을 짚음')
            wait_until(lambda: not deta0.locator('.cr-merge').is_disabled(), msg='반영 끝')
            mbox = deta0.locator('.cr-mergebox').inner_text()
            ok(need and mbox.count(need) == 1 and deta0.locator('.cr-mergeerr .err').count() == 0 and rest(f'/api/docs/{did}/change-requests/{cid}')['status'] == 'open',
               f'승인 없이 반영 → 막힘 설명은 한 번만 「{need}」(실패 줄 없음, 그대로 검토 중)')

            print('[4] b: 덩어리에 의견(레일·상세) + 승인', flush=True)
            wait_until(lambda: '검토 중' in text_of(pb.locator(f'.cr-card[data-cid="{cid}"]')), msg='b 목록 = 검토 중(WS)')
            ok('검토 중' in pb.locator('.cr-list').inner_text().split('다른 사람이 수정 중')[0], '남의 검토 중 묶음')
            wait_until(lambda: '검토 중 #' in text_of(pb.locator('.review-rail .rcard.k-draft').first), msg='레일 카드 = 검토 중')
            # 레일 카드 [의견]
            rc = pb.locator('.review-rail .rcard.k-draft').first
            rc.locator('.rc-comment').click()
            rc.locator('.memoedit textarea').fill('4월 시작 근거가 있나요?')
            rc.locator('.memoedit button:has-text("의견 달기")').click()
            wait_until(lambda: len(rest(f'/api/docs/{did}/change-requests/{cid}')['threads']) == 1, msg='레일 카드 의견 → 스레드')
            th = rest(f'/api/docs/{did}/change-requests/{cid}')['threads'][0]
            ok(th['hid'] == hunks[0]['hid'] and th['comments'][0]['by'] == '김검토', f"스레드 = 그 덩어리({th['hid']}) · 김검토")
            # 작성자(a)에게: 남이 내 변경 요청에 의견을 닮 → 알림
            def a_toast(part):
                return wait_until(lambda: next((x for x in pa.locator('.toasts .toast').all_inner_texts() if part in x), None), timeout=10, msg=f'a 알림 「{part}」')
            ok(a_toast(f'김검토 님이 내 변경 요청 #{cid}에 의견을 달았습니다'), '작성자 a 에게 알림: 김검토 님이 내 변경 요청에 의견을 달았습니다')
            # [변경 보기] → 변경 요청 탭 상세(그 덩어리 강조)
            rc.locator('.rc-show').click()
            det = pb.locator(f'.cr-detail[data-cid="{cid}"]')
            det.wait_for(timeout=10000)
            ok(doc_state(pb, 's.tab') == 'cr', '[변경 보기] → 변경 요청 탭')
            wait_until(lambda: det.locator(f'.cr-hunk[data-hid="{hunks[0]["hid"]}"]').count() == 1, msg='상세 덩어리')
            wait_until(lambda: det.locator(f'.cr-hunk[data-hid="{hunks[0]["hid"]}"] .cr-thread').count() == 1, msg='상세에 의견 스레드')
            ok('4월 시작 근거가 있나요?' in det.locator(f'.cr-hunk[data-hid="{hunks[0]["hid"]}"]').inner_text(), '덩어리 아래 의견 글')
            ok(det.locator('.cr-hunk').count() == 2 and det.locator('.cr-hunk ins').count() >= 2, '덩어리 2개 · 글자 차이(ins)')
            # 상세에서 둘째 덩어리에 의견
            h2 = det.locator(f'.cr-hunk[data-hid="{hunks[1]["hid"]}"]')
            h2.locator('button:text-is("의견")').click()
            ta2 = h2.locator('.memoedit textarea')
            ta2.fill('예산 증액 사유를 설명에 적어 주세요')
            # Ctrl+Enter 를 두 번 빨리 눌러도 한 번만 보낸다(보내는 동안 칸이 막힘) — 키는 포커스로 보낸다(칸이 닫혀도 시험이 기다리지 않게)
            ta2.focus(); pb.keyboard.press('Control+Enter'); pb.keyboard.press('Control+Enter')
            wait_until(lambda: len(rest(f'/api/docs/{did}/change-requests/{cid}')['threads']) == 2, msg='상세 의견 → 스레드 2')
            wait_until(lambda: h2.locator('.cr-thread').count() == 1, msg='상세에 둘째 스레드')
            time.sleep(0.8)
            ok(len(rest(f'/api/docs/{did}/change-requests/{cid}')['threads']) == 2 and h2.locator('.memoedit').count() == 0, '상세 의견 칸 Ctrl+Enter 두 번 → 스레드 하나만 · 칸 닫힘')
            # 답글 + 완료(스레드 — 서버 resolve)
            t1 = det.locator(f'.cr-hunk[data-hid="{hunks[0]["hid"]}"] .cr-thread').first
            t1.locator('button:has-text("답글")').click()
            t1.locator('.memoedit textarea').fill('공고 일정이 4월로 바뀌었습니다')
            t1.locator('.memoedit button:has-text("답글 달기")').click()
            wait_until(lambda: len(rest(f'/api/docs/{did}/change-requests/{cid}')['threads'][0]['comments']) == 2, msg='스레드 답글')
            wait_until(lambda: '공고 일정이 4월로' in t1.inner_text(), msg='답글이 보임')
            t1.locator('button:has-text("완료")').click()
            wait_until(lambda: rest(f'/api/docs/{did}/change-requests/{cid}')['threads'][0]['resolved'] is not None, msg='스레드 완료')
            wait_until(lambda: '다시 열기' in t1.inner_text(), msg='완료 → [다시 열기]')
            ok(True, '의견 스레드 답글·완료')
            # 수정 요청(검토 판단 'changes' 의 이름 — 서버·한글 메모와 같다) → 작성자에게 알림 · 상단 칩 수
            det.locator('.cr-reviewbox textarea').fill('예산 근거를 설명에 덧붙여 주세요')
            det.locator('.cr-changes').click()
            wait_until(lambda: '수정을 요청했습니다' in pb.locator('.toasts').inner_text(), msg="b 알림 '수정을 요청했습니다'")
            wait_until(lambda: rest(f'/api/docs/{did}/change-requests/{cid}')['changesRequested'] == 1, msg='수정 요청 1')
            wait_until(lambda: det.locator('.cr-review[data-verdict="changes"]').count() == 1 and '수정 요청 1' in det.locator('.cr-meta').first.inner_text(), msg='검토 목록·수에 수정 요청')
            ok(det.locator('.cr-review[data-verdict="changes"] .pill').inner_text().strip() == '수정 요청',
               "b: [수정 요청] → 알림 '수정을 요청했습니다' · 검토 목록 '수정 요청' · 수 '수정 요청 1'")
            ok(a_toast(f'김검토 님이 내 변경 요청 #{cid}에 수정을 요청했습니다'), '작성자 a 에게 알림: 수정을 요청했습니다')
            chip1 = f'검토 중 #{cid} · 승인 0 · 수정 요청 1 · 의견 2'
            wait_until(lambda: pa.locator('[data-testid="cr-chip"]').inner_text().strip() == chip1, msg='a 칩: 수정 요청 1 · 의견 2')
            ok(True, f'작성자 a 상단 칩 「{chip1}」')
            # 승인
            ok(det.locator('.cr-approve').count() == 1 and det.locator('.cr-approve').is_enabled(), '남(b)에게는 [승인] 단추(검토 중 — 누를 수 있음)')
            det.locator('.cr-reviewbox textarea').fill('좋습니다')
            det.locator('.cr-approve').click()
            wait_until(lambda: rest(f'/api/docs/{did}/change-requests/{cid}')['approvals'] == 1, msg='승인 1')
            wait_until(lambda: det.locator('.cr-review[data-verdict="approve"]').count() == 1, msg='검토 목록에 승인')
            ok(det.locator('.cr-review[data-verdict="approve"] .pill').inner_text().strip() == '승인' and '수정 요청' not in det.locator('.cr-meta').first.inner_text(),
               '승인 → 검토 목록 승인 · 김검토의 마지막 판단이 승인이라 수정 요청 수 없어짐')
            ok(det.locator('.cr-mergebox').count() == 0, 'b(작성자·관리자 아님)에게는 반영 단추 없음')
            ta3 = wait_until(lambda: next((x for x in pa.locator('.toasts .toast').all_inner_texts() if f'김검토 님이 내 변경 요청 #{cid}' in x and '승인했습니다' in x), None), timeout=10, msg='a 승인 알림')
            ok('(를)' not in ta3, f'작성자 a 에게 알림 「{ta3}」(조사 골라 씀)')
            chip2 = f'검토 중 #{cid} · 승인 1 · 의견 2'
            wait_until(lambda: pa.locator('[data-testid="cr-chip"]').inner_text().strip() == chip2, msg='a 칩: 승인 1')
            ok(True, f'작성자 a 상단 칩 「{chip2}」')
            shot(pb, '04_b_review')

            print('[5] a: 반영(merge) → 변경 추적 탭에 교체 묶음', flush=True)
            deta = pa.locator(f'.cr-detail[data-cid="{cid}"]')
            wait_until(lambda: '승인 1' in deta.locator('.cr-meta').first.inner_text(), msg='a 상세에 승인 1(WS)')
            ok(deta.locator('.cr-approve').count() == 0 and deta.locator('.cr-changes').count() == 0 and deta.locator('.cr-comment').count() == 1
               and '작성자는 의견만' in deta.inner_text(), '작성자에게는 [승인]·[수정 요청] 없음 — [의견만]은 있음(「작성자는 의견만」)')
            # [3] 에서 승인 없이 눌러 본 반영 실패(NEED_APPROVAL) 줄은 승인으로 막힘이 풀리면 지운다 — '반영할 수 있음'과 같이 보이면 안 됨
            ok(deta.locator('.cr-merge').count() == 1 and deta.locator('.cr-mergebox .blocker').count() == 0 and deta.locator('.cr-mergeerr').count() == 0,
               '반영 막힘 없음 · [3] 의 반영 실패 줄(승인 필요)도 승인 뒤에는 사라짐')
            shot(pa, '05_a_before_merge')
            # b 는 레일 메모 카드에 답글을 쓰는 중 — a 가 반영하면 b 의 편집기가 새 기준으로 다시 열린다(카드·쓰던 글은 남아야 함)
            m0 = next(x for x in rest(f'/api/docs/{did}/memos', token=B['token']) if x['ref'] == 's0/p0')
            m0c = pb.locator(f'.review-rail .rcard[data-id="{m0["id"]}"]')
            wait_until(lambda: m0c.count() == 1 and pb.locator(f'.review-rail .rail-slot.placed .rcard[data-id="{m0["id"]}"]').count() == 1, msg='b 레일: s0/p0 메모 카드')
            m0c.locator('.rc-reply').click()
            m0c.locator('.memoedit textarea').fill('반영되는 동안 쓰던 답글')
            # 사람용 버전(§9.4): 상단 막대는 v1(올림) — 메모·스레드 같은 기록은 버전을 올리지 않는다
            vpa, vpb = pa.locator('[data-testid="version-pill"]'), pb.locator('[data-testid="version-pill"]')
            ok(vpa.inner_text().strip() == 'v1' and vpb.inner_text().strip() == 'v1', f'반영 전 상단 버전 v1(a {vpa.inner_text().strip()} · b {vpb.inner_text().strip()})')
            deta.locator('.cr-merge').click()
            wait_until(lambda: rest(f'/api/docs/{did}/change-requests/{cid}')['status'] == 'merged', msg='반영됨')
            v1 = rest(f'/api/docs/{did}')['version']
            ok(v1 == v0 + 1, f'기준 문서 새 기록(내부 판 {v1})')
            info5 = rest(f'/api/docs/{did}')
            ok(info5['milestone']['v'] == 2 and info5['milestone']['kind'] == 'merge', f"서버 이정표 v{info5['milestone']['v']}({info5['milestone']['kind']})")
            wait_until(lambda: vpa.inner_text().strip() == 'v2' and vpb.inner_text().strip() == 'v2', timeout=15, msg='상단 v2')
            tip = vpa.get_attribute('title') or ''
            ok('버전 v2' in tip and f'변경 요청 #{cid} 반영' in tip and '이력 탭' in tip, f'상단 v1 → 변경 요청 반영 뒤 v2 · 설명 「{tip}」')
            tm = wait_until(lambda: next((x for x in pa.locator('.toasts .toast').all_inner_texts() if f'변경 요청 #{cid}' in x and '반영했습니다' in x), None), timeout=10, msg='a 반영 알림')
            ok('(v2)' in tm, f'반영 알림에 사람용 버전 「{tm}」')
            wait_until(lambda: doc_state(pb, 'd.editor.ready && d.editor.baseVersion') == v1, timeout=30, msg='b 편집기 = 새 기준으로 다시 엶')
            time.sleep(0.5)
            ok(m0c.count() == 1 and m0c.locator('.memoedit textarea').input_value() == '반영되는 동안 쓰던 답글', 'b 편집기를 새 기준으로 다시 열어도 답글 칸 · 쓰던 글 그대로')
            m0c.locator('.memoedit button:has-text("취소")').click()
            wait_until(lambda: m0c.locator('.memoedit').count() == 0, msg='답글 칸 닫음')
            texts = {x['ref']: x['text'] for x in rest(f'/api/docs/{did}/paragraphs')}
            ok('4월부터' in texts['s0/p4'] and '2억 원' in texts['s0/p5'], '기준 문서에 a 의 글')
            wait_until(lambda: '반영됨' in deta.inner_text(), msg='상세 = 반영됨')
            ok('v2로 반영됨' in deta.locator('.cr-foot').inner_text(), f"반영된 변경 요청 = 'v2로 반영됨'(사람용 버전 mergedV) 「{deta.locator('.cr-foot').inner_text().strip()[:40]}」")
            wait_until(lambda: doc_state(pa, 'd.editor.ready && d.editor.source') == 'working', timeout=30, msg='a 편집기 = 새 기준')
            # 반영된 변경 요청도 그 문단이 지금 기준에 있으면 [편집기에서 보기] → 편집기 그 자리(깜빡임)
            vb = deta.locator('.cr-hunk').first.locator('button.cr-view')
            wait_until(lambda: vb.is_enabled(), timeout=15, msg='반영된 변경 요청: [편집기에서 보기]')
            vb.click()
            wait_until(lambda: any('cw-flash' in o['cls'] for o in overlays(pa)), timeout=5, msg='편집기 그 자리 깜빡임')
            ok(True, '반영된 변경 요청 — 그 문단이 지금 기준에 있으면 [편집기에서 보기] → 편집기 그 자리')
            tab(pa, 'change')
            pairs = pa.locator('.card.chg.pair')
            wait_until(lambda: pairs.count() == 2, msg='교체 묶음 2개')
            g = text_of(pairs.first)
            ok('교체' in g and '홍길동' in g and '3' in pairs.first.locator('del').inner_text() and '4' in pairs.first.locator('ins').inner_text(), f'교체 묶음: {g[:70]}')
            ch = rest(f'/api/docs/{did}/changes')
            ok(len(ch) == 4 and all(c['author'] == '홍길동' for c in ch), f'변경 추적 4개(삭제·삽입 쌍 2) — 작성자 = 변경 요청 작성자')
            shot(pa, '06_a_changes')
            # 한 묶음(교체) 거절 → 둘 다 빠짐(글이 지워진 채 남지 않음)
            pairs.nth(1).locator('.chg-reject').click()
            wait_until(lambda: len(rest(f'/api/docs/{did}/changes')) == 2, msg='교체 한 묶음 거절')
            texts = {x['ref']: x['text'] for x in rest(f'/api/docs/{did}/paragraphs')}
            ok('1억 원' in texts['s0/p5'] and '2억' not in texts['s0/p5'], '교체를 함께 거절 → 원래 글(1억 원)')
            wait_until(lambda: pa.locator('.card.chg.pair').count() == 1, msg='묶음 1개 남음')
            # b 의 레일: 수정 중 카드가 사라짐(반영됨)
            wait_until(lambda: pb.locator('.review-rail .rcard.k-draft').count() == 0, timeout=30, msg='b 레일의 수정 중 카드 사라짐')
            ok(True, '반영 뒤 b 레일의 수정 중 카드 사라짐')

            print('[5b] 이력 탭: v2 이후 변경 이력 → [버전 저장](한 줄 메모) → v3 · 남(b)에게 알림 · 버전 목록·내려받기 이름(기록 번호 없음)', flush=True)
            vpa.click()   # 상단 버전 알약 → 이력 탭
            wait_until(lambda: doc_state(pa, 's.tab') == 'history', msg='알약 → 이력 탭')
            info6 = rest(f'/api/docs/{did}')
            since6 = info6['sinceMilestone']
            hs = pa.locator('.tab-history .hist-since')
            wait_until(lambda: hs.count() == 1 and hs.inner_text().strip() == f'v2 이후 변경 이력 {since6}개', msg='이력 맨 위 줄')
            ok(since6 >= 1, f"맨 위 「{hs.inner_text().strip()}」(교체 거절이 기록을 만들었지만 버전은 그대로)")
            hv = pa.locator('.tab-history .hist-v')
            ok([hv.nth(i).get_attribute('data-v') for i in range(hv.count())] == ['2', '1'], '버전 목록 v 내림차순(v2 · v1)')
            ok(f'변경 요청 #{cid} 반영' in hv.nth(0).locator('.head').inner_text() and hv.nth(0).locator('.hist-restore').count() == 1 and hv.nth(0).locator('.head .pill.ok').count() == 0,
               'v2 = 변경 요청 반영 · 지금이 아니라 [이 버전으로 복구] 있음(그 뒤 기록이 있음)')
            pa.locator('.tab-history .hist-top .hist-recs summary').click()
            ok(pa.locator('.tab-history .hist-top .hist-rec').count() == since6, f'v2 이후 변경 이력 {since6}개 펼침')
            rows6 = [x.strip() for x in pa.locator('.tab-history .hist-top .hist-rec').all_inner_texts()]
            ok(rows6 and all(re.match(r'\d\d-\d\d \d\d:\d\d\s*·', x) and not re.search(r'\bv\d', x) for x in rows6), f'변경 이력 줄 = 시각 · 누가 · 무엇(기록 번호 없음) {rows6[:2]}')
            shot(pa, '05b_history')
            pa.locator('.tab-history .hist-save').click()
            pa.locator('.tab-history .hist-note').fill('1차 검토 반영')
            pa.locator('.tab-history .hist-save-go').click()
            wait_until(lambda: (rest(f'/api/docs/{did}/history')['milestones'] or [{}])[-1].get('v') == 3, msg='버전 저장')
            m3 = rest(f'/api/docs/{did}/history')['milestones'][-1]
            ok(m3['kind'] == 'manual' and m3['note'] == '1차 검토 반영' and m3['by'] == A['name'], f"POST /milestones → v3(manual, 「{m3['note']}」, {m3['by']})")
            wait_until(lambda: vpa.inner_text().strip() == 'v3' and vpb.inner_text().strip() == 'v3', timeout=10, msg='상단 v3(a·b)')
            ok(True, '[버전 저장] → 상단 v3(b 도 WS doc milestone 으로)')
            tb3 = wait_until(lambda: next((x for x in pb.locator('.toasts .toast').all_inner_texts() if '버전 v3' in x), None), timeout=10, msg='b 알림')
            ok(tb3 == f'{A["name"]} 님이 버전 v3을 저장했습니다', f'남(b)에게 알림 「{tb3}」')
            wait_until(lambda: hs.inner_text().strip() == 'v3 이후 바뀐 것 없음' and pa.locator('.tab-history .hist-save').is_disabled(), msg='바뀐 것 없음 → [버전 저장] 꺼짐')
            h3 = pa.locator('.tab-history .hist-v[data-v="3"]')
            ok(h3.locator('.head .pill.ok').inner_text().strip() == '지금' and h3.locator('.hist-restore').count() == 0 and '1차 검토 반영' in h3.locator('.head').inner_text(), 'v3 = 지금(복구 단추 없음) · 한 줄 메모')
            with pa.expect_download(timeout=30000) as dli:
                h3.locator('.hist-dl').click()
            ok(dli.value.suggested_filename == '협업시험_v3.hwpx', f'내려받기 이름 {dli.value.suggested_filename}(버전 — 기록 번호 아님)')
            shot31(pa, 'history_saved')
            tab(pa, 'cr')

            print('[6] 메모 스레드: API 메모 → 레일 카드 답글·해결 → 검토 탭 해결됨', flush=True)
            m = rest(f'/api/docs/{did}/memos', 'POST', {'ref': 's0/p6', 'start': 0, 'end': 5, 'text': '기대 효과에 수치를 넣어 주세요'}, token=ADMIN['token'])
            mid = m['id']
            mc = pb.locator(f'.review-rail .rcard.k-memo[data-id="{mid}"]')
            wait_until(lambda: mc.count() == 1, timeout=30, msg='레일 메모 카드')
            # 자리를 잡기 전(visibility:hidden)에는 innerText 가 빈 글 — 글이 보일 때까지 기다린다
            wait_until(lambda: '기대 효과에 수치를' in text_of(mc), msg='메모 카드 글(자리 잡음)')
            t = text_of(mc)
            ok('관리자' in t and '기대 효과에 수치를' in t, f'메모 카드: {t[:50]}')
            ok(mc.locator('button[aria-label="메모 삭제"]').count() == 0, '남(관리자)의 메모는 b 가 지울 수 없음(삭제 단추 없음)')
            mc.locator('.rc-reply').click()
            mc.locator('.memoedit textarea').fill('2025년 응답률을 넣겠습니다')
            mc.locator('.memoedit button:has-text("답글 달기")').click()
            def memo():
                return next(x for x in rest(f'/api/docs/{did}/memos', token=B['token']) if x['id'] == mid)
            wait_until(lambda: len(memo()['thread']['replies']) == 1, msg='메모 답글 저장')
            ok(memo()['thread']['replies'][0]['by'] == '김검토', '답글 작성자 = 김검토')
            wait_until(lambda: '2025년 응답률을 넣겠습니다' in mc.inner_text(), msg='카드에 답글')
            ok('── 답글' in memo()['text'], '한글 메모 글에도 답글 블록')
            shot(pb, '07_memo_thread')
            mc.locator('.rc-resolve').click()
            wait_until(lambda: memo()['thread']['resolved'] is not None, msg='메모 해결')
            wait_until(lambda: pb.locator(f'.review-rail .rcard.k-memo[data-id="{mid}"]').count() == 0, msg='해결된 메모는 레일에서 빠짐')
            ok(True, '해결 → 레일·편집기 강조에서 빠짐')
            tab(pb, 'review')
            ok(pb.locator(f'.rt-list .rcard[data-id="{mid}"]').count() == 0, '검토 탭 "전체"에는 해결된 메모가 없음')
            pb.locator('.rt-filters [data-filter="resolved"]').click(); time.sleep(0.2)
            rv = pb.locator(f'.rt-list .rcard.k-memo[data-id="{mid}"]')
            ok(rv.count() == 1 and '✓ 완료' in rv.inner_text() and '2025년 응답률' in rv.inner_text() and rv.locator('.rc-resolve').inner_text().strip() == '다시 열기',
               '검토 탭 "완료"에 그 메모(답글·✓ 완료 표시 · [다시 열기])')
            rv.locator('.rc-resolve').click()
            wait_until(lambda: memo()['thread']['resolved'] is None, msg='다시 열기')
            wait_until(lambda: pb.locator(f'.review-rail .rcard.k-memo[data-id="{mid}"]').count() == 1, msg='다시 열면 레일에 다시')
            ok(True, '해결됨 → [다시 열기] → 레일에 다시')
            pb.locator('.rt-filters [data-filter="all"]').click(); time.sleep(0.2)
            items = pb.locator('.rt-list .rcard')
            n = items.count()
            ok(n >= 2, f'검토 탭 전체 {n}건(문서 순서)')
            refs = [items.nth(i).get_attribute('data-ref') for i in range(n)]
            key = lambda r: [int(x) for x in r.replace('s', '').replace('p', '').replace('n', '').split('/')]
            ok(refs == sorted(refs, key=key), f'문서 순서 {refs}')
            pb.locator('.rt-nav .nav-next').click()
            wait_until(lambda: pb.locator('.rt-list .rcard.pinned').count() == 1, msg='↓ 다음 = 첫 항목')
            first_key = pb.locator('.rt-list .rcard.pinned').get_attribute('data-key')
            ok(first_key == items.nth(0).get_attribute('data-key') and '1 / ' in pb.locator('.rt-pos').inner_text(), '↓ 다음 → 첫 항목(1 / n)')
            wait_until(lambda: any('cw-flash' in o['cls'] for o in overlays(pb)), timeout=5, msg='↓ → 편집기 깜빡임')
            pb.locator('.rt-nav .nav-prev').click(); time.sleep(0.2)
            ok(pb.locator('.rt-list .rcard.pinned').get_attribute('data-key') == items.nth(n - 1).get_attribute('data-key'), '↑ 이전 → 마지막 항목(돌아감)')
            shot(pb, '08_review_tab')

            print('[6b] 남의 수정 중: 작성자가 더 고쳐 저장해도(hid 바뀜) 의견 칸·쓰던 글·고름·스레드가 그 덩어리에', flush=True)
            # 순수 도우미(브라우저에서 같은 모듈): 덩어리 열쇠 · 옛 hid NO_HUNK → 다시 읽어 한 번 더 / 덩어리가 없어지면 hid 없이 · 스레드 붙이기
            u = pb.evaluate('''async () => {
              const m = await import('/crs.js');
              const out = {};
              out.keys = m.hunkKeys([{ type: 'replace', ref: 's0/p1' }, { type: 'insert', afterRef: 's0/p1', ref: 's0/p1' }, { type: 'insert', afterRef: 's0/p1', ref: 's0/p1' }, { type: 'insert', afterRef: null, ref: 's0/p0' }, { type: 'delete', ref: 's0/p2' }]);
              const hOld = { hid: 'hOLD', type: 'replace', ref: 's0/p3', curRef: 's0/p3', baseText: '가나', newText: '가나다' };
              const hNew = { ...hOld, hid: 'hNEW', newText: '가나다라' };
              const calls = [];
              const fake = (fresh) => ({ s: { crs: [{ cid: 9, status: 'open', hunks: [hOld] }] },
                addThread: async (cid, b) => { calls.push(b); if (b.hid && b.hid !== 'hNEW') throw Object.assign(new Error('no'), { code: 'NO_HUNK' }); return { ok: true }; },
                crDetail: async () => ({ cid: 9, hunks: fresh ? [hNew] : [] }) });
              await m.addHunkThread(fake(true), 9, 'replace:s0/p3', hOld, '의견');
              out.case1 = calls.map((b) => b.hid || null);
              calls.length = 0;
              await m.addHunkThread(fake(false), 9, 'replace:s0/p3', hOld, '의견');
              out.case2 = calls.map((b) => b.hid || null); out.case2ref = calls[calls.length - 1].ref; out.case2text = calls[calls.length - 1].text;
              // 셸용 addThreadByHid: 아는 hid → 덩어리 열쇠로(case1 과 같게), 모르는 hid → hid 없이 자리·인용만
              calls.length = 0;
              await m.addThreadByHid(fake(true), 9, 'hOLD', '의견');
              out.case3 = calls.map((b) => b.hid || null);
              calls.length = 0;
              await m.addThreadByHid(fake(true), 9, 'hUNKNOWN', '의견', { ref: 's0/p3', quote: '인용' });
              out.case4 = calls.map((b) => [b.hid || null, b.ref || null, b.quote || null]);
              const cr = { cid: 9, hunks: [{ hid: 'a1', type: 'replace', ref: 's0/p1', curRef: 's0/p1', baseText: '하나', newText: '하나 고침' }, { hid: 'a2', type: 'insert', ref: 's0/p1', afterRef: 's0/p1', curRef: 's0/p1', baseText: '', newText: '새 문단 글' }],
                threads: [{ tid: 1, hid: 'zz', ref: 's0/p1', quote: '새 문단' }, { tid: 2, hid: 'a1', ref: 's0/p1' }, { tid: 3, hid: null, ref: null }, { tid: 4, hid: 'yy', ref: 's9/p9' }] };
              const tb = m.threadsByHunk({}, cr);
              out.tb = Object.fromEntries([...tb.byKey].map(([k, v]) => [k, v.map((t) => t.tid)])); out.general = tb.general.map((t) => t.tid);
              return out;
            }''')
            ok(u['keys'] == ['replace:s0/p1', 'insert:s0/p1', 'insert:s0/p1#1', 'insert:^', 'delete:s0/p2'], f"덩어리 열쇠 = 종류 + 기준 자리(+ 같은 자리 차례) {u['keys']}")
            ok(u['case1'] == ['hOLD', 'hNEW'], f"옛 hid 로 NO_HUNK → 변경 요청을 다시 읽어 새 hid 로 한 번 더 {u['case1']}")
            ok(u['case2'] == ['hOLD', None] and u['case2ref'] == 's0/p3' and u['case2text'] == '의견', f"덩어리가 없어졌으면 hid 없이 자리·인용만(의견을 잃지 않음) {u['case2']}")
            ok(u['case3'] == ['hOLD', 'hNEW'] and u['case4'] == [[None, 's0/p3', '인용']], f"셸용 addThreadByHid: 아는 hid {u['case3']} · 모르는 hid {u['case4']}")
            ok(u['tb'] == {'replace:s0/p1': [2], 'insert:s0/p1': [1]} and u['general'] == [3, 4], f"스레드 붙이기: 같은 hid · 옛 hid 는 같은 자리에서 인용이 겹치는 덩어리 {u['tb']} · 전체 {u['general']}")

            def admin_draft(to):
                return node_helper(['draft', '--base', REST, '--doc', did, '--edits', json.dumps([{'ref': 's0/p3', 'from': '사업 개요', 'to': to}], ensure_ascii=False)], token=ADMIN['token'])['cr']
            cidx = admin_draft('사업 개요(1차)')['cid']
            dc = pb.locator(f'.review-rail .rcard.k-draft[data-key="draft:{cidx}:replace:s0/p3"]')
            wait_until(lambda: dc.count() == 1 and '(1차)' in text_of(dc), timeout=30, msg='관리자 수정 중 카드')
            id0 = dc.get_attribute('data-id')
            dc.locator('.rc-comment').click()
            tax = dc.locator('.memoedit textarea')
            tax.fill('괄호 표기는 빼 주세요')
            ok(doc_state(pb, 's.active && s.active.id') == id0, '의견 칸을 열면 그 카드를 고름(편집기 강조·레일 고정)')
            admin_draft('사업 개요(2차)')
            wait_until(lambda: dc.get_attribute('data-id') != id0 and '(2차)' in text_of(dc), timeout=20, msg='작성자 저장 → 새 hid')
            id1 = dc.get_attribute('data-id')
            ok(dc.count() == 1 and tax.count() == 1 and tax.input_value() == '괄호 표기는 빼 주세요', f'hid 가 바뀌어도({id0} → {id1}) 같은 카드 · 의견 칸 · 쓰던 글 그대로')
            wait_until(lambda: doc_state(pb, 's.active && s.active.id') == id1, msg='고른 덩어리 → 새 hid(편집기 강조가 따라감)')
            ok('active' in (dc.get_attribute('class') or ''), '카드는 여전히 고른 상태(펼침)')
            tax.focus(); pb.keyboard.press('Control+Enter'); pb.keyboard.press('Control+Enter')
            wait_until(lambda: len(rest(f'/api/docs/{did}/change-requests/{cidx}', token=B['token'])['threads']) >= 1, msg='의견 저장')
            wait_until(lambda: dc.locator('.memoedit').count() == 0, msg='보내면 칸 닫힘')
            time.sleep(0.8)
            vx = rest(f'/api/docs/{did}/change-requests/{cidx}', token=B['token'])
            ok(len(vx['threads']) == 1 and vx['threads'][0]['hid'] == vx['hunks'][0]['hid'], f"Ctrl+Enter 두 번 → 의견 하나 · 지금 hid({vx['hunks'][0]['hid']})로(NO_HUNK 없음)")
            wait_until(lambda: '의견 1' in text_of(dc), msg='카드에 의견 1')
            admin_draft('사업 개요(3차)')
            wait_until(lambda: '(3차)' in text_of(dc), timeout=20, msg='작성자 다시 저장')
            ok('의견 1' in text_of(dc), '또 저장해 hid 가 바뀌어도 그 스레드가 카드에 붙어 있음(의견 1)')
            dc.locator('.rc-show').click()
            detx = pb.locator(f'.cr-detail[data-cid="{cidx}"]')
            detx.wait_for(timeout=10000)
            wait_until(lambda: detx.locator('.cr-hunk .cr-thread').count() == 1, msg='상세: 덩어리 아래 스레드')
            ok('전체 의견 0' in text_of(detx), '옛 hid 스레드가 "전체 의견"으로 떨어지지 않음')
            hx = detx.locator('.cr-hunk').first
            hx.locator('button:text-is("의견")').click()
            hx.locator('.memoedit textarea').fill('상세에서 쓰는 중')
            admin_draft('사업 개요(4차)')
            wait_until(lambda: '(4차)' in text_of(detx), timeout=20, msg='상세 다시 읽음')
            ok(hx.locator('.memoedit textarea').input_value() == '상세에서 쓰는 중', '상세 덩어리 의견 칸·쓰던 글도 그대로(덩어리 열쇠)')
            tab(pb, 'ai'); tab(pb, 'cr')
            detx = pb.locator(f'.cr-detail[data-cid="{cidx}"]')
            detx.wait_for(timeout=10000)
            ok(detx.locator('.cr-hunk .memoedit textarea').input_value() == '상세에서 쓰는 중', '탭을 옮겼다 와도 상세 의견 칸·글 그대로')
            detx.locator('.cr-hunk .memoedit button:has-text("의견 달기")').click()
            wait_until(lambda: len(rest(f'/api/docs/{did}/change-requests/{cidx}', token=B['token'])['threads']) == 2, msg='상세 의견')
            vx = rest(f'/api/docs/{did}/change-requests/{cidx}', token=B['token'])
            ok(vx['threads'][1]['hid'] == vx['hunks'][0]['hid'], '상세 의견도 지금 hid 로')
            shot(pb, '08b_draft_rehid')
            rest(f'/api/docs/{did}/drafts/mine', 'DELETE', token=ADMIN['token'])
            wait_until(lambda: pb.locator('.review-rail .rcard.k-draft').count() == 0, msg='관리자 수정본 버림 → 카드 사라짐')
            wait_until(lambda: pb.locator('.cr-detail').count() == 0 or '지워졌' in text_of(pb.locator('.cr-detail')), msg='상세 = 지워짐')
            if pb.locator('.cr-detail').count():
                pb.locator('.cr-detail .cr-top button:has-text("목록")').click(); time.sleep(0.2)

            print('[6c] 긴 문서: 답글을 쓰다가 편집기를 스크롤해도 카드·쓰던 글이 레일에 남음', flush=True)
            longd = node_helper(['build', '--out', os.path.join(tmp, 'long_doc.hwpx'), '--filler', '80'])
            with open(longd['out'], 'rb') as f:
                did_l = rest('/api/docs', 'POST', f.read(), {'x-file-name': urllib.parse.quote('긴문서.hwpx'), 'Content-Type': 'application/octet-stream'}, raw=True, token=ADMIN['token'])['id']
            ml = rest(f'/api/docs/{did_l}/memos', 'POST', {'ref': 's0/p3', 'start': 0, 'end': 3, 'text': '스크롤 시험 메모'}, token=ADMIN['token'])
            ml2 = rest(f'/api/docs/{did_l}/memos', 'POST', {'ref': 's0/p5', 'start': 0, 'end': 3, 'text': '칸 없는 메모'}, token=ADMIN['token'])
            open_doc(pb, did_l)
            lk = f'memo:{ml["id"]}'
            lc = pb.locator(f'.review-rail .rcard.k-memo[data-id="{ml["id"]}"]')
            lc2 = pb.locator(f'.review-rail .rcard.k-memo[data-id="{ml2["id"]}"]')
            wait_until(lambda: '스크롤 시험' in text_of(lc) and lc2.count() == 1, timeout=30, msg='긴 문서 메모 카드')
            lc.locator('.rc-reply').click()
            lc.locator('.memoedit textarea').fill('스크롤 전에 쓰던 답글')

            def scroll_to(expr):
                pb.evaluate(f"() => {{ const c = window.__doc.editor.frame().contentDocument.getElementById('scroll-container'); c.scrollTop = {expr}; }}")

            def rail_card(key):
                return next((c for c in pb.evaluate('() => window.__rail.cards()') if c['key'] == key), None)

            def in_rail(key):
                return pb.evaluate(f'''() => {{ const r = document.querySelector('.review-rail').getBoundingClientRect();
                  const s = document.querySelector('.rail-slot[data-key="{key}"]'); if (!s) return null; const c = s.getBoundingClientRect();
                  return c.top >= r.top - 1 && c.bottom <= r.bottom + 1; }}''')
            # 조금 내림: 강조가 편집기 위로 나감(같은 쪽이라 자리는 있음) → 카드는 레일 맨 위에 붙고 ↑ 표시
            scroll_to('c.scrollTop + 420')
            wait_until(lambda: (rail_card(lk) or {}).get('edge') == 'up', timeout=10, msg='레일 위 끝에 붙음(↑)')
            ok(in_rail(lk) and pb.locator(f'.rail-slot[data-key="{lk}"] .rail-edge').inner_text() == '↑', '강조가 위로 나가도 입력 중 카드는 레일 안(위 끝, ↑ 표시)')
            # 멀리 내림: 그 쪽이 안 보임(강조 자리 없음) → 칸 없는 카드는 빠지고 입력 칸이 열린 카드는 남음
            scroll_to('c.scrollHeight * 0.7')
            wait_until(lambda: lc2.count() == 0, timeout=10, msg='멀리 스크롤 → 칸 없는 카드는 빠짐')
            time.sleep(0.4)
            ok(lc.count() == 1 and (rail_card(lk) or {}).get('sticky') is True and in_rail(lk), '입력 칸이 열린 카드는 강조 자리가 없어도 레일 안에 남음')
            ok(lc.locator('.memoedit textarea').input_value() == '스크롤 전에 쓰던 답글', '쓰던 답글 그대로')
            ok(pb.locator(f'.rail-slot[data-key="{lk}"] .rail-edge').count() == 1, '자리가 화면 밖이라는 표시')
            shot(pb, '08c_sticky_card')
            scroll_to('0')
            wait_until(lambda: lc2.count() == 1 and (rail_card(lk) or {}).get('sticky') is False and not (rail_card(lk) or {}).get('edge'), timeout=10, msg='다시 위로 → 강조 자리에')
            ok(lc.locator('.memoedit textarea').input_value() == '스크롤 전에 쓰던 답글', '다시 위로: 같은 칸 · 같은 글')
            lc.locator('.memoedit textarea').focus(); pb.keyboard.press('Control+Enter'); pb.keyboard.press('Control+Enter')
            wait_until(lambda: lc.locator('.memoedit').count() == 0, msg='보내면 칸 닫힘')
            time.sleep(0.8)
            reps = next(x for x in rest(f'/api/docs/{did_l}/memos', token=B['token']) if x['id'] == ml['id'])['thread']['replies']
            ok([r['text'] for r in reps] == ['스크롤 전에 쓰던 답글'], f'Ctrl+Enter 두 번 → 답글 하나({len(reps)}개)')
            open_doc(pb, did)

            print('[7] AI 작업 탭: 연결 없음 — 보낼 곳 · ?(설명서) · 프롬프트 복사(docs/UI_TERMS.md)', flush=True)
            tab(pa, 'ai')
            pill = pa.locator('[data-testid="agent-pill"]')
            ok(pill.inner_text().strip() == '○ 연결 안 됨', f'상단 AI 알약: {pill.inner_text().strip()}')
            ok(pa.locator('.tab-ai .agent-line').count() == 0 and pa.locator('.tab-ai #agent-setup').count() == 0, 'AI 작업 탭에 연결 줄·연결 안내 상자 없음(설명서 #ai)')
            kinds_ = pa.locator('.tab-ai .composer.docked .chips.kinds .chip').all_inner_texts()
            ok(kinds_ == ['요청', '다듬기'], f'요청 창 종류 칩 = 요청·다듬기 둘: {kinds_}')
            send = pa.locator('.tab-ai .composer.docked .cmp-send')
            ok(send.inner_text().strip() == '보내기' and 'AI에 보냅니다' in (send.get_attribute('title') or ''), f"보내기 단추(모의 AI): {send.inner_text().strip()} · title {send.get_attribute('title')}")
            route_opts = pa.locator('.tab-ai .route-sel option').all_inner_texts()
            ok(route_opts == ['자동', '대기열'], f"보낼 곳: 연결된 환경 없음 → '자동'·'대기열'(서버 AI 숨김): {route_opts}")
            ok('서버 AI' not in pa.locator('.tab-ai').inner_text(), "AI 작업 탭에 '서버 AI' 없음")
            ok(pa.locator('.tab-ai details.mcp').count() == 0, 'v0.2 MCP 도움말 카드 없음')
            pa.locator('.tab-ai .route-sel').select_option('queue'); time.sleep(0.15)
            ok(send.inner_text().strip() == '보내기' and '대기열에 넣습니다' in (send.get_attribute('title') or ''), '보낼 곳 = 대기열 → [보내기] title "대기열에 넣습니다"')
            ok(pa.locator('.tab-ai .cmp-copy').is_visible() and pa.locator('.tab-ai .cmp-copy').inner_text().strip() == '프롬프트 복사', '[프롬프트 복사]')
            # 보낼 곳 옆 '?' → 프로그램 안 설명서(#ai) 창 · 상단 AI 알약도 같은 절
            pa.locator('.tab-ai .composer.docked .cmp-foot .hint').click()
            wait_until(lambda: pa.evaluate("() => !!document.querySelector('[data-testid=help-dialog]')?.open && (document.querySelector('.help-dialog-frame')?.getAttribute('src') || '').includes('#ai')"), timeout=10, msg='설명서 창 #ai')
            ok(True, "보낼 곳 '?' → 설명서 창(#ai)")
            pa.locator('[data-testid=help-close]').click(); time.sleep(0.2)
            pill.click()
            wait_until(lambda: pa.evaluate("() => !!document.querySelector('[data-testid=help-dialog]')?.open && (document.querySelector('.help-dialog-frame')?.contentWindow?.location.hash || '') === '#ai'"), timeout=10, msg='알약 → 설명서 #ai')
            ok(True, '상단 AI 알약 → 설명서 창(#ai)')
            pa.locator('[data-testid=help-close]').click(); time.sleep(0.2)
            shot(pa, '09_ai_offline')
            nreq = len(rest(f'/api/docs/{did}/requests'))
            pa.locator('.tab-ai .cmp-copy').click()
            wait_until(lambda: len(rest(f'/api/docs/{did}/requests')) == nreq + 1, msg='대기열 요청')
            rq = sorted(rest(f'/api/docs/{did}/requests'), key=lambda r: r['rid'])[-1]
            ok(rq['route'] == 'queue' and rq['status'] == 'pending' and rq['kind'] == 'review', f"[프롬프트 복사] → 대기열 요청 #{rq['rid']}(지시 없음 → 검토 review)")
            time.sleep(0.3)
            clip = pa.evaluate('navigator.clipboard.readText()')
            ok(f'request_id={rq["rid"]}' in clip, '그 요청의 프롬프트 복사')
            card_q = pa.locator(f'.tab-ai .card.req[data-rid="{rq["rid"]}"]')
            wait_until(lambda: card_q.count() == 1, msg='요청 카드')
            ok(card_q.locator('.req-st').inner_text().strip() == '대기열' and card_q.locator('.route-chip').count() == 0 and card_q.locator('.pill.k').count() == 0,
               '카드: 상태 칩 하나 "대기열"(경로 칩·종류 알약 없음 — 종류는 #n 의 title)')
            ok('대기열에 있습니다' in pa.locator('.tab-ai .composer.docked .rs-wait').inner_text(), '결과 창 한 줄: 대기열에 있습니다 · [프롬프트 복사] · [취소]')
            pa.locator('.tab-ai .composer.docked .cmp-foot button:has-text("새 요청")').click(); time.sleep(0.2)
            pa.locator('.tab-ai .route-sel').select_option('auto'); time.sleep(0.15)
            ok(pa.evaluate("() => { const t = document.querySelector('.tab-ai'); const c = t.querySelector('.composer.docked'); return c.scrollWidth <= c.clientWidth + 1 && t.scrollWidth <= t.clientWidth + 1; }"), '요청 창이 좁은 패널(360px)을 넘치지 않음')

            print('[7b] 모의 AI 문장 제안(우클릭처럼 연 요청 창) → 결과 창 [반영]', flush=True)
            p7 = paras['s0/p7']
            sel_ok = pa.evaluate(f"() => window.__doc.editor.frame().contentWindow.rhwpCowork.debug.select('s0/p7', 0, {len(p7)})")
            ok(sel_ok is not False, '편집기에서 s0/p7 선택')
            wait_until(lambda: doc_state(pa, 's.sel && !s.sel.collapsed && s.sel.ref') == 's0/p7', msg='선택 → s.sel')
            dock = pa.locator('.tab-ai .composer.docked')
            wait_until(lambda: 's0/p7' in dock.locator('.cmp-target').inner_text(), msg='요청 대상 = 선택')
            ok(dock.locator('.chips.kinds .chip:has-text("문장 제안")').count() == 0, "AI 작업 탭 요청 창에는 '문장 제안' 칩 없음(우클릭에서 연 창에만)")
            pa.evaluate("() => { const d = window.__doc; d.openComposer(d.targetFromCw(d.s.sel), 'suggest'); }")
            win = pa.locator('.composer-win')
            win.wait_for(timeout=5000)
            ok(win.locator('.chips.kinds .chip').all_inner_texts() == ['요청', '다듬기', '문장 제안'] and win.locator('.chips.kinds .chip.on').inner_text().strip() == '문장 제안',
               "'문장 제안'으로 연 창: 세 번째 칩 '문장 제안'")
            ok(win.locator('select[aria-label="문장 제안 개수"]').input_value() == '1', '기본 문장 제안은 권장안 1개')
            win.locator('select[aria-label="문장 제안 개수"]').select_option('3')
            win.locator('.cmp-send').click()
            alts = win.locator('.result .alt')
            wait_until(lambda: alts.count() == 3, timeout=30, msg='3안')
            ok(win.locator('.alt button:has-text("이 안 적용")').count() == 0 and win.locator('.alt .rs-apply').count() == 0, '편집자: v0.2 "이 안 적용"·[문서에 바로 적용] 없음')
            ok(win.locator('.alt .rs-adopt').count() == 3 and all(t.strip() == '반영' for t in win.locator('.alt .rs-adopt').all_inner_texts()), '안마다 [반영]')
            props_ = sorted([x for x in rest(f'/api/docs/{did}/proposals') if x['status'] == 'pending' and x['ref'] == 's0/p7'], key=lambda x: x.get('option') or 0)
            alt1, alt3 = props_[0], props_[2]
            alts.nth(0).locator('.rs-adopt').click()
            def my_draft():
                return rest(f'/api/docs/{did}/drafts/mine')['cr']
            wait_until(lambda: my_draft() and any(h['ref'] == 's0/p7' and h['newText'] == alt1['replace'] for h in my_draft()['hunks']), timeout=20, msg='자동 저장 → 내 수정본 덩어리')
            cr2 = my_draft()
            ok(cr2['status'] == 'draft' and cr2['cid'] != cid, f"제안 반영 → 새 내 수정본 = 변경 요청 #{cr2['cid']}(초안)")
            ad = next(x for x in rest(f'/api/docs/{did}/proposals') if x['pid'] == alt1['pid'])
            ok(ad['status'] == 'pending' and (ad.get('adopted') or {}).get('by') == '홍길동' and ad['adopted'].get('cid') == cr2['cid'], f"제안 #{alt1['pid']} = 내 수정본에 반영(대기 그대로, 변경 요청 #{cr2['cid']})")
            wait_until(lambda: alts.nth(0).locator('.adopted').count() == 1, msg='"반영됨" 표시')
            ok(alts.nth(0).locator('.adopted').inner_text().strip() == '반영됨', '결과 창: 그 안에 "반영됨"')
            cur = pa.evaluate("() => window.__doc.editor.frame().contentWindow.rhwpCowork.debug.text('s0/p7')")
            ok(cur == alt1['replace'], f'편집기 글 = 반영한 안 「{cur}」')
            shot(pa, '12_adopted')
            win.locator('.cmp-foot button:has-text("새 요청")').click(); time.sleep(0.2)
            ok(win.locator('select[aria-label="문장 제안 개수"]').input_value() == '1', '3개 비교 후 새 요청은 권장안 1개로 돌아옴')
            win.locator('.fw-head button[aria-label="닫기"]').click(); time.sleep(0.2)

            print('[7c] 레일 제안 카드(여러 안 한 카드)', flush=True)
            pc = pa.locator('.review-rail .rcard.k-proposal')
            wait_until(lambda: pc.count() == 1 and pc.locator('.rc-opt').count() == 3, timeout=15, msg='제안 카드(3안)')
            ok(pc.locator(f'.rc-opt[data-pid="{alt1["pid"]}"] .adopted').count() == 1, '반영한 안에 "내 수정본에 반영됨"')
            ok(pc.locator('.rc-apply').count() == 0 and pc.locator('.rc-adopt').count() == 2, '편집자: [기준에 바로 적용] 없음 · 남은 안에 [내 수정본에 반영]')
            # '기준에 바로 적용'은 관리자 또는 /api/config 의 allowDirectApply 가 true 일 때만(이 시험 config 는 false)
            ok(conf.get('allowDirectApply') is False, f"/api/config allowDirectApply = {conf.get('allowDirectApply')}(편집자는 못 씀)")
            pa.evaluate("async () => { const m = await import('/util.js'); m.state.config.allowDirectApply = true; }")
            nopt = pc.locator('.rc-opt').count()
            wait_until(lambda: pc.locator('.rc-apply').count() == nopt, timeout=5, msg='allowDirectApply true → 단추')
            ok(nopt == 3, f"allowDirectApply 가 true 면 편집자에게도 [기준에 바로 적용](안마다 {nopt}개)")
            pa.evaluate("async () => { const m = await import('/util.js'); m.state.config.allowDirectApply = false; }")
            wait_until(lambda: pc.locator('.rc-apply').count() == 0, timeout=5, msg='allowDirectApply false → 단추 없음')
            ok(pc.locator(f'.rc-opt[data-pid="{alt3["pid"]}"] .difftext ins').count() >= 1, '안마다 원문 → 제안 차이')
            pc.locator(f'.rc-opt[data-pid="{alt3["pid"]}"] .rc-reject').click()
            wait_until(lambda: next(x for x in rest(f'/api/docs/{did}/proposals') if x['pid'] == alt3['pid'])['status'] == 'rejected', msg='거절')
            wait_until(lambda: pc.locator('.rc-opt').count() == 2, msg='거절한 안이 카드에서 빠짐')
            ok(True, '제안 카드 [거절] → 그 안이 빠짐')

            print('[8] 가짜 에이전트(SSE) 연결 → ● · 연결된 AI로 보내기', flush=True)
            pa.evaluate("() => window.__doc.editor.frame().contentWindow.rhwpCowork.debug.select('s0/p0', 0, 0)")
            time.sleep(0.4)
            sse = Sse(A['token'], agent='PyAgent')
            ok(sse.status == 200, f'SSE 연결 {sse.status}')
            wait_until(lambda: 'hello' in sse.names() and 'snapshot' in sse.names(), msg='hello·snapshot')
            wait_until(lambda: pill.inner_text().strip() == '● PyAgent', timeout=15, msg='알약 ●')
            ok(True, '상단 AI 알약 = ● PyAgent')
            wait_until(lambda: 'PyAgent에 보냅니다' in (send.get_attribute('title') or ''), msg='보내기 = 연결된 작업 환경으로')
            ok(send.inner_text().strip() == '보내기', '보내기 단추 = "보내기"(갈 곳은 보낼 곳 칸 · 단추 title)')
            route_opts = pa.locator('.tab-ai .route-sel option').all_inner_texts()
            ok(route_opts == ['자동 · PyAgent', 'PyAgent', '대기열'], f'보낼 곳 = 연결된 환경 이름만(서버 AI 없음): {route_opts}')
            shot(pa, '10_agent_online')
            send.click()
            wait_until(lambda: any(e == 'ai_request' for e in sse.names()), msg='SSE ai_request')
            ev = [d for e, d in sse.events if e == 'ai_request'][-1]
            rq2 = rest(f'/api/docs/{did}/requests/{ev["rid"]}')
            ok(ev['docId'] == did and rq2['route'] == 'agent' and rq2['delivery'] and rq2['delivery']['agent'] == 'PyAgent', f"요청 #{ev['rid']} → 내 에이전트(SSE ai_request, route agent)")
            res = pa.locator('.tab-ai .composer.docked .rs-wait')
            wait_until(lambda: 'PyAgent에 전달됨' in res.inner_text(), msg='결과 창 = 전달됨')
            card2 = pa.locator(f'.tab-ai .card.req[data-rid="{ev["rid"]}"]')
            wait_until(lambda: card2.count() == 1 and card2.locator('.req-st').inner_text().strip() == '전달됨', msg='카드 상태 = 전달됨')
            ok('PyAgent에 전달' in (card2.locator('.req-st').get_attribute('title') or '') and card2.locator('.route-chip').count() == 0 and card2.locator('.claim-line').count() == 0,
               '카드: 상태 칩 하나 "전달됨"(보낸 곳 PyAgent 는 칩 title — 경로 칩·전달 줄 없음)')
            # 레일의 AI 작업 카드도 '전달됨'
            rr = pa.locator('.review-rail .rcard.k-request')
            wait_until(lambda: any(rr.nth(i).locator('.req-st').inner_text().strip() == '전달됨' for i in range(rr.count())), timeout=15, msg='레일 AI 작업 카드 = 전달됨')
            ok(True, '레일 AI 작업 카드 상태 알약 = 전달됨')
            shot(pa, '11_agent_delivered')
            rr_req = [rr.nth(i) for i in range(rr.count()) if rr.nth(i).locator('.req-st').inner_text().strip() == '전달됨'][0]
            rr_req.locator('.rc-result').click(); time.sleep(0.3)
            ok(doc_state(pa, 's.activeRid') == ev['rid'] and doc_state(pa, 's.tab') == 'ai', '레일 [결과 보기] → AI 작업 탭 결과')
            # 에이전트가 맡음(start_request, 같은 세션) → 처리 중(맡은 이·시각은 칩 title) → 완료
            mcp(A['token'], 'start_request', {'doc_id': did, 'request_id': ev['rid']}, session=sse.session)
            wait_until(lambda: card2.locator('.req-st').inner_text().strip() == '처리 중', msg='카드 = 처리 중')
            tt = card2.locator('.req-st').get_attribute('title') or ''
            ok('PyAgent 처리 중' in tt and '까지 맡음' in tt, f"상태 칩 title: {tt}")
            ok(pa.locator('.tab-ai .result-card').count() == 0, '같은 결과를 두 번 보이지 않음(위 요청 창에 이미 있음)')
            wait_until(lambda: '처리 중' in pa.locator('.tab-ai .rs-wait').first.inner_text(), msg='결과 창 = 처리 중')
            ok('PyAgent' in pa.locator('.tab-ai .rs-wait').first.inner_text(), '결과 창: 처리 중 · PyAgent')
            # 결과 없이 끝내는 검토는 변경 불필요 사유가 있어야 완료된다(2026-11-05 NO_RESULTS 규칙 — 요약은 '문서 변경 없음: 사유')
            mcp(A['token'], 'complete_request', {'doc_id': did, 'request_id': ev['rid'], 'summary': '문서 전체를 훑어 고칠 곳이 없음을 확인함(시험)',
                                                 'no_changes_reason': '문서 전체를 훑어 고칠 곳이 없음을 확인함(시험)'}, session=sse.session)
            wait_until(lambda: card2.locator('.req-st').inner_text().strip() == '완료', msg='카드 = 완료')
            ok('고칠 곳이 없음을 확인함' in card2.inner_text(), '완료 → 요약이 카드에')
            shot(pa, '13_agent_done')
            sse.close(); sse = None
            wait_until(lambda: pill.inner_text().strip() == '○ 연결 안 됨', timeout=15, msg='끊으면 ○')
            ok(True, '에이전트 끊기 → ○ 연결 안 됨')

            print('[9] 관리자 [기준에 바로 적용] → a 의 반영 충돌 → 최신 반영 → 변경 추적 정리 → 반영', flush=True)
            px = rest(f'/api/docs/{did}/proposals', 'POST', {'type': 'replace', 'ref': 's0/p7', 'find': '맺음말입니다', 'replace': '맺음말이다', 'reason': '끝맺음 통일(시험)'}, token=ADMIN['token'])
            pxid = px['pid']
            pcx = pa.locator(f'.review-rail .rc-opt[data-pid="{pxid}"]')
            wait_until(lambda: pcx.count() == 1, timeout=20, msg='a 레일에 관리자 제안 카드')
            ok(pcx.locator('.rc-apply').count() == 0 and pcx.locator('.rc-adopt').count() == 1, '편집자(a): [내 수정본에 반영]만')
            ctx_m, pm = context(ADMIN)
            open_doc(pm, did)
            pmx = pm.locator(f'.review-rail .rc-opt[data-pid="{pxid}"]')
            wait_until(lambda: pmx.count() == 1, timeout=20, msg='관리자 레일에 제안 카드')
            ok(pmx.locator('.rc-apply').count() == 1, '관리자: [기준에 바로 적용] 보임')
            shot(pm, '14_admin_direct')
            pmx.locator('.rc-apply').click()
            wait_until(lambda: next(x for x in rest(f'/api/docs/{did}/proposals') if x['pid'] == pxid)['status'] == 'applied', msg='기준에 적용')
            ok('맺음말이다' in next(x['text'] for x in rest(f'/api/docs/{did}/paragraphs') if x['ref'] == 's0/p7'), '기준 문서 s0/p7 = 관리자 안')
            ctx_m.close()
            cid2 = cr2['cid']
            rest(f'/api/docs/{did}/change-requests/{cid2}/submit', 'POST', {'title': '맺음말 다듬기'})
            rest(f'/api/docs/{did}/change-requests/{cid2}/reviews', 'POST', {'verdict': 'approve'}, token=B['token'])
            # 셸 상단 '변경 요청 #n · 검토 중' 칩(d.s.activeCid) → 변경 요청 탭 상세
            tab(pa, 'ai')
            chipb = pa.locator('[data-testid="cr-chip"]')
            wait_until(lambda: chipb.count() == 1 and f'#{cid2}' in chipb.inner_text(), msg='상단 변경 요청 칩')
            chipb.click()
            det2 = pa.locator(f'.cr-detail[data-cid="{cid2}"]')
            det2.wait_for(timeout=10000)
            ok(doc_state(pa, 's.tab') == 'cr' and doc_state(pa, 's.activeCid') is None, '상단 칩 → 변경 요청 탭 그 상세(activeCid 받음)')
            wait_until(lambda: det2.locator('.cr-hunk .pill.bad').count() >= 1, msg='덩어리 충돌 표시')
            ok('충돌' in det2.locator('.cr-hunk .pill.bad').first.inner_text(), '덩어리 상태 = 충돌')
            wait_until(lambda: det2.locator('.blocker[data-code="CONFLICT"]').count() == 1, msg='막힘: 충돌')
            ok(True, '반영 막힘 이유: 충돌')
            det2.locator('.cr-merge').click()
            ce = det2.locator('.cr-mergeerr .cr-conflict')
            wait_until(lambda: ce.count() == 1, msg='MERGE_CONFLICT 목록')
            t = text_of(ce)
            ok('원문' in t and '내 글' in t and '지금' in t and '맺음말입니다' in t and alt1['replace'] in t and '맺음말이다' in t, f'충돌: 원문·내 글·지금 글 — {t[:90]}')
            ok(rest(f'/api/docs/{did}/change-requests/{cid2}')['status'] == 'open', '충돌이면 아무것도 바꾸지 않음(검토 중 그대로)')
            shot(pa, '15_conflict')
            det2.locator('.cr-mergeerr .cr-rebase').click()
            wait_until(lambda: rest(f'/api/docs/{did}/change-requests/{cid2}')['behind'] == 0, timeout=20, msg='최신 반영(rebase)')
            wait_until(lambda: det2.locator('.cr-rebased .cr-conflict').count() == 1, timeout=20, msg='최신 반영 충돌(내 글 남김) 표시')
            ok(True, '최신 반영 → 겹친 문단은 내 글을 남김(표시)')
            wait_until(lambda: det2.locator('.blocker[data-code="PENDING_TRACKED"]').count() == 1, timeout=15, msg='막힘: 변경 추적과 겹침')
            ok(True, '반영 막힘 이유: 처리 안 된 변경 추적과 겹침')
            wait_until(lambda: doc_state(pa, 'd.editor.ready && d.editor.source') == 'draft', timeout=30, msg='편집기 = 다시 맞춘 수정본')
            tab(pa, 'change')
            g7 = pa.locator('.card.chg:has(.ref:text-is("s0/p7"))')
            wait_until(lambda: g7.count() == 1, msg='s0/p7 변경 묶음')
            g7.locator('.chg-accept').click()
            wait_until(lambda: not any(c['ref'] == 's0/p7' for c in rest(f'/api/docs/{did}/changes')), msg='s0/p7 변경 수락')
            tab(pa, 'cr')
            det2 = pa.locator(f'.cr-detail[data-cid="{cid2}"]')
            det2.wait_for(timeout=10000)
            wait_until(lambda: det2.locator('.blocker').count() == 0, timeout=15, msg='막힘 없음')
            det2.locator('.cr-merge').click()
            wait_until(lambda: rest(f'/api/docs/{did}/change-requests/{cid2}')['status'] == 'merged', timeout=20, msg='반영')
            ok(next(x['text'] for x in rest(f'/api/docs/{did}/paragraphs') if x['ref'] == 's0/p7') == alt1['replace'], f"반영 → 기준 s0/p7 = 내 글 「{alt1['replace']}」")
            shot(pa, '16_merged_after_rebase')

            print('[9c] b: 내 초안 버리기(그 자리 확인) · 검토 중 닫기 → 다시 열기', flush=True)
            def b_draft():
                return node_helper(['draft', '--base', REST, '--doc', did, '--edits', json.dumps([{'ref': 's0/p3', 'from': '사업 개요', 'to': '사업 목적'}], ensure_ascii=False)], token=B['token'])['cr']
            # 편집기 밖(API)에서 만든 내 수정본은 편집기를 다시 열어야 편집기·목록에 맞게 잡힌다(셸 editor.js 의 open() 이
            # 막 읽은 '수정본 없음'으로 목록의 내 초안을 지우는 경합이 있다 — 보고함). 문서를 다시 연다
            cid3 = b_draft()['cid']
            open_doc(pb, did, reload=True)
            wait_until(lambda: doc_state(pb, 'd.editor.source') == 'draft' and doc_state(pb, 's.myCr && s.myCr.cid') == cid3, msg='b 편집기 = 내 수정본')
            tab(pb, 'cr')
            if pb.locator('.cr-detail').count():
                pb.locator('.cr-detail .cr-top button:has-text("목록")').click(); time.sleep(0.2)
            mine_card = pb.locator(f'.cr-list .cr-card.mine[data-cid="{cid3}"]')
            wait_until(lambda: mine_card.count() == 1, msg='b 의 내 변경 요청(초안)')
            ok(pb.locator('.cr-list .cr-submit-open').count() == 1, '내 초안이 있으면 목록에 [검토 요청…]')
            mine_card.click()
            det3 = pb.locator(f'.cr-detail[data-cid="{cid3}"]')
            det3.wait_for(timeout=10000)
            det3.locator('.cr-foot button:has-text("수정 버리기")').click()
            cf = det3.locator('.confirm-row')
            cf.wait_for(timeout=5000)
            ok('버릴까요' in cf.inner_text(), '수정 버리기 → 그 자리 확인 줄(브라우저 확인 창 아님)')
            cf.locator('button:has-text("버리기")').click()
            wait_until(lambda: rest(f'/api/docs/{did}/drafts/mine', token=B['token'])['cr'] is None, msg='b 수정본 버림')
            wait_until(lambda: pb.locator('.cr-detail').count() == 0, msg='목록으로 돌아감')
            ok(True, '버리기 → 변경 요청이 지워지고 목록으로')
            ok(doc_state(pb, 'd.editor.source') == 'working', '버리기 → 편집기 = 기준 문서')
            wait_until(lambda: doc_state(pb, 'd.editor.ready && !d.editor.loading'), msg='편집기 다시 열기 끝')
            cid4 = b_draft()['cid']
            rest(f'/api/docs/{did}/change-requests/{cid4}/submit', 'POST', {'title': '사업 목적으로 고침'}, token=B['token'])
            open_doc(pb, did, reload=True)
            tab(pb, 'cr')
            if pb.locator('.cr-detail').count():
                pb.locator('.cr-detail .cr-top button:has-text("목록")').click(); time.sleep(0.2)
            card4 = pb.locator(f'.cr-list .cr-card.mine[data-cid="{cid4}"]')
            wait_until(lambda: card4.count() == 1 and '검토 중' in card4.inner_text(), msg='b 의 검토 중 변경 요청')
            card4.click()
            det4 = pb.locator(f'.cr-detail[data-cid="{cid4}"]')
            det4.wait_for(timeout=10000)
            det4.locator('.cr-foot button:has-text("닫기")').click()
            det4.locator('.confirm-row button:has-text("닫기")').click()
            wait_until(lambda: rest(f'/api/docs/{did}/change-requests/{cid4}', token=B['token'])['status'] == 'closed', msg='닫힘')
            wait_until(lambda: det4.locator('.cr-foot button:has-text("다시 열기")').count() == 1, msg='[다시 열기]')
            det4.locator('.cr-foot button:has-text("다시 열기")').click()
            wait_until(lambda: rest(f'/api/docs/{did}/change-requests/{cid4}', token=B['token'])['status'] == 'draft', msg='다시 열기 → 초안')
            ok(True, '닫기(그 자리 확인) → 다시 열기 → 초안')
            shot(pb, '17_reopened')

            print('[9b] 좁은 창(패널이 아래로): 문서 옆 메모 없음 → 검토 탭이 대신', flush=True)
            pa.set_viewport_size({'width': 880, 'height': 900})
            wait_until(lambda: pa.locator('[data-testid="rail"]').count() == 0, msg='문서 옆 메모 숨음')
            wait_until(lambda: doc_state(pa, 's.tab') == 'review', msg='검토 탭')
            ok(pa.locator('.rt-list .rcard').count() >= 3, f"검토 탭 카드 {pa.locator('.rt-list .rcard').count()}개")
            ok(pa.evaluate("() => { const b = document.querySelector('.tabbody'); return b.scrollWidth <= b.clientWidth + 1; }"), '패널이 가로로 넘치지 않음')
            shot(pa, '18_narrow')
            pa.set_viewport_size({'width': 1480, 'height': 920})

            print('[9d] 좁은 창: 검토 요청 창은 탭을 옮겨도 · 창 폭을 바꿔도 남고 적던 글도 그대로', flush=True)
            node_helper(['draft', '--base', REST, '--doc', did, '--edits', json.dumps([{'ref': 's0/p6', 'from': '정리합니다', 'to': '정리했습니다'}], ensure_ascii=False)], token=A['token'])
            open_doc(pa, did, reload=True)
            wait_until(lambda: doc_state(pa, 's.myCr && s.myCr.status') == 'draft', msg='a 의 내 수정본(초안)')
            pa.set_viewport_size({'width': 880, 'height': 900})
            wait_until(lambda: pa.locator('[data-testid="rail"]').count() == 0, msg='문서 옆 메모 숨음')
            pa.locator('[data-testid="submit-cr"]').click()
            dlg = pa.locator('.floatwin.cr-submit')
            dlg.wait_for(timeout=10000)
            wait_until(lambda: dlg.locator('.cr-submit-title').input_value() != '', msg='제목 기본값')
            dlg.locator('.cr-submit-title').fill('좁은 창에서 쓴 제목')
            dlg.locator('.cr-submit-desc').fill('좁은 창에서 쓴 설명')
            for t_ in ['ai', 'change', 'attach', 'history', 'review', 'cr']:
                tab(pa, t_)
                d2 = pa.locator('.floatwin.cr-submit')
                ok(d2.count() == 1 and d2.locator('.cr-submit-title').input_value() == '좁은 창에서 쓴 제목' and d2.locator('.cr-submit-desc').input_value() == '좁은 창에서 쓴 설명',
                   f'탭 {t_}: 검토 요청 창 · 적던 제목·설명 그대로')
            pa.set_viewport_size({'width': 1480, 'height': 920})
            wait_until(lambda: pa.locator('[data-testid="rail"]').count() == 1, msg='문서 옆 메모 다시')
            time.sleep(0.3)
            d2 = pa.locator('.floatwin.cr-submit')
            ok(d2.count() == 1 and d2.locator('.cr-submit-title').input_value() == '좁은 창에서 쓴 제목' and d2.locator('.cr-submit-desc').input_value() == '좁은 창에서 쓴 설명',
               '창을 넓혀도(레일이 창을 맡음) 창 · 적던 글 그대로')
            shot(pa, '18b_submit_kept')
            d2.locator('button:has-text("취소")').click()
            wait_until(lambda: pa.locator('.floatwin.cr-submit').count() == 0 and doc_state(pa, 's.submitForm') is None, msg='취소 → 창·적던 글 지움')
            pa.locator('[data-testid="submit-cr"]').click()
            dlg = pa.locator('.floatwin.cr-submit')
            dlg.wait_for(timeout=10000)
            wait_until(lambda: dlg.locator('.cr-submit-title').input_value() != '', msg='제목 기본값(다시 열기)')
            ok(dlg.locator('.cr-submit-title').input_value() != '좁은 창에서 쓴 제목' and dlg.locator('.cr-submit-desc').input_value() == '', '닫고 다시 열면 새 창(기본 제목)')
            dlg.locator('button:has-text("취소")').click()
            rest(f'/api/docs/{did}/drafts/mine', 'DELETE')

            print('[10] 편집기는 하나: 옛 주소(?legacy=1)도 같은 편집기 화면 · 옛 검토 보기(review.js) 없음', flush=True)
            pb.goto(f'{BASE}/#/doc/{did}?legacy=1'); pb.reload()   # 새로 띄운 페이지가 옛 주소로 열리게
            open_doc(pb, did, suffix='?legacy=1')
            ok(pb.locator('.docview[data-view="v3"] .editorhost iframe').count() == 1 and pb.locator('.seg.mode, .review, .rv-scroll, .ask-fab').count() == 0,
               '#/doc/<id>?legacy=1 → v0.3 편집기 화면(검토 보기·편집 보기 전환 없음)')
            ptabs = pb.evaluate("() => [...document.querySelectorAll('.panel .tabs [role=tab]')].map((b) => b.dataset.tab)")
            ok(ptabs == ['ai', 'review', 'cr', 'change', 'attach', 'history'], f'패널 탭 {ptabs}(옛 메모·제안·본문 탭 없음)')
            ok(pb.locator('.tab-review .rt-list').count() == 1, '첫 탭 = 검토')

            def http_status(path):
                try:
                    with urllib.request.urlopen(REST + path, timeout=10) as r:
                        return r.status
                except urllib.error.HTTPError as e:
                    return e.code
            ok(http_status('/review.js') == 404 and http_status('/app.js') == 200, '웹: /review.js 없음(404) · /app.js 있음')
            shot(pb, '19_one_editor')

            print('[11] 문서 목록: 역할은 한국어 · 창으로 돌아오면(focus) 다시 읽음', flush=True)
            pb.goto(f'{BASE}/#/')
            pb.wait_for_selector('.listpage tr.doc', timeout=15000)
            ok(pb.locator('.listpage .me-role').inner_text().strip() == '김검토 · 편집자', f"목록 상단 「{pb.locator('.listpage .me-role').inner_text().strip()}」(editor → 편집자)")
            with open(built['out'], 'rb') as f:
                rest('/api/docs', 'POST', f.read(), {'x-file-name': urllib.parse.quote('새로올린문서.hwpx'), 'Content-Type': 'application/octet-stream'}, raw=True, token=ADMIN['token'])
            newrow = pb.locator('.listpage tr.doc', has_text='새로올린문서')
            time.sleep(0.5)
            ok(newrow.count() == 0, '다른 사람이 막 올린 문서 — 아직 이 목록에는 없음')
            pb.evaluate("() => window.dispatchEvent(new Event('focus'))")
            wait_until(lambda: newrow.count() == 1, timeout=10, msg='창으로 돌아옴 → 목록 다시 읽음')
            ok(True, '창으로 돌아오면(focus) 목록을 다시 읽어 새 문서가 보임(보이는 동안은 30초마다)')
            inf11 = rest(f'/api/docs/{did}')
            dv = pb.locator('.listpage tr.doc', has_text='협업시험').locator('.doc-ver').inner_text().strip()
            ok(dv == f"v{inf11['milestone']['v']}" and inf11['version'] != inf11['milestone']['v'], f"문서 목록의 버전 = 사람용 {dv}(기록 번호 {inf11['version']} 아님)")
            shot(pb, '20_doclist')

            v031_jobs(pa, pb, tmp)
            v04_panels(context, tmp)

            for c in (ctx_a, ctx_b):
                c.close()
            br.close()

        bad = [e for e in ERRORS if 'pageerror' in e or any(f'/{m}' in e for m in ('rail.js', 'crs.js', 'panels.js', 'ui.js', 'app.js', 'store.js', 'editor.js'))]
        for e in ERRORS:
            print(f'    (기록) {e}', flush=True)
        ok(not bad, f'화면 오류 없음{"" if not bad else ": " + bad[0]}')
        ok(not DIALOGS, f'브라우저 확인 창(confirm) 안 씀{"" if not DIALOGS else ": " + DIALOGS[0]}')
    except OnlyJobs:
        bad = [e for e in ERRORS if 'pageerror' in e or any(f'/{m}' in e for m in ('rail.js', 'crs.js', 'panels.js', 'ui.js', 'app.js', 'store.js', 'editor.js'))]
        ok(not bad, f'화면 오류 없음{"" if not bad else ": " + bad[0]}')
    except Exception:  # noqa: BLE001
        traceback.print_exc()
        RESULTS.append((False, '예외'))
    finally:
        if sse:
            sse.close()
        if srv:
            srv.terminate()
            try:
                srv.wait(10)
            except Exception:  # noqa: BLE001
                srv.kill()
        if log:
            log.close()
        shutil.rmtree(tmp, ignore_errors=True)
    n_ok = sum(1 for r, _ in RESULTS if r)
    n_bad = sum(1 for r, _ in RESULTS if not r)
    print(f'\n결과: 통과 {n_ok} · 실패 {n_bad}', flush=True)
    sys.exit(1 if n_bad else 0)


if __name__ == '__main__':
    main()
