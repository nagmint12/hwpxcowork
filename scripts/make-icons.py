#!/usr/bin/env python3
# hwpx-cowork 아이콘 만들기(2026-11-18 — 사용자가 준 icon/hwpx-cowork.png 로 모든 아이콘을 바꿈).
#   node scripts/make-icons.mjs        (= python -I scripts/make-icons.py, Pillow·numpy 필요)
# 원본: icon/hwpx-cowork.png(1254px, 연보라 바탕 위 보라 문서 두 장 — 1MB). 원본은 그대로 두고 쓰임마다 알맞은 크기로 줄여 담는다.
#   쓰는 모양 셋
#     투명  = 문서 두 장과 그림자 — 웹의 128px 브랜드 그림·브라우저 탭·Windows·Mac·Android 예전 아이콘
#     정사각 = 같은 구도의 불투명 정사각형 — 홈 화면과 편집기 apple-touch-icon
#     적응형 = Android 8+ 적응형 아이콘 앞층(108dp, 문서 묶음이 가운데 66dp 안전 원 안) + 바탕색 층
#   용량: 낱장 PNG 는 128px 이하는 그대로(트루컬러), 그보다 큰 것은 256색 팔레트(k-평균, 오차 확산 없음 — 원본과 PSNR 약 48dB)로 줄인다.
#         ICO·ICNS 안의 그림은 32비트 RGBA PNG 그대로 둔다(Windows·macOS 호환).
# 결과
#   web/favicon.ico(16~64, 브라우저) · web/icons/hwpx-cowork.ico(16~256 — Windows 앱·설치 프로그램·PC 묶음 바로 가기)
#   web/icons/icon-{128,192,256,512}.png(정사각) · web/icons/hwpx-cowork.icns(Mac 앱 — package-macos-*.mjs)
#   mobile-rhwp/web/branding/(favicon.ico·icons/) · mobile-rhwp/android/app/src/main/res(mipmap-*·적응형 xml·바탕색)
#   deploy/desktop/loading-icon.webp(움직이는 원본 icon/HWPX-Cowork-Animated.webp → 160px)·app-icon.png · deploy/installer/installer-{sidebar,header}.bmp(설치 마법사)
# 웹 화면·편집기(/studio/ — scripts/build-studio.mjs 가 rhwp 아이콘 대신 넣음)·Windows 앱·PC 묶음·Mac 편집기·Android 앱이 모두 이 아이콘을 쓴다.
import io
import math
import os
import shutil
import struct
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
SRC = os.path.join(ROOT, 'icon', 'hwpx-cowork.png')
TILE_FRAC = 0.78        # 타일·정사각에서 문서 묶음(긴 변)이 차지하는 몫
ROUND_FRAC = 0.74       # 둥근(원형) 아이콘 — 묶음이 원 안에 들도록 조금 작게
MAC_BODY = 824 / 1024   # macOS 아이콘 격자: 1024 캔버스 안 824 몸체
ADAPTIVE_SAFE = 33 / 108  # Android 적응형 아이콘 안전 원 반지름(108dp 층 대비)
TRUECOLOR_MAX = 128     # 이 크기 이하는 팔레트로 줄이지 않는다
SHARPEN_MAX = 48        # 이 크기 이하 타일은 살짝 또렷하게(16px 탭 아이콘의 글줄이 뭉개지지 않게)


def backdrop(pixels):
    edge = np.concatenate([pixels[:8].reshape(-1, 3), pixels[-8:].reshape(-1, 3),
                           pixels[:, :8].reshape(-1, 3), pixels[:, -8:].reshape(-1, 3)])
    return np.median(edge, axis=0)


