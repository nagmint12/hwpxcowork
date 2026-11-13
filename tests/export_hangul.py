# 한글로 저장(검토본) 한글 왕복 관문 — docs/V3_SPEC.md §3.6·§3.7·§6.1(밤마다 도는 관문, ui_review/e2e_flow 의 한글 확인을 대신함).
#   python -I tests/export_hangul.py [--keep]
# 1) 임시 data·임시 config(토큰을 새로 만듦)·모의 AI·빈 포트(127.0.0.1, 포트 0 → 'LISTENING <port>')로 서버를 띄운다
#    — 진짜 config.json·data/ 는 읽지도 쓰지도 않고, 사용자 서버(8787)는 건드리지 않는다.
# 2) API 로 문서를 만든다(tests/fixtures/tool_memo_tracked.hwpx — 변경 추적·메모가 든 문서):
#    사람 메모 스레드(답글 2·해결) · AI 작업(모의 AI) 기록 메모와 AI 의견 메모에 답글 · 제안 메모에 답글
#    · 홍길동 수정본(덩어리 2: 문단 바꿈 s0/p1·s0/p2 뒤 문단 추가 — 엔진으로 만든 편집기 내보내기 자리) → 검토 요청(open)
#    · 김검토 의견 스레드 1(+ 작성자 답글 1)·수정 요청 검토
# 3) GET /file?kind=tracked&reviews=1(검토본) → python -I tests/hangul_page_images.py <검토본> <임시 out> --save
#    (한글 2022 COM: 하위 프로세스에서 SetMessageBoxMode → 열기 → 쪽마다 CreatePageImage(인쇄 없음) → 다시 저장, 자기가 띄운 Hwp.exe 만 정리)
# 4) 한글이 다시 저장한 HWPX 를 엔진으로 읽어(node tests/inspect_hwpx.mjs) '[변경 요청 #' 메모 2개와 스레드 줄
#    (의견 줄·── 답글·↳·✓)이 우리 글 그대로인지, node tests/compare_saved.mjs <검토본> <한글 저장본> 이 끝 코드 0 인지 본다.
#    (한글 쪽 그림·PDF 는 메모 말풍선을 찍지 않으므로 메모는 다시 저장한 HWPX 로 확인한다 — CLAUDE.md)
# 한글이 없거나(윈도 아님·pywin32 없음·HWPFrame.HwpObject 등록 없음) COM 을 띄우지 못하면 'SKIP: 이유' 를 찍고 끝 코드 0.
# 다른 Hwp.exe 가 떠 있으면(사용자가 연 한글일 수 있다 — COM 이 그 창에 붙어 닫아 버리지 않게) 잠시 기다리다 SKIP.
# --keep: 임시 폴더(검토본·한글 저장본·page_images.json·서버 로그)를 지우지 않고 경로를 알려 준다.
import json
import os
import pathlib
import queue
import secrets
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request

sys.stdout.reconfigure(encoding='utf-8', errors='replace')
ROOT = pathlib.Path(__file__).resolve().parent.parent
FIXTURE = ROOT / 'tests' / 'fixtures' / 'tool_memo_tracked.hwpx'
ENGINE_URL = (ROOT / 'engine' / 'doc.js').as_uri()
KEEP = '--keep' in sys.argv[1:]
RESULTS = []
USERS = {'admin': '관리자', 'a': '홍길동', 'b': '김검토'}


class Skip(Exception):
    pass


def ok(cond, msg):
    RESULTS.append((bool(cond), msg))
    print(('  ✓ ' if cond else '  ✗ ') + msg, flush=True)
    if not cond:
        raise AssertionError(msg)


def section(s):
    print(f'\n── {s}', flush=True)


