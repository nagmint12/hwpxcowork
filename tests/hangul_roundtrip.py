# 한글(한/글) COM 으로 HWPX 를 열어 확인하는 회귀 도구 (Windows + 한글 설치 필요).
# 사용: python -I tests/hangul_roundtrip.py <in.hwpx> <out_dir> [--apply-all] [--pdf]
# 결과: out_dir/result.json (페이지 수, 최종본 텍스트, 적용 후 텍스트), out_dir/saved.hwpx, out_dir/view.pdf
# 주의: 한글 입출력은 임시 폴더에서만 하고(다른 드라이브 경로는 숨은 대화상자로 멈출 수 있음), 끝나면 Hwp 프로세스를 정리한다.
import json
import os
import shutil
import subprocess
import sys
import tempfile


CHILD = r'''
import sys, os, json, shutil, runpy
src, work, apply_all, want_pdf = sys.argv[1], sys.argv[2], sys.argv[3] == '1', sys.argv[4] == '1'
inp = os.path.join(work, 'in.hwpx'); shutil.copy(src, inp)
res = {}
owned_hwp = runpy.run_path(sys.argv[5])['owned_hwp']
with owned_hwp(res) as hwp:
    res['open'] = hwp.Open(inp, 'HWPX', 'forceopen:true')
    if not res['open']: raise RuntimeError('한/글이 입력 문서를 열지 못했습니다')
    res['pages'] = hwp.PageCount
    res['is_track_change'] = hwp.IsTrackChange
    res['text_final'] = hwp.GetTextFile('TEXT', '')
    if want_pdf:
        hwp.SaveAs(os.path.join(work, 'view.pdf'), 'PDF', ''); res['pdf'] = True
    if apply_all:
        res['apply_all'] = hwp.HAction.Run('TrackChangeApplyAll')
        res['text_after_apply'] = hwp.GetTextFile('TEXT', '')
    hwp.SaveAs(os.path.join(work, 'saved.hwpx'), 'HWPX', '')
    res['saved'] = os.path.exists(os.path.join(work, 'saved.hwpx'))
sys.stdout.buffer.write(json.dumps(res, ensure_ascii=False).encode('utf-8'))
'''


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    flags = {a for a in sys.argv[1:] if a.startswith('--')}
    if len(args) < 2:
        print(__doc__); sys.exit(2)
    src, out_dir = os.path.abspath(args[0]), os.path.abspath(args[1])
    os.makedirs(out_dir, exist_ok=True)
    work = tempfile.mkdtemp(prefix='hwpx_rt_')
    child = os.path.join(work, 'child.py')
    with open(child, 'w', encoding='utf-8') as f:
        f.write(CHILD)
    result = {'src': src}
    try:
        helper = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'helpers', 'hangul_com.py')
        cp = subprocess.run([sys.executable, '-B', child, src, work, '1' if '--apply-all' in flags else '0', '1' if '--pdf' in flags else '0', helper],
                            capture_output=True, timeout=240)
        result['returncode'] = cp.returncode
        out = cp.stdout.decode('utf-8', 'replace').strip()
        result['stderr'] = cp.stderr.decode('utf-8', 'replace')[-800:]
        try:
            result.update(json.loads(out.splitlines()[-1]))
        except Exception:
            result['raw'] = out[-800:]
    except subprocess.TimeoutExpired:
        result['timeout'] = True
    result['ok'] = bool(result.get('returncode') == 0 and result.get('open') and result.get('saved'))
    for name in ('saved.hwpx', 'view.pdf'):
        p = os.path.join(work, name)
        if os.path.exists(p): shutil.copy(p, os.path.join(out_dir, name))
    shutil.rmtree(work, ignore_errors=True)
    with open(os.path.join(out_dir, 'result.json'), 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False, indent=1)
    sys.stdout.buffer.write((json.dumps({k: v for k, v in result.items() if k not in ('text_final', 'text_after_apply')}, ensure_ascii=False) + '\n').encode('utf-8'))
    if not result['ok']: sys.exit(1)


if __name__ == '__main__':
    main()
