"""Run against the Pages build or its published URL in a fresh Chromium profile."""
import argparse
import io
import zipfile
import xml.etree.ElementTree as ET

from playwright.sync_api import sync_playwright
from ui_pages_personal import ROOT, editor, point, site


def body_document(family):
    """Same 바탕글 and text in both controls; only its declared face changes."""
    buf = io.BytesIO()
    with zipfile.ZipFile(ROOT / 'server/templates/blank.hwpx') as src, zipfile.ZipFile(buf, 'w') as dst:
        for entry in src.infolist():
            data = src.read(entry)
            if entry.filename == 'Contents/header.xml':
                assert b'face="Noto Sans KR"' in data
                data = data.replace(b'face="Noto Sans KR"', f'face="{family}"'.encode())
            elif entry.filename == 'Contents/section0.xml':
                assert data.count(b'<hp:t/>') == 1
                data = data.replace(b'<hp:t/>', '<hp:t>a2.한</hp:t>'.encode())
            dst.writestr(entry, data)
    return {'name': family + '.hwpx', 'mimeType': 'application/octet-stream', 'buffer': buf.getvalue()}


# Observe the document's actual Canvas runs, including the very first paint.
WATCH = """(() => {
  window.bodyDraws = new Map();
  for (const C of [window.CanvasRenderingContext2D, window.OffscreenCanvasRenderingContext2D].filter(Boolean)) {
    const draw = C.prototype.fillText;
    C.prototype.fillText = function(text, ...args) {
      if (this.canvas.classList?.contains('document-page-canvas')) {
        for (const c of text) if ('a2.한'.includes(c) && !window.bodyDraws.has(c)) {
          const ready = [...document.fonts].some(f => f.family.replaceAll('"','') === 'Noto Sans KR'
            && f.weight === '400' && f.status === 'loaded');
          window.bodyDraws.set(c, {raw:this.font, ready});
        }
      }
      return draw.call(this, text, ...args);
    };
  }
})();"""

# Repaint the captured chains using real glyphs and the same CSS size/weight.
# Reproduce a computer with the bundled text faces and Wingdings, without KoPub/Hancom.
# Keep candidate order, symbol fonts and ordinary Latin platform families intact.
COMPARE = """async ({family}) => {
  // Use a separate document so the editor's Canvas font substitution cannot also
  // rewrite the independent reference. Load the same public font bytes by URL.
  const probe = document.createElement('iframe');
  probe.hidden = true;
  document.body.append(probe);
  try {
    const win = probe.contentWindow, doc = win.document;
    for (const family of ['Noto Sans KR', 'Noto Serif KR']) {
      const url = new URL('./fonts/' + family.replaceAll(' ', '') + '-Regular.woff2', location.href);
      doc.fonts.add(await new win.FontFace(family, 'url("' + url + '")').load());
    }
    async function installed(name) {
      try { await new win.FontFace('FontPresenceProbe', 'local("' + name + '")').load(); return true; }
      catch { return false; }
    }
    const hasWingdings = await installed('Wingdings');
    const hasKoPub = await installed('KoPubDotum Medium');
    const css = doc.createElement('span').style;
    const canvas = doc.createElement('canvas');
    canvas.width = 160; canvas.height = 60;
    const ctx = canvas.getContext('2d', {willReadFrequently:true});
    const bitmap = (font, text) => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.font = font; ctx.fillText(text, 6, 42);
      if (!ctx.getImageData(0,0,160,60).data.some(v => v)) throw Error('Empty reference glyph: ' + text);
      return canvas.toDataURL();
    };
    const allowed = new Set(['Noto Sans KR', 'Noto Serif KR', 'Arial', 'Times New Roman',
      'serif', 'sans-serif', 'monospace', 'Wingdings', 'Wingdings 2', 'Wingdings 3', 'Webdings', 'Symbol']);
    return [...bodyDraws].map(([c, {raw, ready}]) => {
      css.font = raw;
      const original = css.fontFamily.split(',').map(f => f.trim().replace(/^["']|["']$/g,''));
      const native = bitmap(css.font,c);
      css.fontFamily = original.filter(f => allowed.has(f)).map(f => f.includes(' ') ? '"' + f + '"' : f).join(',');
      const missing = bitmap(css.font,c);
      css.fontFamily = '"Noto Sans KR"';
      const noto = bitmap(css.font,c);
      css.fontFamily = 'Wingdings';
      const wing = bitmap(css.font,c);
      css.fontFamily = '"KoPubDotum Medium"';
      return {c, raw, ready, original, hasWingdings, hasKoPub, usesWingdings: missing === wing, usesKoPub: native === bitmap(css.font,c),
        samePixels: missing === (family === 'Wingdings' ? wing : noto), distinct: noto !== wing,
        size: css.fontSize, weight: css.fontWeight};
    });
  } finally { probe.remove(); }
}"""


