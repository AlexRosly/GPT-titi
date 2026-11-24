"""Rebuild the small printed-glyph verifier. Runtime uses the checked-in masks only."""
import json
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

fonts = Path('/usr/share/fonts/truetype')
sources = ['dejavu/DejaVuSans', 'dejavu/DejaVuSerif', 'liberation/LiberationSans',
           'liberation/LiberationSerif', 'open-sans/OpenSans']
masks = {}
for char in 'QOГҐгґ':
    samples = []
    for family in sources:
        for suffix in ['', '-Regular', '-Bold']:
            font_path = fonts / (family + suffix + '.ttf')
            if not font_path.exists():
                continue
            font = ImageFont.truetype(str(font_path), 80)
            im = Image.new('L', (160, 160))
            ImageDraw.Draw(im).text((10, 10), char, fill=255, font=font)
            im = im.crop(im.getbbox()).resize((16, 20), Image.Resampling.BOX)
            rows = [sum(1 << x for x in range(16) if im.getpixel((x,y)) >= 128) for y in range(20)]
            if rows not in samples:
                samples.append(rows)
    masks[char] = samples
out = Path(__file__).resolve().parents[1] / 'src/services/files/ocrGlyphTemplates.json'
out.write_text(json.dumps(masks, ensure_ascii=False, separators=(',', ':')) + '\n')
