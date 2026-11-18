import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image, ImageDraw

import verify


class LayoutTests(unittest.TestCase):
    def setUp(self):
        self.original = Image.new("RGB", (240, 80), "white")
        self.result = self.original.copy()
        ImageDraw.Draw(self.original).line((70, 24, 169, 24), fill="black")
        ImageDraw.Draw(self.result).line((20, 24, 219, 24), fill="black")
        self.boxes = [((120, 40), [('Name', ('1', '2', '3', '4'))])]

    def compare(self, result=None, boxes=None):
        result = result if result is not None else self.result
        with tempfile.TemporaryDirectory() as tmp, \
                patch.object(verify, "word_boxes", side_effect=[self.boxes, boxes or self.boxes]), \
                patch.object(verify, "raster", side_effect=[self.original, result]):
            return verify.visual(None, None, [[500, 1000, 500]], Path(tmp))

    def test_exact_line(self):
        self.assertEqual(self.compare()["signatures"], 1)

    def test_missing_line_even_if_both_images_are_identical(self):
        with self.assertRaisesRegex(verify.Failure, 'LAYOUT'):
            self.compare(self.original.copy())

    def test_extra_mark(self):
        self.result.putpixel((10, 74), (0, 0, 0))
        with self.assertRaisesRegex(verify.Failure, 'LAYOUT'):
            self.compare()

    def test_text_moved(self):
        with self.assertRaisesRegex(verify.Failure, 'LAYOUT'):
            self.compare(boxes=[((120, 40), [('Name', ('1', '3', '3', '5'))])])

    def test_partial_line(self):
        ImageDraw.Draw(self.result).line((215, 24, 219, 24), fill="white")
        self.result.putpixel((219, 24), (0, 0, 0))
        with self.assertRaisesRegex(verify.Failure, 'LAYOUT'):
            self.compare()

    def test_extra_page(self):
        with self.assertRaisesRegex(verify.Failure, 'LAYOUT'):
            self.compare(boxes=self.boxes * 2)


if __name__ == "__main__":
    unittest.main()
