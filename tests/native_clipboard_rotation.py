"""Native-copy rotation normalization, without COM or the system clipboard."""
import io
import math
import pathlib
import runpy
import unittest
import xml.etree.ElementTree as ET
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
prepare = runpy.run_path(str(ROOT / 'scripts/native-clipboard.py'))['prepare_native_fragment']
SOURCE = (ROOT / 'tests/fixtures/shapes_hangul.hwpx').read_bytes()
HP = '{http://www.hancom.co.kr/hwpml/2011/paragraph}'
HC = '{http://www.hancom.co.kr/hwpml/2011/core}'


def modified_source(angle=34, matrix_rotation=False, grouped=False, text=False):
    out = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(SOURCE)) as source, zipfile.ZipFile(out, 'w') as target:
        for item in source.infolist():
            data = source.read(item)
            if item.filename == 'Contents/section0.xml':
                root = ET.fromstring(data)
                rect = root.find('.//' + HP + 'rect')
                rect.find(HP + 'rotationInfo').set('angle', str(angle))
                if matrix_rotation:
                    rect.find('.//' + HC + 'rotMatrix').set('e2', '-0.5')
                if grouped:
                    rect.set('groupLevel', '1')
                if text:
                    ET.SubElement(rect, HP + 'drawText')
                for _, (prefix, uri) in ET.iterparse(io.BytesIO(data), events=['start-ns']):
                    ET.register_namespace(prefix, uri)
                data = ET.tostring(root, encoding='utf-8', xml_declaration=True)
            target.writestr(item, data)
    return out.getvalue()


class NativeRotation(unittest.TestCase):
    def test_rotated_rectangle_preserves_sides_and_other_package_entries(self):
        source = modified_source()
        result = prepare(source)
        with zipfile.ZipFile(io.BytesIO(source)) as before, zipfile.ZipFile(io.BytesIO(result)) as after:
            for name in before.namelist():
                if name != 'Contents/section0.xml':
                    self.assertEqual(before.read(name), after.read(name), name)
            a = ET.fromstring(before.read('Contents/section0.xml')).find('.//' + HP + 'rect')
            b = ET.fromstring(after.read('Contents/section0.xml')).find('.//' + HP + 'rect')
            self.assertEqual(a.attrib, b.attrib)
            for name in ['lineShape', 'pos', 'outMargin', 'shapeComment']:
                self.assertEqual(ET.tostring(a.find(HP + name)), ET.tostring(b.find(HP + name)))
            self.assertEqual(b.find(HP + 'rotationInfo').get('angle'), '34')
            p = [(int(b.find(HC + 'pt' + str(i)).get('x')), int(b.find(HC + 'pt' + str(i)).get('y'))) for i in range(4)]
            dx, dy = p[1][0] - p[0][0], p[1][1] - p[0][1]
            self.assertAlmostEqual(math.degrees(math.atan2(dy, dx)), 34, delta=0.02)
            self.assertAlmostEqual(math.hypot(dx, dy), 9500, delta=1)
            self.assertAlmostEqual(math.hypot(p[2][0]-p[1][0], p[2][1]-p[1][1]), 6000, delta=1)
        self.assertEqual(prepare(result), result, 'repeated copy must not apply another rotation')

    def test_no_rotation_returns_original_bytes(self):
        self.assertEqual(prepare(SOURCE), SOURCE)

    def test_existing_matrix_rotation_returns_original_bytes(self):
        source = modified_source(matrix_rotation=True)
        self.assertEqual(prepare(source), source)

    def test_groups_and_text_boxes_are_not_rewritten(self):
        for options in [dict(grouped=True), dict(text=True)]:
            source = modified_source(**options)
            self.assertEqual(prepare(source), source)


if __name__ == '__main__':
    unittest.main()
