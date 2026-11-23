"""Check the File menu and toolbar on a built Pages site in a disposable browser profile."""
import argparse
import pathlib
from playwright.sync_api import sync_playwright
from ui_pages_personal import FIXTURE, ROOT, editor, point, site, written_text


def exercise(page, url):
    page.on('dialog', lambda d: d.accept())
    page.goto(url)
    controls = page.locator('.lib-tools > .small')
    controls.first.wait_for()
    for width in (1500, 390, 320):
        page.set_viewport_size({'width': width, 'height': 850})
        for c in controls.all():
            if c.is_visible():
                assert c.evaluate("""e => getComputedStyle(e).paddingLeft === '9px' &&
                    getComputedStyle(e).paddingRight === '11px' && e.getBoundingClientRect().right <= innerWidth""")
    page.set_viewport_size({'width': 1500, 'height': 850})
    page.get_by_test_id('office-file-input').set_input_files([FIXTURE, ROOT / 'tests/fixtures/tool_memo_tracked.hwpx'])
    frame = editor(page)
    tabid = page.evaluate('window.__doc.id')
    for width in (1500, 390, 320):
        page.set_viewport_size({'width': width, 'height': 850})
        assert page.evaluate("""() => {
            const mid = e => e.getBoundingClientRect().top + e.offsetHeight/2;
            const home = document.querySelector('[data-testid=office-library]');
            const c = [...document.querySelectorAll('.office-bar button,.office-tab-item')].filter(x => x.offsetWidth && !x.closest('.office-popover,.office-product-menu'));
            return c.every(x => Math.abs(mid(x)-mid(home)) <= 0.5) && document.body.scrollWidth <= innerWidth;
        }""")
        if width == 320:
            assert page.locator('.office-tablist').evaluate('e => { e.scrollLeft = e.scrollWidth; return e.scrollLeft > 0 }')
    page.set_viewport_size({'width': 1500, 'height': 850})
    def menu(name='file'):
        item = frame.locator(f'.menu-item[data-menu="{name}"]')
        if 'open' not in item.get_attribute('class').split():
            item.locator('.menu-title').click()
        return item

    file = menu()
    assert file.locator('.menu-dropdown > :is(.md-item,.md-sub)').count() == 13
    assert file.locator('.menu-dropdown > .disabled').count() == 0
    # Compare the static command surface in all eight menus with the running embed.
    audit = frame.locator('#menu-bar').evaluate("""async bar => {
      const source = new DOMParser().parseFromString(await (await fetch('index.html')).text(),'text/html');
      return [...source.querySelectorAll('.menu-item[data-menu]')].map(orig => {
        const live = bar.querySelector('[data-menu="'+orig.dataset.menu+'"]');
        const missing = [...orig.querySelectorAll('[data-cmd]')].map(x=>x.dataset.cmd)
          .filter(cmd=>!live?.querySelector('[data-cmd="'+cmd+'"]'));
        return [orig.dataset.menu, missing];
      });
    }""")
    assert len(audit) == 8 and all(not missing for _, missing in audit), audit
    print('PASS eight menus, 13 File entries, padding, tab geometry and horizontal scrolling', flush=True)

    def command(cmd):
        group = cmd.split(':')[0]
        menu(group).locator(f'[data-cmd="{cmd}"]').first.click()

    with page.expect_file_chooser():
        command('file:open')
    marker = 'CoworkMenuSaved'
    page.mouse.click(*point(page, 's0/p0', 1))
    page.keyboard.type(marker)
    page.wait_for_function("mark => window.__doc.s.paragraphs.some(p => p.text.includes(mark))", arg=marker)
    command('file:save')
    assert page.evaluate('window.__doc.id') == tabid
    for cmd, extension in [('export-html','html'),('export-doc','doc'),('save-as-hwp','hwp'),
                           ('save-as-hwpx','hwpx'),('save-as','hwpx')]:
        with page.expect_download(timeout=12000) as result:
            command('file:' + cmd)
            if cmd.startswith('save-as'):
                name = frame.locator('.dialog-wrap:visible input[type=text]')
                name.fill('메뉴 시험 사본')
                frame.locator('.dialog-wrap:visible .dialog-btn-primary').click()
        content = pathlib.Path(result.value.path()).read_bytes()
        assert result.value.suggested_filename.lower().endswith('.' + extension)
        if extension == 'hwpx':
            assert marker in written_text(content)
        elif extension == 'hwp':
            assert content.startswith(bytes.fromhex('D0CF11E0A1B11AE1'))
        else:
            assert b'html' in content.lower() and len(content) > 200
        assert page.evaluate('window.__doc.id') == tabid
    print('PASS file chooser, save, Save As, HWP/HWPX/HTML/Word copies', flush=True)

    for cmd in ('file:about','file:page-setup'):
        command(cmd)
        frame.locator('.dialog-wrap:visible').first.wait_for()
        page.keyboard.press('Escape')
        frame.locator('.dialog-wrap:visible').first.wait_for(state='hidden')
    command('file:print-to-pdf')
    frame.get_by_test_id('pdf-print-dialog').wait_for()
    frame.locator('.dialog-wrap:visible .dialog-btn-primary').click()
    page.wait_for_function("window.__printedSvgPages > 0")
    with page.expect_popup() as preview:
        command('file:print')
    preview.value.locator('.print-page, .page, canvas, #print-root img, .rhwp-print-page').first.wait_for(timeout=20000)
    preview.value.close()
    with page.context.expect_page() as result:
        command('edit:compare-documents')
    compare = result.value
    compare.on('dialog', lambda d: d.accept())
    dialog = compare.locator('.doc-compare-dialog')
    dialog.wait_for()
    for i, path in enumerate((FIXTURE, ROOT / 'tests/fixtures/tool_memo_tracked.hwpx')):
        with compare.expect_file_chooser() as choice:
            dialog.locator('.compare-row button').nth(i).click()
        choice.value.set_files(path)
        dialog.locator('.compare-file').filter(has_text=path.name).wait_for()
    dialog.locator('.compare-actions button').first.click()
    compare.wait_for_function("() => !document.querySelector('.compare-actions button').disabled || document.querySelector('.dialog-wrap')")
    font_prompt = compare.locator('.dialog-wrap').filter(has_text='로컬 글꼴 감지')
    if font_prompt.is_visible():
        font_prompt.locator('.dialog-close').click()
    compare.wait_for_function("() => !document.querySelector('.compare-actions button').disabled")
    dialog.locator('.compare-result-item').first.wait_for(timeout=5000)
    compare.close()
    assert page.evaluate('window.__doc.id') == tabid
    print('PASS document setup, about, PDF dialog, print preview and isolated two-file comparison', flush=True)
    # Reopen a closed tab from the host-managed recent list.
    other = page.locator('[role=tab][aria-selected=false]').first.get_attribute('data-doc-id')
    page.locator(f'[data-testid=office-tab-close][data-doc-id="{other}"]').click()
    file = menu()
    file.locator('[data-recent]').hover()
    file.locator(f'[data-cmd="file:open-recent"][data-id="{other}"]').click()
    editor(page,other)
    page.goto(url + '#/doc/' + tabid)
    frame = editor(page, tabid)
    page.wait_for_function("mark => window.__doc.s.paragraphs.some(p => p.text.includes(mark))", arg=marker)
    command('file:new-doc')
    page.get_by_test_id('lib-newdoc').wait_for()
    page.get_by_test_id('folder-name').wait_for()
    print('PASS recent closed document and host new-document dialog', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('target')
    parser.add_argument('--channel', default='msedge')
    args = parser.parse_args()
    with site(args.target) as url, sync_playwright() as pw:
        browser = pw.chromium.launch(channel=args.channel)
        ctx = browser.new_context(viewport={'width':1500,'height':850}, accept_downloads=True)
        # Capture the rendered print document before the OS printer dialog.
        ctx.add_init_script("window.print = () => { window.top.__printedSvgPages = document.querySelectorAll('svg').length; }")
        exercise(ctx.new_page(),url)
        browser.close()
