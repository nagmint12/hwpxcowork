# 차트 그리기: 표준 입력의 차트 명세(JSON, server/chart.js normChart 가 검사한 것) → 표준 출력 PNG.
# 보고서 그림 꼴: 폭 2000px(10in × 200dpi), 제목은 그리지 않는다(문서 캡션 '[그림 N] 제목'이 맡는다),
# 표준서식 글꼴(KoPubWorld돋움) → 없으면 다른 한글 글꼴, 옅은 가로 눈금선, 위·오른쪽 축선 없음,
# 계열 색은 연한 청록 → 남색(연도 등 차례), 응답분포(stacked_hbar)는 주황 → 청록 갈림 색.
import json
import sys
import textwrap

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib import font_manager  # noqa: E402

FONTS = ['KoPubWorldDotum', 'KoPubWorld돋움체', 'Noto Sans KR', 'Malgun Gothic', 'NanumGothic', 'Noto Sans CJK KR', 'AppleGothic']
SEQ = ['#A8DDC0', '#6CC4C0', '#3A9DC4', '#2A6BA8', '#1F2F7A']
DIV = {2: ['#E9C46A', '#5B93AB'], 3: ['#E9C46A', '#F6EEC9', '#8FBFCD'], 4: ['#F2A65A', '#E9C46A', '#8FBFCD', '#5B93AB'],
       5: ['#F2A65A', '#E9C46A', '#F6EEC9', '#8FBFCD', '#5B93AB']}
INK = '#333333'
GRID = '#E3E3E3'


def pick_font():
    have = {f.name for f in font_manager.fontManager.ttflist}
    for name in FONTS:
        if name in have:
            return name
    return 'DejaVu Sans'


def lerp(c1, c2, t):
    a = [int(c1[i:i + 2], 16) for i in (1, 3, 5)]
    b = [int(c2[i:i + 2], 16) for i in (1, 3, 5)]
    return '#' + ''.join('%02X' % round(x + (y - x) * t) for x, y in zip(a, b))


def ramp(stops, n):
    """stops 를 따라 n 색(1이면 끝 색)"""
    if n == 1:
        return [stops[-1]]
    out = []
    for i in range(n):
        p = i * (len(stops) - 1) / (n - 1)
        j = min(int(p), len(stops) - 2)
        out.append(lerp(stops[j], stops[j + 1], p - j))
    return out


def wrap(label, width):
    s = str(label)
    lines = textwrap.wrap(s, width=width, break_long_words=True, break_on_hyphens=False) or ['']
    return '\n'.join(lines[:3])


def decimals(spec, values):
    if spec.get('decimals') is not None:
        return int(spec['decimals'])
    vs = [v for v in values if v is not None]
    if all(float(v).is_integer() for v in vs):
        return 0
    return 2 if vs and max(abs(v) for v in vs) < 10 else 1


def fmt(v, d, unit):
    return ('%.' + str(d) + 'f') % v + (unit if unit == '%' else '')


def style_axes(ax, horizontal):
    for side in ('top', 'right'):
        ax.spines[side].set_visible(False)
    ax.spines['left' if horizontal else 'bottom'].set_color('#999999')
    ax.spines['bottom' if horizontal else 'left'].set_visible(False)
    ax.tick_params(colors=INK, length=0, labelsize=12)
    ax.grid(axis='x' if horizontal else 'y', color=GRID, linewidth=1)
    ax.set_axisbelow(True)


def legend(fig, ax, handles, n):
    if n > 1:
        ax.legend(handles=handles, loc='lower right', bbox_to_anchor=(1.0, 1.01), ncol=min(n, 6), frameon=False,
                  fontsize=12, handlelength=1.0, handleheight=1.0, columnspacing=1.4, borderaxespad=0)