def hangul_missing():
    """한글 COM 을 쓸 수 없는 이유(쓸 수 있으면 None)"""
    if os.name != 'nt':
        return '윈도가 아닙니다(한글 COM 없음)'
    try:
        import win32com.client  # noqa: F401
    except Exception as e:  # pywin32 없음
        return f'pywin32(win32com)를 불러오지 못했습니다: {e}'
    try:
        import winreg
        winreg.CloseKey(winreg.OpenKey(winreg.HKEY_CLASSES_ROOT, r'HWPFrame.HwpObject\CLSID'))
    except OSError:
        return '한글(HWPFrame.HwpObject COM)이 설치되어 있지 않습니다'
    return None


def hwp_pids():
    try:
        import psutil
        return {p.pid for p in psutil.process_iter(['name']) if (p.info.get('name') or '').lower().startswith('hwp')}
    except Exception:
        try:
            out = subprocess.run(['tasklist', '/FI', 'IMAGENAME eq Hwp.exe', '/FO', 'CSV', '/NH'], capture_output=True, timeout=30).stdout.decode('cp949', 'replace')
            return {int(line.split('","')[1]) for line in out.splitlines() if line.startswith('"Hwp.exe"')}
        except Exception:
            return set()


# ───────── 임시 서버 ─────────

