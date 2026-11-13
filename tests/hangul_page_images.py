# 한글(한/글) COM CreatePageImage 로 HWPX 의 쪽 그림을 만들고, 쪽마다 "표식 색" 영역의 상자를 뽑는다 (Windows + 한글 설치 필요).
# 인쇄(Print·PDF 저장)를 거치지 않는 한/글 자체의 쪽 그림 렌더러다 — 물리 화면 캡처는 아니다(docs/HANCOM_WEB_SCREEN_ORACLE_ADDENDUM_2026-11-02.md).
# 사용: python -I tests/hangul_page_images.py <in.hwpx> <out_dir> [--colors '#RRGGBB,...'] [--keep-images] [--save] [--para-pages <문단 번호 JSON>]
# 결과: out_dir/page_images.json — {"pages": N, "dpi": 96, "images": [{"page", "w", "h", "ink": [x0,y0,x1,y1] | null,
#        "colors": {"#RRGGBB": [[x0,y0,x1,y1], ...]}}]}  (px, 96dpi, 쪽 왼쪽 위 원점. 같은 색의 떨어진 덩어리는 따로)
#        --save 면 out_dir/saved.hwpx(한/글 재저장본 = 저장 조판), --keep-images 면 out_dir/page-<n>.png 도 남긴다.
#        --para-pages 면 "paraPages": {"문단 번호": 쪽(0부터)} — 첫 구역 본문 문단의 첫 글자가 놓인 쪽(KeyIndicator). 단이 있어도 쪽으로 센다.
# 주의: 입출력은 임시 폴더에서만 하고, SetMessageBoxMode 를 먼저 부르고, 내가 띄운 Hwp.exe 만 정리한다(tests/hangul_roundtrip.py 와 같은 규칙).
import json
import os
import shutil
import subprocess
import sys
import tempfile

CHILD = r'''
import sys, os, json, runpy
from PIL import Image
src, work, colors, keep, save, para_file = sys.argv[1], sys.argv[2], [c for c in sys.argv[3].split(',') if c], sys.argv[4] == '1', sys.argv[5] == '1', sys.argv[6]
import shutil; inp = os.path.join(work, 'in.hwpx'); shutil.copy(src, inp)
want = {tuple(int(c[i:i + 2], 16) for i in (1, 3, 5)): c.upper() for c in colors}
res = {'dpi': 96, 'images': []}

import numpy as np
from scipy import ndimage

def boxes(img):
    """표식 색마다 연결된 덩어리의 상자(8-이웃, 16px 미만 덩어리는 버림). 잉크(흰색이 아닌 픽셀) 전체 상자도."""
    a = np.asarray(img)
    def bbox(mask):
        ys, xs = np.nonzero(mask)
        return None if len(xs) == 0 else [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1]
    ink = bbox((a < 245).any(axis=2))
    out = {}
    af = a.astype(np.float32)
    for rgb, c in want.items():
        # 색 맞춤은 ±2 — 한/글 그림 렌더러의 색 반올림
        col = np.array(rgb, dtype=np.float32)
        core = (np.abs(af - col) <= 2).all(axis=2)
        # 가장자리: 한/글은 그림을 줄이거나 늘릴 때 가장자리 1~2px 을 흰 바탕과 섞어 그린다.
        # 표식 색과 흰색 사이의 섞인 색(섞임 비율 0.3 이상)이 덩어리 바로 옆(3px 안)에 있으면 덩어리에 넣는다.
        alpha = ((255 - af) * (255 - col)).sum(axis=2) / max(1.0, float(((255 - col) ** 2).sum()))
        blend = (alpha >= 0.3) & (np.abs(af - (255 - alpha[..., None] * (255 - col))) <= 12).all(axis=2)
        if core.any():
            mask = core | (blend & ndimage.binary_dilation(core, iterations=3))
        else:
            # 가는 선은 표식 색 그대로인 화소가 없이 모두 섞여 그려진다(앤티에일리어싱) — 섞임 비율 0.4 이상만 모은다.
            mask = blend & (alpha >= 0.4)
            if not mask.any(): continue
        lab, n = ndimage.label(mask, structure=np.ones((3, 3)))
        parts = []
        for sl in ndimage.find_objects(lab):
            if (sl[0].stop - sl[0].start) * (sl[1].stop - sl[1].start) >= 16:
                parts.append([int(sl[1].start), int(sl[0].start), int(sl[1].stop), int(sl[0].stop)])
        out[c] = sorted(parts, key=lambda b: (b[1], b[0]))
    return ink, out

owned_hwp = runpy.run_path(sys.argv[7])['owned_hwp']
with owned_hwp(res) as hwp:
    res['open'] = hwp.Open(inp, 'HWPX', 'forceopen:true')
    if not res['open']: raise RuntimeError('한/글이 입력 문서를 열지 못했습니다')
    res['pages'] = int(hwp.PageCount)
    try: res['is_track_change'] = hwp.IsTrackChange
    except Exception: pass
    for pg in range(res['pages']):
        bmp = os.path.join(work, 'page.bmp')
        ok = hwp.CreatePageImage(bmp, pg, 96, 24, 'bmp')
        if not ok or not os.path.exists(bmp):
            res['images'].append({'page': pg, 'error': 'CreatePageImage'}); continue
        with Image.open(bmp) as im:
            img = im.convert('RGB')
        ink, cb = boxes(img)
        res['images'].append({'page': pg, 'w': img.size[0], 'h': img.size[1], 'ink': ink, 'colors': cb})
        if keep: img.save(os.path.join(work, 'page-%d.png' % (pg + 1)))
        os.remove(bmp)
    if para_file:
        # 'all' 이면 본문 문단 전부(문서 끝 문단 번호까지). 문단 번호는 구역이 바뀌어도 이어진다.
        if para_file == 'all':
            hwp.MovePos(3, 0, 0)  # moveDocEnd
            paras = list(range(int(hwp.GetPos()[1]) + 1))
        else:
            with open(para_file, encoding='utf-8') as f: paras = json.load(f)
        res['paraPages'] = {}
        res['paraSections'] = {}
        for p in paras:
            if not hwp.SetPos(0, int(p), 0): res['paraPages'][str(p)] = None; continue
            ki = hwp.KeyIndicator()  # (성공, 구역 수, 구역, 쪽, 단, 줄, 칸, 삽입/수정, 조판 부호 이름)
            res['paraPages'][str(p)] = int(ki[3]) - 1
            res['paraSections'][str(p)] = int(ki[2]) - 1
    if save:
        saved = os.path.join(work, 'saved.hwpx')
        res['saved'] = bool(hwp.SaveAs(saved, 'HWPX', '')) and os.path.isfile(saved)
with open(os.path.join(work, 'page_images.json'), 'w', encoding='utf-8') as f: json.dump(res, f)
print('ok', res.get('pages'))
'''