def main():
    spec = json.loads(sys.stdin.buffer.read().decode('utf-8'))
    kind = spec['type']
    cats = spec['categories']
    series = spec['series']
    unit = spec.get('unit') or ''
    n, m = len(cats), len(series)
    plt.rcParams['font.family'] = [pick_font(), 'DejaVu Sans']
    plt.rcParams['axes.unicode_minus'] = False
    horizontal = kind in ('hbar', 'stacked_hbar')
    height = max(2.4, 0.55 * n * (1 if kind == 'stacked_hbar' else max(1, m * 0.45)) + 1.4) if horizontal else 5.0
    fig, ax = plt.subplots(figsize=(10, min(height, 14)), dpi=200)
    style_axes(ax, horizontal)
    allv = [v for s in series for v in s['values'] if v is not None]
    d = decimals(spec, allv)
    labels_mode = spec.get('value_labels') or ('all' if m <= 3 else 'last')
    handles = []

    if kind in ('bar', 'hbar'):
        colors = ramp(SEQ, m) if m > 1 else ['#2A5C9A']
        group = 0.8
        w = group / m
        for k, s in enumerate(series):
            pos = [i - group / 2 + w * (k + 0.5) for i in range(n)]
            vals = [v if v is not None else 0 for v in s['values']]
            if horizontal:
                bars = ax.barh(pos, vals, height=w * 0.9, color=colors[k], label=s['name'])
            else:
                bars = ax.bar(pos, vals, width=w * 0.9, color=colors[k], label=s['name'])
            handles.append(bars)
            if labels_mode == 'all' or (labels_mode == 'last' and k == m - 1):
                for b, v in zip(bars, s['values']):
                    if v is None:
                        b.set_visible(False)
                        continue
                    if horizontal:
                        ax.annotate(fmt(v, d, unit), (b.get_width(), b.get_y() + b.get_height() / 2), xytext=(4, 0),
                                    textcoords='offset points', va='center', ha='left', fontsize=11, color=INK)
                    else:
                        ax.annotate(fmt(v, d, unit), (b.get_x() + b.get_width() / 2, b.get_height()), xytext=(0, 3),
                                    textcoords='offset points', ha='center', va='bottom', fontsize=11, color=INK)
            else:
                for b, v in zip(bars, s['values']):
                    if v is None:
                        b.set_visible(False)
        if horizontal:
            ax.set_yticks(range(n))
            ax.set_yticklabels([wrap(c, 14) for c in cats])
            ax.invert_yaxis()
        else:
            ax.set_xticks(range(n))
            ax.set_xticklabels([wrap(c, max(4, int(64 / max(n, 1)))) for c in cats])
    elif kind == 'line':
        colors = ramp(SEQ, m) if m > 1 else ['#1F3864']
        for k, s in enumerate(series):
            xs = [i for i, v in enumerate(s['values']) if v is not None]
            ys = [v for v in s['values'] if v is not None]
            line, = ax.plot(xs, ys, marker='o', markersize=6, linewidth=2, color=colors[k], label=s['name'])
            handles.append(line)
            if labels_mode == 'all' or (labels_mode == 'last' and k == m - 1):
                for x, y in zip(xs, ys):
                    ax.annotate(fmt(y, d, unit), (x, y), xytext=(0, 8), textcoords='offset points', ha='center', fontsize=11, color=INK)
        ax.set_xticks(range(n))
        ax.set_xticklabels([wrap(c, max(4, int(64 / max(n, 1)))) for c in cats])
        ax.set_xlim(-0.4, n - 0.6)
    else:  # stacked_hbar — 행마다 계열을 100% 로 쌓는다(응답분포)
        colors = DIV.get(m) or ramp(['#F2A65A', '#F6EEC9', '#5B93AB'], m)
        rows = []
        for i in range(n):
            vals = [max(0.0, s['values'][i] or 0.0) for s in series]
            tot = sum(vals)
            rows.append([v * 100.0 / tot if tot else 0.0 for v in vals])
        left = [0.0] * n
        for k, s in enumerate(series):
            vals = [rows[i][k] for i in range(n)]
            bars = ax.barh(range(n), vals, left=left, height=0.62, color=colors[k], edgecolor='white', linewidth=1.2, label=s['name'])
            handles.append(bars)
            if labels_mode != 'none':
                for i, (b, v) in enumerate(zip(bars, vals)):
                    if v >= 5:
                        ax.text(left[i] + v / 2, i, ('%.' + str(spec.get('decimals') if spec.get('decimals') is not None else 1) + 'f') % v,
                                ha='center', va='center', fontsize=11, color=INK)
            left = [a + b for a, b in zip(left, vals)]
        ax.set_yticks(range(n))
        ax.set_yticklabels([wrap(c, 14) for c in cats])
        ax.invert_yaxis()
        ax.set_xlim(0, 100)
        ax.set_xticks([0, 25, 50, 75, 100])
        ax.set_xticklabels(['0%', '25%', '50%', '75%', '100%'])

    if kind != 'stacked_hbar':
        lo, hi = spec.get('y_min'), spec.get('y_max')
        if lo is None and kind in ('bar', 'hbar'):
            lo = 0 if not allv or min(allv) >= 0 else None
        if horizontal:
            ax.set_xlim(left=lo, right=hi)
        else:
            ax.set_ylim(bottom=lo, top=hi)
    if spec.get('y_label'):
        (ax.set_xlabel if horizontal else ax.set_ylabel)(spec['y_label'], fontsize=12, color=INK)
    legend(fig, ax, handles, m)
    fig.tight_layout()
    fig.savefig(sys.stdout.buffer, format='png', dpi=200, facecolor='white')


if __name__ == '__main__':
    main()