class Server:
    """node server/index.js 를 임시 config·data·모의 AI·포트 0 으로 띄운다(tests/helpers/server.mjs 와 같은 규칙)"""

    def __init__(self, tmp):
        self.tmp = tmp
        self.data = tmp / 'data'
        self.data.mkdir()
        self.tokens = {k: secrets.token_hex(16) for k in USERS}
        users = [{'name': USERS[k], 'role': 'admin' if k == 'admin' else 'editor', 'token': self.tokens[k]} for k in ('admin', 'a', 'b')]
        cfg = {
            'host': '127.0.0.1', 'port': 0, 'dataDir': './data', 'allowAgentApply': True, 'users': users,
            # 키 파일은 없는 경로: 어떤 경우에도 실제 API 를 부르지 않는다(모의 AI 만)
            'ai': {'enabled': False, 'mock': False, 'keyFile': str(tmp / 'no-such-key.txt'), 'model': 'claude-opus-5-5', 'effort': 'medium', 'maxProposals': 10},
            'studio': {'mode': 'local'}, 'agents': {'leaseMinutes': 15, 'othersCanTake': False}, 'changeRequests': {'requireApprovals': 1},
        }
        self.config = tmp / 'config.json'
        with open(self.config, 'w', encoding='utf-8', newline='') as f:
            json.dump(cfg, f, ensure_ascii=False, indent=1)
        env = {k: v for k, v in os.environ.items() if not k.upper().startswith('HWPX_COWORK_')}
        env.update(HWPX_COWORK_CONFIG=str(self.config), HWPX_COWORK_DATA_DIR=str(self.data), HWPX_COWORK_AI_MOCK='1',
                   HWPX_COWORK_PORT='0', HWPX_COWORK_HOST='127.0.0.1')
        # stdout 은 시작 줄(LISTENING·NONCE)을 읽느라 이 프로세스가 받아 server.out.log 로, stderr 는 서버가 바로 server.err.log 로
        self.proc = None
        self.log = open(tmp / 'server.out.log', 'w', encoding='utf-8', newline='')
        self.err = open(tmp / 'server.err.log', 'wb')
        # 띄운 뒤 시작 확인(시작 줄·nonce·/api/config)에 실패하면 서버를 끄고 로그 파일을 닫은 뒤 오류를 그대로 올린다 —
        # 생성자가 던지면 main() 의 srv 가 None 이라 finally 가 끄지 못하고, 서버가 임시 config 로 남아 임시 폴더도 못 지운다
        # (tests/helpers/server.mjs boot() 처럼)
        try:
            self.proc = subprocess.Popen(['node', str(ROOT / 'server' / 'index.js')], cwd=str(ROOT), env=env,
                                         stdout=subprocess.PIPE, stderr=self.err, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            self.lines = queue.Queue()
            threading.Thread(target=self._pump, daemon=True).start()
            first = self._line(30)
            second = self._line(10)
            if not first.startswith('LISTENING ') or not second.startswith('NONCE '):
                raise RuntimeError(f'서버 시작 줄이 이상합니다: {first!r} / {second!r}')
            self.port = int(first.split()[1])
            nonce = second.split()[1]
            self.base = f'http://127.0.0.1:{self.port}'
            conf = None
            for _ in range(100):
                try:
                    with urllib.request.urlopen(self.base + '/api/config', timeout=2) as r:
                        conf = json.loads(r.read())
                    break
                except Exception:
                    time.sleep(0.1)
            if not conf or conf.get('nonce') != nonce:
                raise RuntimeError(f'{self.base}/api/config 의 nonce 가 이 서버와 다릅니다({conf and conf.get("nonce")} ≠ {nonce})')
            self.conf = conf
        except BaseException as e:
            self.stop()
            tail = self.tail() if isinstance(e, Exception) else ''
            if tail.strip():   # 임시 폴더는 곧 지워지므로 서버가 남긴 오류 끝부분을 여기서 보여 준다
                print(f'--- 서버 stderr(끝) ---\n{tail}', flush=True)
            raise

    def _pump(self):
        for raw in self.proc.stdout:
            line = raw.decode('utf-8', 'replace').rstrip('\r\n')
            try:
                self.log.write(line + '\n')
            except ValueError:   # stop() 뒤(파일 닫힘)
                pass
            self.lines.put(line)

    def _line(self, timeout):
        try:
            return self.lines.get(timeout=timeout)
        except queue.Empty:
            raise RuntimeError(f'서버가 {timeout}초 안에 시작 줄을 쓰지 않았습니다(로그 {self.tmp / "server.err.log"})')

    def stop(self):
        if self.proc is not None:
            try:
                self.proc.terminate()
                self.proc.wait(timeout=10)
            except Exception:
                try:
                    self.proc.kill()
                    self.proc.wait(timeout=10)
                except Exception:
                    pass
        for f in (self.log, self.err):
            try:
                f.close()
            except Exception:
                pass

    def tail(self, n=1500):
        try:
            return (self.tmp / 'server.err.log').read_bytes().decode('utf-8', 'replace')[-n:]
        except Exception:
            return ''


class Api:
    def __init__(self, base, token):
        self.base = base
        self.token = token

    def res(self, path, method='GET', body=None, raw=None, headers=None):
        h = {'Authorization': f'Bearer {self.token}'}
        h.update(headers or {})
        data = None
        if raw is not None:
            data = raw
            h.setdefault('Content-Type', 'application/octet-stream')
        elif body is not None:
            data = json.dumps(body, ensure_ascii=False).encode('utf-8')
            h['Content-Type'] = 'application/json'
        req = urllib.request.Request(self.base + path, data=data, headers=h, method=method)
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.status, r.read(), r.headers
        except urllib.error.HTTPError as e:
            return e.code, e.read(), e.headers

    def __call__(self, path, method='GET', body=None, raw=None, headers=None):
        status, data, hdrs = self.res(path, method, body, raw, headers)
        if status >= 300:
            raise AssertionError(f'{method} {path} → {status} {data[:300].decode("utf-8", "replace")}')
        return json.loads(data) if 'json' in (hdrs.get('content-type') or '') else data


def node(script_path, *args, timeout=120):
    cp = subprocess.run(['node', str(script_path), *map(str, args)], cwd=str(ROOT), capture_output=True, timeout=timeout)
    if cp.returncode != 0:
        raise AssertionError(f'node {script_path.name} 실패({cp.returncode}): {cp.stderr.decode("utf-8", "replace")[-600:]}')
    return cp.stdout.decode('utf-8', 'replace')


def inspect(path):
    """엔진으로 HWPX 읽기(tests/inspect_hwpx.mjs): 메모(글·작성자·자리)·표·변경 추적"""
    cp = subprocess.run(['node', 'tests/inspect_hwpx.mjs', str(path)], cwd=str(ROOT), capture_output=True, timeout=120)
    if cp.returncode != 0:
        raise AssertionError(f'inspect_hwpx 실패: {cp.stderr.decode("utf-8", "replace")[-400:]}')
    return json.loads(cp.stdout.decode('utf-8'))


# 수정본(편집기 내보내기 자리) 만들기: 작업본을 엔진으로 읽어 s0/p1 글 바꿈 + s0/p2 뒤 새 문단 → 최종본으로 저장
MAKE_DRAFT = '''
import fs from 'node:fs';
const [engineUrl, src, out] = process.argv.slice(2);
const { HwpxDoc } = await import(engineUrl);
const d = await HwpxDoc.load(fs.readFileSync(src));
const w = await d.clone();
const ED = { author: '편집기' };
const t1 = w.text('s0/p1');
if (!t1.includes('있던 낱말을')) throw new Error('s0/p1 글이 예상과 다릅니다: ' + t1);
w.mergeParagraphText('s0/p1', t1.replace('있던 낱말을', '기존 낱말을'), ED);
w.insertParagraphAfter(0, 2, '넷째 문단: 검토본 한글 왕복 시험으로 넣은 문단입니다.', ED);
const flat = await w.flattened();
fs.writeFileSync(out, Buffer.from(await flat.save()));
console.log(JSON.stringify({ ok: true, bytes: fs.statSync(out).size }));
'''


def main():
    missing = hangul_missing()
    if missing:
        print(f'SKIP: {missing}')
        return 0
    tmp = pathlib.Path(tempfile.mkdtemp(prefix='hwpx_exphangul_'))
    srv = None
    code = 0
    skipped = False
    try:
        section('임시 서버(임시 data·config·모의 AI·빈 포트)')
        srv = Server(tmp)
        print(f'  server {srv.base} v{srv.conf.get("version")} aiMock={srv.conf.get("aiMock")} data={srv.data}', flush=True)
        ok(srv.port != 8787 and srv.conf.get('aiMock') is True, f'포트 {srv.port}(8787 아님), 모의 AI')
        A = Api(srv.base, srv.tokens['a'])
        B = Api(srv.base, srv.tokens['b'])
        ADM = Api(srv.base, srv.tokens['admin'])

        section('API 로 검토본 만들기: 메모 스레드 · AI 작업 메모 · 제안 메모 · 변경 요청(덩어리 2·의견 스레드 1)')
        doc = A('/api/docs', 'POST', raw=FIXTURE.read_bytes(), headers={'x-file-name': urllib.parse.quote('검토본 한글 왕복.hwpx')})
        did = doc['id']
        D = f'/api/docs/{did}'
        # 사람 메모(memo1) 스레드: 답글 2 + 해결
        B(f'{D}/memos/memo1/replies', 'POST', {'text': '근거 확인했습니다'})
        A(f'{D}/memos/memo1/replies', 'POST', {'text': '고맙습니다'})
        m1 = ADM(f'{D}/memos/memo1/resolve', 'POST', {'resolved': True})
        ok(len(m1['thread']['replies']) == 2 and m1['thread']['resolved'] and '\n── 답글\n' in m1['text'], '사람 메모 스레드(답글 2·해결) → 메모 글에 블록')
        # AI 작업(모의 AI 가 바로 처리): 작업 기록 메모·AI 의견 메모에 답글
        rq = A(f'{D}/requests', 'POST', {'kind': 'review', 'target': {'ref': 's0/p2'}})
        ok(rq.get('route') == 'server' and rq['request']['status'] == 'done' and rq['request']['memoId'] and rq.get('comments'), f'AI 작업 #{rq["request"]["rid"]}(모의 AI) 완료 — 기록 메모·의견 메모')
        rqm = B(f'{D}/memos/{rq["request"]["memoId"]}/replies', 'POST', {'text': '결과 확인했습니다'})
        cm = A(f'{D}/memos/{rq["comments"][0]["id"]}/replies', 'POST', {'text': '의견대로 고치겠습니다'})
        ok(rqm['link']['type'] == 'request' and '\n── 답글\n↳ 김검토 ' in rqm['text'] and cm['link']['type'] == 'comment' and '\n── 답글\n↳ 홍길동 ' in cm['text'], '작업 기록 메모·AI 의견 메모 답글 → 블록')
        # 사람 제안(제안 메모)에 답글
        pr = A(f'{D}/proposals', 'POST', {'ref': 's0/p0', 'find': '메모 대상 문장이', 'replace': '메모를 다는 문장이', 'reason': '표현 정리'})
        pm = B(f'{D}/memos/{pr["memoId"]}/replies', 'POST', {'text': '좋은 제안입니다'})
        ok(pm['link']['type'] == 'proposal' and pm['text'].startswith(f'[제안 {pr["pid"]}]') and '\n── 답글\n↳ 김검토 ' in pm['text'], '제안 메모 답글 → 렌더러 글 + 블록')
        # 변경 요청: 홍길동 수정본(덩어리 2) → 검토 요청 → 김검토 의견 스레드 1(+ 답글) · 수정 요청
        status, wbytes, whdr = A.res(f'{D}/file?kind=working')
        ok(status == 200, f'작업본 내려받기(v{whdr.get("X-Doc-Version")})')
        (tmp / 'working.hwpx').write_bytes(wbytes)
        script = tmp / 'make_draft.mjs'
        with open(script, 'w', encoding='utf-8', newline='') as f:
            f.write(MAKE_DRAFT)
        node(script, ENGINE_URL, tmp / 'working.hwpx', tmp / 'draft.hwpx')
        put = A(f'{D}/drafts/mine?base={whdr.get("X-Doc-Version")}', 'PUT', raw=(tmp / 'draft.hwpx').read_bytes())
        cr = put['cr']
        kinds = sorted(h['type'] for h in cr['hunks'])
        where = ', '.join('%s %s' % (h['type'], h.get('afterRef') or h['ref']) for h in cr['hunks'])
        ok(cr['status'] == 'draft' and kinds == ['insert', 'replace'], f'수정본 저장 → 변경 요청 #{cr["cid"]}(덩어리 {where})')
        cid = cr['cid']
        A(f'{D}/change-requests/{cid}/submit', 'POST', {'title': '낱말 정리·문단 추가'})
        hid = next(h['hid'] for h in cr['hunks'] if h['type'] == 'replace')
        B(f'{D}/change-requests/{cid}/threads', 'POST', {'hid': hid, 'text': '바꾼 낱말의 근거가 있나요?'})
        A(f'{D}/change-requests/{cid}/threads/1/replies', 'POST', {'text': '용어집을 따랐습니다'})
        cv = B(f'{D}/change-requests/{cid}/reviews', 'POST', {'verdict': 'changes', 'body': '용어집 출처를 남겨 주세요'})
        ok(cv['status'] == 'open' and len(cv['threads']) == 1 and len(cv['threads'][0]['comments']) == 2 and cv['changesRequested'] == 1, '검토 중(open) · 의견 스레드 1(답글 1) · 수정 요청 1')

        section('한글로 저장(검토본: 변경 추적 + 검토 메모)')
        status, ebytes, ehdr = A.res(f'{D}/file?kind=tracked&reviews=1')
        ok(status == 200 and ehdr.get('X-Review-Memos') == '2', f'GET /file?kind=tracked&reviews=1 → {status}, 검토 메모 {ehdr.get("X-Review-Memos")}')
        export = tmp / 'review_export.hwpx'
        export.write_bytes(ebytes)
        ours = inspect(export)
        cr_ours = [m for m in ours['memos'] if m['text'].startswith(f'[변경 요청 #{cid} · 검토 중]')]
        rep = next((m for m in cr_ours if '\n→ 「' in m['text']), None)
        ok(len(cr_ours) == 2 and rep and rep['ref'] == 's0/p1' and '의견: 김검토: 바꾼 낱말의 근거가 있나요? (답 1)' in rep['text'] and '김검토(수정 요청): 용어집 출처를 남겨 주세요' in rep['text'],
           f'검토본(엔진으로 읽음): 변경 요청 메모 2개 — 바꿈 메모 s0/p1 의견 줄: {rep and rep["text"].splitlines()[-1]}')
        threaded = [m for m in ours['memos'] if '\n── 답글\n' in m['text']]
        ok(len(threaded) == 4, f'검토본: 스레드 블록이 있는 메모 {len(threaded)}개(사람·작업 기록·AI 의견·제안)')

        section('한글 2022 로 열기(hangul_page_images.py — 쪽 그림·다시 저장) — 다른 Hwp.exe 가 없을 때만')
        others = hwp_pids()
        waited = 0
        while others and waited < 120:
            print(f'    다른 Hwp.exe {sorted(others)} 가 떠 있어 기다립니다…', flush=True)
            time.sleep(10)
            waited += 10
            others = hwp_pids()
        if others:
            raise Skip(f'다른 Hwp.exe {sorted(others)} 가 실행 중입니다 — 사용자 한글을 건드리지 않으려고 건너뜀')
        hin = tmp / 'hangul_in'
        hin.mkdir()
        hout = tmp / 'hangul_out'
        shutil.copy(export, hin / 'review_export.hwpx')
        t0 = time.time()
        cp = subprocess.run([sys.executable, '-I', str(ROOT / 'tests' / 'hangul_page_images.py'), str(hin / 'review_export.hwpx'), str(hout), '--save'], capture_output=True, timeout=420)
        res = {}
        try:
            with open(hout / 'page_images.json', encoding='utf-8') as f:
                res = json.load(f)
        except Exception:
            res = {'raw': cp.stdout.decode('utf-8', 'replace')[-600:], 'stderr': cp.stderr.decode('utf-8', 'replace')[-600:]}
        err = str(res.get('stderr') or '') + str(res.get('raw') or '')
        if 'open' not in res and not res.get('timeout'):
            # 한글 문서를 열기 전에 실패 = COM 을 띄우지 못함(Dispatch 등) → SKIP, 그 밖(열다 죽음)은 실패
            if 'Dispatch' in err or 'Invalid class string' in err or '클래스 문자열' in err or 'CoInitialize' in err:
                raise Skip(f'한글 COM 을 띄우지 못했습니다: {err.strip()[-300:]}')
            ok(False, f'한글 하위 프로세스가 문서를 열기 전에 끝남: {err.strip()[-400:]}')
        ok(not res.get('timeout'), f'한글 처리 시간 {time.time() - t0:.0f}초(시간 초과 아님)')
        drawn = [im for im in res.get('images', []) if im.get('ink') and not im.get('error')]
        ok(res.get('open') and res.get('pages', 0) >= 1 and len(drawn) == res.get('pages') and res.get('saved') and (hout / 'saved.hwpx').exists(),
           f"한글: 열림 {res.get('open')} · {res.get('pages')}쪽 · 변경 추적 {res.get('is_track_change')} · 쪽 그림 {len(drawn)}/{res.get('pages')}쪽 · 다시 저장 {res.get('saved')}")
        # hangul_page_images.py 는 자기가 띄운 Hwp.exe 를 끝에 정리한다(종료는 비동기라 잠깐 목록에 남을 수 있다 — 20초까지 기다림)
        left = hwp_pids()
        for _ in range(40):
            if not left:
                break
            time.sleep(0.5)
            left = hwp_pids()
        ok(not left, f'이번에 띄운 Hwp.exe 가 남지 않음{"" if not left else ": " + str(sorted(left)) + " (정리: " + str(res.get("killed")) + ")"}')

        section('한글이 다시 저장한 HWPX 를 엔진으로 읽기 — 검토 메모·스레드 줄이 그대로인지')
        theirs = inspect(hout / 'saved.hwpx')
        cr_theirs = [m for m in theirs['memos'] if m['text'].startswith(f'[변경 요청 #{cid} · 검토 중]')]
        ok(len(cr_theirs) == 2 and sorted(m['text'] for m in cr_theirs) == sorted(m['text'] for m in cr_ours) and all(m['author'] == USERS['a'] for m in cr_theirs),
           f"'[변경 요청 #{cid}' 메모 2개가 글·작성자 그대로({len(theirs['memos'])}/{len(ours['memos'])} 메모)")
        rep2 = next((m for m in cr_theirs if '\n→ 「' in m['text']), None)
        ok(rep2 and rep2['ref'] == 's0/p1' and any(line.startswith('의견: 김검토: 바꾼 낱말의 근거가 있나요? (답 1)') for line in rep2['text'].splitlines()), '바꿈 메모의 의견 줄(스레드 요약 「…(답 1)」)이 그대로, 자리 s0/p1')
        by_text = {m['text'] for m in theirs['memos']}
        kept = [m for m in threaded if m['text'] in by_text]
        ok(len(kept) == len(threaded), f'스레드 블록 메모 {len(kept)}/{len(threaded)}개가 글 그대로(── 답글 · ↳ · ✓ 줄)')
        memo1 = next((m for m in theirs['memos'] if m['id'] == 'memo1' or m['text'].startswith('AI 제안: ')), None)
        lines = memo1['text'].splitlines() if memo1 else []
        ok(memo1 and '── 답글' in lines and any(line.startswith('↳ 김검토 ') and line.endswith(': 근거 확인했습니다') for line in lines)
           and any(line.startswith('↳ 홍길동 ') and line.endswith(': 고맙습니다') for line in lines) and any(line.startswith('✓ 해결됨 · 관리자 ') for line in lines),
           '사람 메모 스레드 줄(↳ 답글 2 · ✓ 해결됨)이 한글 저장 뒤에도 그대로')

        section('node tests/compare_saved.mjs <검토본> <한글 저장본> — 메모 글·변경 추적·표·본문 글 그대로')
        cp2 = subprocess.run(['node', 'tests/compare_saved.mjs', str(export), str(hout / 'saved.hwpx')], cwd=str(ROOT), capture_output=True, timeout=120)
        out2 = cp2.stdout.decode('utf-8', 'replace').strip()
        print('    ' + out2.replace('\n', '\n    '), flush=True)
        ok(cp2.returncode == 0, f'compare_saved 끝 코드 {cp2.returncode}')
    except Skip as e:
        print(f'SKIP: {e}')
        skipped = True
    except AssertionError:
        code = 1
    except Exception:
        traceback.print_exc()
        RESULTS.append((False, 'exception'))
        code = 1
    finally:
        if srv:
            if code:
                print(f'--- 서버 stderr(끝) ---\n{srv.tail()}')
            srv.stop()
        if KEEP:
            print(f'  (임시 폴더 남김: {tmp})')
        else:
            shutil.rmtree(tmp, ignore_errors=True)
    passed = sum(1 for r in RESULTS if r[0])
    failed = [r[1] for r in RESULTS if not r[0]]
    if failed or code:
        print(f'\nEXPORT HANGUL FAILED — {passed} 통과, {len(failed)} 실패' + (f': {failed}' if failed else ''))
        return 1
    if skipped:
        print(f'\nEXPORT HANGUL SKIP — 건너뛰기 전 {passed}개 확인')
        return 0
    print(f'\nEXPORT HANGUL OK — {passed}개 확인')
    return 0


if __name__ == '__main__':
    sys.exit(main())