def load():
    img = Image.open(SRC).convert('RGB')
    a = np.asarray(img, dtype=np.float32)
    bg = backdrop(a)
    dist = np.sqrt(((a - bg) ** 2).sum(2))
    ys, xs = np.where(dist > 60)   # 바탕과 뚜렷이 다른 곳 = 문서 묶음(옅은 그림자 제외)
    cx, cy = (xs.min() + xs.max()) / 2, (ys.min() + ys.max()) / 2
    span = max(xs.max() - xs.min(), ys.max() - ys.min())
    reach = math.sqrt(((xs - cx) ** 2 + (ys - cy) ** 2).max())   # 묶음 가운데에서 가장 먼 점(안전 원 계산용)
    return img, tuple(int(round(v)) for v in bg), (cx, cy), span, reach


SRC_IMG, BG, CENTER, SPAN, REACH = load()


def transparent_mark(img):
    """원본 바탕과 이어지는 영역에만 알파를 부여하고 문서 안 흰색은 보존한다."""
    pixels = np.asarray(img, dtype=np.float32)
    bg = backdrop(pixels)
    difference = pixels - bg
    distance = np.linalg.norm(difference, axis=2)

    # 보라색 윤곽을 경계로 삼는다. 닫힌 윤곽 안쪽의 흰 문서 면은 바탕색과 가까워도 불투명하다.
    exterior = Image.fromarray(np.where(distance >= 55, 255, 0).astype(np.uint8)).copy()
    ImageDraw.floodfill(exterior, (0, 0), 128)
    body = np.asarray(exterior) != 128
    edge = np.asarray(Image.fromarray(body).convert('L').filter(ImageFilter.MaxFilter(5))) > 0
    alpha = np.where(body, 1, np.clip((distance - 5) / 50, 0, 1))[:, :, None]
    color = np.clip(bg + difference / np.maximum(alpha, 1 / 255), 0, 255)
    # 로고에서 떨어진 곳의 그림자는 어두운 보라로 다시 합성한다. 원본의 밝은 바탕이 후광으로 남는 것을 막는다.
    shadow = np.array([70, 35, 118], dtype=np.float32)
    shadow_delta = shadow - bg
    shadow_alpha = (difference * shadow_delta).sum(axis=2) / (shadow_delta ** 2).sum()
    alpha = np.where(edge[:, :, None], alpha, np.clip(shadow_alpha - 0.018, 0, 1)[:, :, None])
    color = np.where(alpha > 0, np.where(edge[:, :, None], color, shadow), 0)
    return Image.fromarray(np.rint(np.concatenate((color, 255 * alpha), axis=2)).astype(np.uint8))


MARK = transparent_mark(SRC_IMG)


def framed(side_px, size, source=SRC_IMG):
    """묶음 가운데를 중심으로 원본에서 side_px 정사각을 잘라 size 로 줄인다. 원본 밖은 바탕색으로 채운다."""
    cx, cy = CENTER
    pad = int(math.ceil(max(0, side_px / 2 - min(cx, cy, SRC_IMG.width - cx, SRC_IMG.height - cy)))) + 2
    base = source
    if pad:
        fill = (0, 0, 0, 0) if source.mode == 'RGBA' else BG
        base = Image.new(source.mode, (source.width + 2 * pad, source.height + 2 * pad), fill)
        base.paste(source, (pad, pad))
    x0, y0 = cx + pad - side_px / 2, cy + pad - side_px / 2
    return base.resize((size, size), Image.LANCZOS, box=(x0, y0, x0 + side_px, y0 + side_px))


def square(size):
    return framed(SPAN / TILE_FRAC, size)


def tile(size):
    img = framed(SPAN / TILE_FRAC, size, MARK)
    if size <= SHARPEN_MAX:
        sharpened = img.convert('RGB').filter(ImageFilter.UnsharpMask(radius=0.6, percent=80, threshold=0))
        sharpened.putalpha(img.getchannel('A'))
        img = sharpened
    return img


def round_icon(size):
    return framed(SPAN / ROUND_FRAC, size, MARK)


