"""Metric equivalence checks against the unchanged upstream PIL implementation."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('png_regression', ROOT/'scripts/compare-hwp2024-png.py')
regression = importlib.util.module_from_spec(spec)
spec.loader.exec_module(regression)


class MetricContract(unittest.TestCase):
    def check_pair(self, a, b):
        actual = regression.silhouette_details(a, b, (0, 1, 2, 6))
        for radius, detail in actual.items():
            expected = regression.sweep.subpixel_tolerant_content_match_details(
                Image.fromarray(a), Image.fromarray(b), radius_px=radius)
            self.assertEqual(detail, expected, f'radius={radius}')

    def test_white_and_degenerate_image_edges(self):
        for shape in ((1, 1, 3), (1, 9, 3), (9, 1, 3), (13, 17, 3)):
            a = np.full(shape, 255, np.uint8)
            self.check_pair(a, a)
            b = a.copy()
            b[0, 0] = 0
            b[-1, -1] = [5, 100, 250]
            self.check_pair(a, b)

    def test_threshold_boundaries_and_color_reconciliation(self):
        values = np.array([0, 200, 230, 231, 232, 233, 243, 244, 255], np.uint8)
        a = np.tile(values.reshape(1, -1, 1), (9, 1, 3))
        b = np.roll(a, 1, axis=1)
        b[2, :, 1] = 244
        b[4, :, 2] = 232
        self.check_pair(a, b)
        a = np.full((8, 8, 3), 255, np.uint8)
        b = a.copy()
        a[2, 2] = 231
        b[2, 2] = 233
        self.check_pair(a, b)
        self.assertEqual(regression.silhouette_details(a, b)[2]['silhouette_boundary_reconciled_pixels'], 1)

    def test_seeded_sparse_random_images(self):
        rng = np.random.default_rng(20261105)
        for _ in range(8):
            a = rng.integers(0, 256, (31, 47, 3), dtype=np.uint8)
            a[rng.random((31, 47)) < .9] = 255
            b = np.roll(a, rng.integers(-8, 9), axis=0)
            b[rng.random((31, 47)) < .1] = 255
            self.check_pair(a, b)

    def test_actual_movement_is_not_hidden(self):
        a = np.full((100, 100, 3), 255, np.uint8)
        b = a.copy()
        a[20:40, 20:60] = 0
        b[40:60, 20:60] = 0
        self.assertLess(regression.silhouette_details(a, b)[6]['tolerant_content_match_percent'], 90)
        self.check_pair(a, b)

    def test_page_selection_is_explicit_and_one_based(self):
        self.assertEqual(regression.selections(['asan:1-2', 'police:28,69,119-120']),
                         {'asan': {1, 2}, 'police': {28, 69, 119, 120}})
        for invalid in ('asan:0', 'asan:2-1', 'other:1', 'police:', 'police:1.5'):
            with self.assertRaises(ValueError):
                regression.selections([invalid])

    def test_focused_success_cannot_claim_full_regression_pass(self):
        with tempfile.TemporaryDirectory() as temp:
            out = Path(temp)
            source = out/'input.hwpx'
            with zipfile.ZipFile(source, 'w') as z:
                z.writestr('Contents/section0.xml', '<hs:sec xmlns:hs="urn:section" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"><hp:p/></hs:sec>')
            model = out/'asan/engine/model.json'
            model.parent.mkdir(parents=True)
            model.write_text(json.dumps({'paragraphs': [[{'text': ''}]]}), encoding='utf-8')
            png = out/'page.png'
            Image.new('RGB', (20, 20), 'white').save(png)
            row = regression.compare_page(('asan', 1, png, png, out))
            pre = {'documents': [{'name': 'asan', 'input': str(source), 'referencePages': 2,
                                 'sections': [{'paragraphs': 1, 'file': 'Contents/section0.xml'}]}],
                   'fullCoverage': False, 'reference': str(out), 'referenceComVersion': '13, 0, 0, 564',
                   'engineSha256': 'test-engine', 'baseUrl': None, 'referenceGenerationSeconds': 0}
            engine = {'documents': [{'name': 'asan', 'pages': 2, 'beforeConvert': [1], 'afterConvert': [1]}]}
            result = regression.report(out, pre, engine, [row], 0, {})
            self.assertEqual(result['status'], 'PASS_FOCUSED')
            self.assertEqual(result['scope'], 'selected-pages')
            self.assertFalse(result['fullCoverage'])

    def test_physical_page_resize_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            out = Path(temp)
            a, b = out/'a.png', out/'b.png'
            Image.new('RGB', (20, 20), 'white').save(a)
            Image.new('RGB', (22, 20), 'white').save(b)
            with self.assertRaisesRegex(ValueError, 'refusing rescale'):
                regression.compare_page(('asan', 1, a, b, out))


if __name__ == '__main__':
    unittest.main()