def check_paint(results, family):
    assert {r['c'] for r in results} == set('a2.한'), results
    for row in results:
        assert row['ready'], row
        if row['hasWingdings'] and row['c'] in 'a2.':
            assert row['distinct'], row
        if family == 'Wingdings':
            if row['c'] == '한':
                continue  # Wingdings does not contain Hangul.
            assert family in row['original'], row
            if row['hasWingdings']:
                assert row['original'][0] == family and row['samePixels'], row
        else:
            assert not any('wingdings' in f.lower() for f in row['original']), row
            assert row['samePixels'], row
            if family == 'KoPub돋움체':
                if row['hasKoPub']:
                    assert row['original'][0].startswith('KoPub') and row['usesKoPub'], row
            if family == 'Noto Sans KR':
                assert row['original'][0] == family and row['size'] == '13.333px', row
                assert row['weight'] in ('', 'normal', '400'), row


def run(pw, url, channel):
    browser = pw.chromium.launch(**({'channel': channel} if channel else {}))
    context = browser.new_context(viewport={'width': 1440, 'height': 900})
    context.add_init_script(WATCH)
    for family in ['Noto Sans KR', 'KoPub돋움체', 'Wingdings']:
        page = context.new_page()
        page.goto(url)
        try:
            page.get_by_test_id('office-new-document').wait_for(state='attached', timeout=90000)
        except Exception as error:
            raise RuntimeError(f"{family}: {page.locator('body').inner_text()[:400]}") from error
        if family == 'Noto Sans KR':
            page.get_by_test_id('office-new-document').click()
            page.get_by_test_id('folder-name').fill('기본 글꼴 확인')
            page.get_by_test_id('folder-name-ok').click()
            editor(page)
            page.mouse.click(*point(page, 's0/p0', 0))
            page.keyboard.type('a2.')
            page.keyboard.insert_text('한')
        else:
            page.get_by_test_id('office-file-input').set_input_files(body_document(family))
            editor(page)
        frame = next(f for f in page.frames if '/studio/cowork-embed.html' in f.url)
        frame.wait_for_function("['a','2','.','한'].every(c => window.bodyDraws?.has(c))", timeout=60000)
        results = frame.evaluate(COMPARE, {'family': family})
        check_paint(results, family)
        # Resolve the original font references from the persisted HWPX, separately from paint.
        saved = page.evaluate("""async () => {
          const r = await fetch(new URL('api/docs/' + window.__doc.id + '/file', location.href));
          if (!r.ok) throw Error(r.status);
          return Array.from(new Uint8Array(await r.arrayBuffer()));
        }""")
        with zipfile.ZipFile(io.BytesIO(bytes(saved))) as doc:
            header = ET.fromstring(doc.read('Contents/header.xml'))
            style = header.find(".//{*}style[@name='바탕글']")
            shape = header.find(f".//{{*}}charPr[@id='{style.get('charPrIDRef')}']")
            for slot, face_id in shape.find('{*}fontRef').attrib.items():
                group = header.find(f".//{{*}}fontface[@lang='{slot.upper()}']")
                assert group.find(f"{{*}}font[@id='{face_id}']").get('face') == family
        print('PASS', family, ', '.join(r['c'] for r in results), 'system Wingdings:', results[0]['hasWingdings'], flush=True)
        page.close()
    browser.close()


if __name__ == '__main__':
    cli = argparse.ArgumentParser()
    cli.add_argument('target')
    cli.add_argument('--channel', default='')
    args = cli.parse_args()
    with site(args.target) as address, sync_playwright() as pw:
        run(pw, address, args.channel)