def adaptive_foreground(size):
    # 108dp 층 전체를 채운다(바탕색과 같은 연보라) — 묶음은 가운데 66dp 원 안
    return framed(REACH / ADAPTIVE_SAFE, size)


_MAC = {}


def mac_icon(size):
    big = 1024
    if big not in _MAC:
        body = round(big * MAC_BODY)
        canvas = Image.new('RGBA', (big, big), (0, 0, 0, 0))
        canvas.alpha_composite(tile(body), ((big - body) // 2, (big - body) // 2))
        _MAC[big] = canvas
    return _MAC[big] if size == big else _MAC[big].resize((size, size), Image.LANCZOS)


# ── 줄이기: 256색 팔레트(k-평균) ────────────────────────────────────────────
def _nearest(px, centers, chunk=65536):
    out = np.empty(len(px), np.int32)
    c2 = (centers ** 2).sum(1)
    for i in range(0, len(px), chunk):
        p = px[i:i + chunk]
        out[i:i + chunk] = (c2[None, :] - 2 * p @ centers.T).argmin(1)
    return out


def _kmeans(px, k, iters=10):
    if len(px) <= k:
        return np.unique(px, axis=0).astype(float)
    rng = np.random.default_rng(20261118)
    samp = px[rng.choice(len(px), min(len(px), 150000), replace=False)]
    side = int(math.sqrt(len(samp)))
    seed = Image.fromarray(np.clip(samp[:side * side, :3], 0, 255).reshape(side, side, 3).astype(np.uint8))
    centers = np.array(seed.quantize(min(k, 256), method=Image.Quantize.MEDIANCUT).getpalette()[:k * 3], float).reshape(-1, 3)
    if px.shape[1] == 4:   # 반투명 점: 색(미리 곱한 값)과 알파를 함께 묶는다
        centers = np.concatenate([centers, np.full((len(centers), 1), samp[:, 3].mean())], 1)
    for _ in range(iters):
        a = _nearest(samp, centers)
        sums = np.zeros_like(centers)
        np.add.at(sums, a, samp)
        cnt = np.bincount(a, minlength=len(centers))
        ok = cnt > 0
        centers[ok] = sums[ok] / cnt[ok][:, None]
    return centers


def palette_png(img):
    """RGB/RGBA 를 256색 팔레트 PNG 로. 불투명 점과 반투명 점(가장자리)은 팔레트를 따로 나눠 가진다."""
    rgba = np.asarray(img.convert('RGBA')).astype(float)
    h, w, _ = rgba.shape
    flat = rgba.reshape(-1, 4)
    alpha = flat[:, 3]
    opaque, clear = alpha >= 255, alpha <= 0
    partial = ~opaque & ~clear
    n_partial = 32 if partial.any() else 0
    n_clear = 1 if clear.any() else 0
    idx = np.zeros(len(flat), np.int32)
    pal_rgb, pal_a = [], []
    c_op = _kmeans(flat[opaque, :3], 256 - n_partial - n_clear)
    idx[opaque] = _nearest(flat[opaque, :3], c_op)
    pal_rgb += list(c_op); pal_a += [255] * len(c_op)
    if n_partial:
        pm = np.concatenate([flat[partial, :3] * flat[partial, 3:] / 255, flat[partial, 3:]], 1)
        c_pa = _kmeans(pm, n_partial)
        idx[partial] = len(pal_rgb) + _nearest(pm, c_pa)
        for c in c_pa:
            a = max(c[3], 1)
            pal_rgb.append(c[:3] * 255 / a); pal_a.append(a)
    if n_clear:
        idx[clear] = len(pal_rgb)
        pal_rgb.append(np.zeros(3)); pal_a.append(0)
    p = Image.frombytes('P', (w, h), idx.astype(np.uint8).tobytes())
    p.putpalette(np.clip(np.round(np.array(pal_rgb)), 0, 255).astype(np.uint8).ravel().tolist())
    if n_partial or n_clear:
        p.info['transparency'] = bytes(int(round(min(255, max(0, a)))) for a in pal_a)
    return p


def png_bytes(img, palette=True):
    """palette=False: ICO·ICNS 안의 그림 — Windows·macOS 가 32비트 RGBA PNG 를 기대하므로 줄이지 않는다."""
    out = io.BytesIO()
    if palette and img.width > TRUECOLOR_MAX:
        p = palette_png(img)
        p.save(out, 'PNG', optimize=True, transparency=p.info.get('transparency'))
    else:
        img.save(out, 'PNG', optimize=True)
    return out.getvalue()


# ── 파일 형식 ──────────────────────────────────────────────────────────────
def ico_bytes(images):
    head = struct.pack('<HHH', 0, 1, len(images))
    entries, blobs, offset = b'', b'', 6 + 16 * len(images)
    for img in images:
        data = png_bytes(img, palette=False)
        s = img.width
        entries += struct.pack('<BBBBHHII', 0 if s >= 256 else s, 0 if s >= 256 else s, 0, 0, 1, 32, len(data), offset)
        blobs += data
        offset += len(data)
    return head + entries + blobs


# 같은 화소 크기의 @2x 종류(ic11~ic14)는 넣지 않는다 — macOS 는 화소 크기로 골라 쓴다(같은 그림을 두 번 담지 않게)
ICNS_TYPES = [(b'icp4', 16), (b'icp5', 32), (b'icp6', 64), (b'ic07', 128), (b'ic08', 256), (b'ic09', 512), (b'ic10', 1024)]


def icns_bytes():
    cache = {}
    body = b''
    for kind, size in ICNS_TYPES:
        if size not in cache:
            cache[size] = png_bytes(mac_icon(size), palette=False)
        body += kind + struct.pack('>I', 8 + len(cache[size])) + cache[size]
    return b'icns' + struct.pack('>I', 8 + len(body)) + body


def write(rel, data):
    path = os.path.join(ROOT, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb') as f:
        f.write(data)
    return rel, len(data)


def remove(rel):
    path = os.path.join(ROOT, rel)
    if os.path.exists(path):
        os.remove(path)
        print('지움:', rel)


ANIMATED = os.path.join(ROOT, 'icon', 'HWPX-Cowork-Animated.webp')   # 사용자 제공 움직이는 아이콘(512px, 90장 × 40ms)


def animated_tile(size):
    """타일 구도(묶음 78%)의 투명 WebP — 데스크톱 앱 '여는 중' 화면"""
    im = Image.open(ANIMATED)
    k = im.width / SRC_IMG.width   # 정지 원본과 같은 그림(구도)을 줄인 것
    side = SPAN / TILE_FRAC * k
    cx, cy = CENTER[0] * k, CENTER[1] * k
    box = (cx - side / 2, cy - side / 2, cx + side / 2, cy + side / 2)
    frames, durations = [], []
    for i in range(im.n_frames):
        im.seek(i)
        f = transparent_mark(im.convert('RGB')).resize((size, size), Image.LANCZOS, box=box)
        frames.append(f)
        durations.append(im.info.get('duration') or 40)
    out = io.BytesIO()
    frames[0].save(out, 'WEBP', save_all=True, append_images=frames[1:], duration=durations, loop=0, quality=82, method=6)
    return out.getvalue()


def installer_bitmap(width, height, icon_size, icon_at):
    """설치 마법사(NSIS) 그림 — 흰 바탕 위 타일 아이콘. NSIS 는 24비트 BMP 만 받는다."""
    img = Image.new('RGB', (width, height), (255, 255, 255))
    t = tile(icon_size)
    img.paste(t, icon_at, t)
    out = io.BytesIO()
    img.save(out, 'BMP')
    return out.getvalue()


def main():
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    made = []
    # Windows 앱(deploy/desktop): '내 문서를 여는 중' 화면의 움직이는 아이콘, 첫 실행 운영 방식 고르기 창 아이콘
    made.append(write('deploy/desktop/loading-icon.webp', animated_tile(160)))
    made.append(write('deploy/desktop/app-icon.png', png_bytes(tile(128))))
    # 설치 마법사(setup.exe) 왼쪽 그림 164×314 · 머리 그림 150×57 (scripts/package-windows-desktop.mjs)
    made.append(write('deploy/installer/installer-sidebar.bmp', installer_bitmap(164, 314, 104, (30, 62))))
    made.append(write('deploy/installer/installer-header.bmp', installer_bitmap(150, 57, 45, (99, 6))))
    # 웹·편집기·Windows
    # 브라우저 탭용은 64px 까지만(가볍게), Windows 실행 파일·설치 프로그램·바로 가기용은 256px 까지
    made.append(write('web/favicon.ico', ico_bytes([tile(s) for s in (16, 20, 24, 32, 40, 48, 64)])))
    made.append(write('web/icons/hwpx-cowork.ico', ico_bytes([tile(s) for s in (16, 20, 24, 32, 40, 48, 64, 256)])))
    for s in (128, 192, 256, 512):
        # 웹 머리글의 브랜드 그림은 배경을 비운다. 홈 화면용 이미지는 플랫폼이 모서리를 그린다.
        made.append(write(f'web/icons/icon-{s}.png', png_bytes(tile(s) if s == 128 else square(s))))
    made.append(write('web/icons/hwpx-cowork.icns', icns_bytes()))
    remove('web/icons/icon.svg')   # 예전 도형 아이콘(파란 사각형) — 래스터 원본으로 바꾸며 뺐다
    # Android 앱(mobile-rhwp) — 앱 안 편집기 favicon·아이콘은 웹과 같은 파일
    brand = 'mobile-rhwp/web/branding'
    shutil.copyfile(os.path.join(ROOT, 'web/favicon.ico'), os.path.join(ROOT, brand, 'favicon.ico'))
    for s in (128, 192, 256, 512):
        shutil.copyfile(os.path.join(ROOT, f'web/icons/icon-{s}.png'), os.path.join(ROOT, brand, f'icons/icon-{s}.png'))
    remove(f'{brand}/icons/icon.svg')
    res = 'mobile-rhwp/android/app/src/main/res'
    for density, legacy in (('mdpi', 48), ('hdpi', 72), ('xhdpi', 96), ('xxhdpi', 144), ('xxxhdpi', 192)):
        made.append(write(f'{res}/mipmap-{density}/ic_launcher.png', png_bytes(tile(legacy))))
        made.append(write(f'{res}/mipmap-{density}/ic_launcher_round.png', png_bytes(round_icon(legacy))))
        made.append(write(f'{res}/mipmap-{density}/ic_launcher_foreground.png', png_bytes(adaptive_foreground(legacy * 108 // 48))))
    adaptive = ('<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">'
                '<background android:drawable="@color/editor_icon_background"/>'
                '<foreground android:drawable="@mipmap/ic_launcher_foreground"/></adaptive-icon>\n')
    for name in ('ic_launcher', 'ic_launcher_round'):
        write(f'{res}/mipmap-anydpi-v26/{name}.xml', adaptive.encode())
    write(f'{res}/values/icon_colors.xml', ('<resources><color name="editor_icon_background">#%02X%02X%02X</color></resources>\n' % BG).encode())
    remove(f'{res}/drawable/ic_editor_foreground.xml')   # 예전 벡터 앞층(청록 문서·연필)
    for rel, n in made:
        print(f'{n:>8,}  {rel}')
    print(f'원본 {os.path.relpath(SRC, ROOT)} {SRC_IMG.width}px · 바탕색 #%02X%02X%02X · 묶음 {SPAN}px' % BG)


if __name__ == '__main__':
    sys.exit(main())