def main():
    flags = sys.argv[1:]
    opt = lambda k: flags[flags.index(k) + 1] if k in flags else ''
    colors, para_file = opt('--colors'), opt('--para-pages')
    args = [a for a in flags if not a.startswith('--') and a not in (colors, para_file)]
    if len(args) < 2:
        print(__doc__); sys.exit(2)
    if para_file and para_file != 'all': para_file = os.path.abspath(para_file)
    src, out_dir = os.path.abspath(args[0]), os.path.abspath(args[1])
    os.makedirs(out_dir, exist_ok=True)
    work = tempfile.mkdtemp(prefix='hwpx_pi_')
    child = os.path.join(work, 'child.py')
    with open(child, 'w', encoding='utf-8') as f:
        f.write(CHILD)
    result = {'src': src}
    try:
        helper = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'helpers', 'hangul_com.py')
        cp = subprocess.run([sys.executable, '-B', child, src, work, colors, '1' if '--keep-images' in flags else '0', '1' if '--save' in flags else '0', para_file, helper],
                            capture_output=True, timeout=1800)
        result['returncode'] = cp.returncode
        result['stdout'] = cp.stdout.decode('utf-8', 'replace')[-300:]
        result['stderr'] = cp.stderr.decode('utf-8', 'replace')[-800:]
    except subprocess.TimeoutExpired:
        result['timeout'] = True
    pj = os.path.join(work, 'page_images.json')
    if os.path.exists(pj):
        with open(pj, encoding='utf-8') as f: result.update(json.load(f))
    result['ok'] = bool(result.get('returncode') == 0 and result.get('open') and result.get('pages', 0) > 0
                        and len(result.get('images', [])) == result.get('pages')
                        and all(not im.get('error') for im in result.get('images', [])))
    if '--save' in flags and not result.get('saved'): result['ok'] = False
    for name in os.listdir(work):
        if name == 'saved.hwpx' or (name.startswith('page-') and name.endswith('.png')):
            shutil.copy(os.path.join(work, name), os.path.join(out_dir, name))
    shutil.rmtree(work, ignore_errors=True)
    with open(os.path.join(out_dir, 'page_images.json'), 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False)
    sys.stdout.buffer.write((json.dumps({k: v for k, v in result.items() if k != 'images'}, ensure_ascii=False) + '\n').encode('utf-8'))
    if not result['ok']: sys.exit(1)


if __name__ == '__main__':
    main()
