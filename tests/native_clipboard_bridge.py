"""CF_HTML transport boundaries. Does not read or change the real clipboard."""
import base64
import pathlib
import re
import runpy
import unittest

api = runpy.run_path(str(pathlib.Path(__file__).resolve().parents[1] / 'scripts/hancom-clipboard-bridge.py'))
encode = api['portable_native_html']
native = api['SIGNATURE'] + bytes(range(256))


def source(fragment, url=True):
    body = ('<html><body><!--StartFragment-->' + fragment + '<!--EndFragment--></body></html>').encode('utf8')
    header = 'Version:1.0\r\nStartHTML:{:010d}\r\nEndHTML:{:010d}\r\nStartFragment:{:010d}\r\nEndFragment:{:010d}\r\n'
    if url:
        header += 'SourceURL:file:///clipboard-test.hwpx\r\n'
    sh = len(header.format(0, 0, 0, 0).encode('ascii'))
    sf = sh + body.index(b'<!--StartFragment-->') + len(b'<!--StartFragment-->')
    ef = sh + body.index(b'<!--EndFragment-->')
    return header.format(sh, sh + len(body), sf, ef).encode('ascii') + body + b'\0'


class NativeTransport(unittest.TestCase):
    def test_full_document_rtf_preserved_with_individual_and_total_bounds(self):
        api['validate_format_size'](147114408, 16900000)
        for size, total in [(0, 0), (api['MAX_FORMAT_BYTES']+1, 0), (147114408, 200000000)]:
            with self.assertRaises(ValueError):
                api['validate_format_size'](size, total)

    def test_browser_fragment_keeps_unicode_html_and_exact_native_binary(self):
        fragment = '<p>한글 2018 \U0001f600</p><table><tr><td>값</td></tr></table>'
        raw = source(fragment)
        for version in [2018, 2022]:
            result = encode(raw, native, version)
            offsets = {key.decode(): int(value) for key, value in re.findall(rb'(?m)^(StartHTML|EndHTML|StartFragment|EndFragment|StartSelection|EndSelection):(\d+)\r?$', result[:1024])}
            self.assertEqual(result[offsets['StartHTML']:offsets['EndHTML']].split(b'<!--StartFragment-->')[1].split(b'<!--EndFragment-->')[0], result[offsets['StartFragment']:offsets['EndFragment']])
            exposed = result[offsets['StartFragment']:offsets['EndFragment']]
            self.assertTrue(exposed.endswith(fragment.encode('utf8')))
            payload = re.search(rb'<!--rhwp-fragment-v1:([A-Za-z0-9+/=]+)-->', exposed)[1]
            self.assertEqual(base64.b64decode(payload), native)
            self.assertIn(b'SourceURL:file:///clipboard-test.hwpx\r\n', result[:offsets['StartHTML']])
            self.assertEqual(offsets['StartSelection'], offsets['StartFragment'])
            self.assertEqual(offsets['EndSelection'], offsets['EndFragment'])

    def test_drawing_only_copy_without_html_can_carry_native_object(self):
        result = encode(api['empty_cf_html'](), native, 2018)
        self.assertIn(base64.b64encode(native), result)
        self.assertIn(b'<!--rhwp-native-source:hancom-2018-->', result)

    def test_same_process_marker_is_not_republished(self):
        # 한글은 Hwp_Native_Info 의 프로세스가 자기면 OLE 개체를 찾는다 — 도우미가 OLE 개체를 버리고
        # 이 표식만 남기면 같은 한글 창에서 붙이기가 실패했다(2018·2022 실측).
        self.assertIn('Hwp_Native_Info', api['SAME_PROCESS_FORMATS'])

        class Clipboard:
            touched = []
            def EnumClipboardFormats(self, fmt): return 0xC100 if fmt == 0 else 0
            def GetClipboardFormatName(self, fmt): return 'Hwp_Native_Info'
            def GetClipboardDataHandle(self, fmt):
                self.touched.append(fmt)
                raise AssertionError('same-process marker must not be read')
        clipboard, items = Clipboard(), []
        api['freeze_formats'](clipboard, items)
        self.assertEqual(items, [])
        self.assertEqual(clipboard.touched, [])

    def test_existing_portable_web_copy_is_unchanged(self):
        raw = source('<!--rhwp-fragment-v1:UEs=--><p>web</p>')
        self.assertEqual(encode(raw, native, 2022), raw)

    def test_invalid_offsets_or_non_native_memory_are_rejected(self):
        for raw, block in [(b'<p>no CF_HTML boundaries</p>', native), (source('x').replace(b'EndFragment:', b'BadFragment:'), native), (source('x'), b'PNG')]:
            with self.assertRaises(ValueError):
                encode(raw, block, 2018)

    def test_native_payload_size_limit_is_checked_before_encoding(self):
        with self.assertRaises(ValueError):
            encode(source('x'), api['SIGNATURE'] + b'x' * api['MAX_NATIVE'], 2018)


if __name__ == '__main__':
    unittest.main()
