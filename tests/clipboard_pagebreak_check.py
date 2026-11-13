"""Actual Hancom PDF regression: the tutorial heading must start on the next page.

Used by clipboard_hancom_ui.py, and by the ego-browser clipboard QA runs.
Counts alone cannot detect a page break that became an ordinary paragraph break.
"""
import json
import pathlib
import re
import sys
import pymupdf


def inspect_pdf(file):
    with pymupdf.open(file) as pdf:
        pages = [re.sub(r'\s+', '', page.get_text()) for page in pdf]
        before = [i + 1 for i, text in enumerate(pages) if '꼬리말·쪽번호까지옮겨집니다.' in text]
        heading = [i + 1 for i, text in enumerate(pages) if '4)엉뚱한서식' in text]
        formats = [i + 1 for i, text in enumerate(pages) if '굵게·기울임·밑줄' in text]
        # The full document also has the heading in its table of contents.
        actual_heading = next((p for p in reversed(heading) if p in formats), None)
        preceding = before[-1] if before else None
        return {'pages': len(pdf), 'beforePage': preceding, 'headingPage': actual_heading,
                'formatsPages': formats,
                'nextPage': preceding is not None and actual_heading == preceding + 1,
                'headingOccurrences': len(heading)}


def verify_pdf(file):
    result = inspect_pdf(file)
    assert result['nextPage'], f'쪽 나눔이 줄바꿈으로 변했습니다: {file}: {result}'
    return result


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf8')
    for arg in sys.argv[1:]:
        file = pathlib.Path(arg)
        print(json.dumps({'file': str(file), **verify_pdf(file)}, ensure_ascii=False))
