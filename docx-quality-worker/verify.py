"""Verify three-cell signature-line extensions before an edited DOCX can be published."""
import base64
import io
import json
import os
import signal
import subprocess
import sys
import tempfile
from pathlib import Path
from zipfile import ZipFile

from lxml import etree as ET
from PIL import Image, ImageChops

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
MAIN = "word/document.xml"
MAX_PAGES = 40
MAX_PIXELS = 5_000_000


class Failure(Exception):
    pass


def require(condition, code):
    if not condition:
        raise Failure("DOCX_QUALITY_" + code)


def xml(data):
    parser = ET.XMLParser(resolve_entities=False, load_dtd=False, no_network=True)
    return ET.fromstring(data, parser)


def cells(row):
    return row.findall(W + "tc")


def prop(cell, name):
    return cell.find(W + "tcPr/" + W + name)


def bottom(cell):
    return prop(cell, "tcBorders/" + W + "bottom")


def widths(row_cells):
    values = []
    for cell in row_cells:
        width = prop(cell, "tcW")
        require(width is not None and width.get(W + "type") == "dxa", "UNSUPPORTED")
        number = width.get(W + "w", "")
        require(number.isdigit() and 0 < int(number) <= 31680, "UNSUPPORTED")
        values.append(int(number))
    return values


def stroke(border):
    if border is None:
        return None
    attrs = dict(border.attrib)
    if attrs.get(W + "space") == "0":
        del attrs[W + "space"]
    if attrs.get(W + "color", "").lower() in ("auto", "000000"):
        attrs[W + "color"] = "000000"
    return attrs


def targets(original):
    rows = []
    for index, row in enumerate(original.iter(W + "tr")):
        triplet = cells(row)
        if len(triplet) != 3:
            continue
        texts = ["".join(c.itertext(W + "t")).strip() for c in triplet]
        center = bottom(triplet[1])
        if center is None or not texts[0] or texts[1] or not texts[2]:
            continue
        require(center.get(W + "val") == "single" and
                stroke(center).get(W + "color") == "000000" and
                center.get(W + "sz") in ("4", "6", "8") and
                all(bottom(triplet[i]) is None for i in (0, 2)), "UNSUPPORTED")
        rows.append((index, widths(triplet)))
    require(rows, "COVERAGE")
    return rows


def structure(source, result, expected):
    with ZipFile(io.BytesIO(source)) as a, ZipFile(io.BytesIO(result)) as b:
        def members(archive):
            return [i for i in archive.infolist() if not i.is_dir()]
        names = {i.filename for i in members(a)}
        require(names == {i.filename for i in members(b)} and MAIN in names, "OTHER_CHANGES")
        for archive in (a, b):
            sizes = members(archive)
            require(len(sizes) == len(names) and len(sizes) <= 2048 and
                    sum(i.file_size for i in sizes) <= 40 * 1024**2, "LIMIT")
        for name in names - {MAIN}:
            require(a.read(name) == b.read(name), "OTHER_CHANGES")
        orig, edited = xml(a.read(MAIN)), xml(b.read(MAIN))
    rows = targets(orig)
    require(expected is None or len(rows) == expected, "COVERAGE")
    left_rows, right_rows = list(orig.iter(W + "tr")), list(edited.iter(W + "tr"))
    require(len(left_rows) == len(right_rows), "OTHER_CHANGES")
    for index, _ in rows:
        before, after = cells(left_rows[index]), cells(right_rows[index])
        require(len(after) == 3, "OTHER_CHANGES")
        line = stroke(bottom(before[1]))
        center = bottom(after[1])
        require(stroke(center) == line, "COVERAGE")
        # Applying a border to an entire row may spell default black/zero spacing differently.
        for element in (center, bottom(before[1])):
            for key in ("color", "space"):
                element.attrib.pop(W + key, None)
        for i in (0, 2):
            border = bottom(after[i])
            require(border is not None and stroke(border) == line, "COVERAGE")
            container = border.getparent()
            container.remove(border)
            if prop(before[i], "tcBorders") is None and len(container) == 0:
                container.getparent().remove(container)
    require(ET.tostring(orig, method="c14n") == ET.tostring(edited, method="c14n"), "OTHER_CHANGES")
    return [width for _, width in rows]


def command(args, env=None):
    subprocess.run(args, env=env, check=True, stdin=subprocess.DEVNULL,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def render_pair(source, result, root):
    # One Writer process and one fresh profile for both documents.
    files = [root / name for name in ("original.docx", "edited.docx")]
    for path, data in zip(files, (source, result)):
        path.write_bytes(data)
    env = dict(os.environ, HOME=str(root), XDG_CACHE_HOME=str(root / "cache"),
               SAL_USE_VCLPLUGIN="svp")
    command(["soffice", "-env:UserInstallation=" + (root / "profile").as_uri(),
             "--headless", "--nologo", "--norestore", "--convert-to", "pdf",
             "--outdir", str(root), *map(str, files)], env)
    pdfs = [p.with_suffix(".pdf") for p in files]
    require(all(p.is_file() and p.stat().st_size > 0 for p in pdfs), "RENDER")
    return pdfs


def word_boxes(pdf, output):
    command(["pdftotext", "-bbox", str(pdf), str(output)])
    require(output.stat().st_size <= 8 * 1024**2, "LIMIT")
    pages = list(xml(output.read_bytes()).iter("{*}page"))
    require(0 < len(pages) <= MAX_PAGES, "LIMIT")
    result = []
    for page in pages:
        size = tuple(float(page.get(k)) for k in ("width", "height"))
        require(min(size) > 0 and (int(size[0]*2)+1)*(int(size[1]*2)+1) <= MAX_PIXELS, "LIMIT")
        words = [(w.text, tuple(w.get(k) for k in ("xMin", "yMin", "xMax", "yMax")))
                 for w in page.iter("{*}word")]
        result.append((size, words))
    return result


def raster(pdf, root, page, label):
    path = root / label
    command(["pdftoppm", "-r", "144", "-f", str(page), "-l", str(page),
             "-singlefile", str(pdf), str(path)])
    with Image.open(path.with_suffix(".ppm")) as img:
        require(img.width * img.height <= MAX_PIXELS and img.mode == "RGB", "LIMIT")
        return img.copy()


def check_band(original, edited, box, widths):
    left, top, right, end = box
    length = right - left
    require(0 < end - top <= 4 and abs(length - sum(widths)/10) <= 5, "LAYOUT")
    start = left + round(length * widths[0] / sum(widths))
    stop = left + round(length * (widths[0] + widths[1]) / sum(widths))
    require(min(start-left, stop-start, right-stop) > 6, "LAYOUT")
    strong = False
    for y in range(top, end):
        # Every differing pixel on this scanline must be part of a darkened extension.
        for x in range(left, right):
            old, new = original.getpixel((x, y)), edited.getpixel((x, y))
            if old != new:
                require(not start+2 <= x < stop-2 and len(set(new)) == 1 and
                        all(v >= new[0] for v in old), "LAYOUT")
        def extrema(image, x1, x2):
            channels = image.crop((x1, y, x2, y+1)).getextrema()
            return min(c[0] for c in channels), max(c[1] for c in channels)
        if (extrema(edited, left+2, right-2)[1] <= 96 and
            extrema(original, start+2, stop-2)[1] <= 96 and
            min(extrema(original, left+2, start-2)[0],
                extrema(original, stop+2, right-2)[0]) >= 224):
            strong = True
    require(strong, "LAYOUT")


def visual(a, b, widths_list, root):
    before, after = word_boxes(a, root/"a.xml"), word_boxes(b, root/"b.xml")
    require(before == after, "LAYOUT")
    matched = changed_pages = 0
    for page in range(1, len(before)+1):
        old, new = raster(a, root, page, "a"), raster(b, root, page, "b")
        require(old.size == new.size, "LAYOUT")
        diff = ImageChops.difference(old, new)
        lines = list(diff.getprojection()[1]) + [0]
        start = None
        count_before = matched
        for y, changed in enumerate(lines):
            if changed and start is None:
                start = y
            if not changed and start is not None:
                x1, _, x2, _ = diff.crop((0,start,old.width,y)).getbbox()
                require(matched < len(widths_list), "LAYOUT")
                check_band(old, new, (x1,start,x2,y), widths_list[matched])
                matched += 1
                start = None
        changed_pages += matched > count_before
    require(matched == len(widths_list), "LAYOUT")
    return {"profile":"signature-lines-v1", "pages":len(before),
            "changedPages":changed_pages, "signatures":matched}


def main():
    try:
        raw = sys.stdin.buffer.read(15*1024**2+1)
        require(len(raw) <= 15*1024**2, "LIMIT")
        request = json.loads(raw)
        signal.signal(signal.SIGALRM, lambda *_: require(False, "TIMEOUT"))
        signal.setitimer(signal.ITIMER_REAL, min(60, max(.001, request["timeoutMs"]/1000)))
        source, result = (base64.b64decode(request[k], validate=True) for k in ("source","result"))
        widths_list = structure(source, result, request["expected"])
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            data = visual(*render_pair(source, result, root), widths_list, root)
        out = {"ok":True, "text":json.dumps(data)}
    except Failure as error:
        out = {"ok":False, "text":str(error)}
    except Exception:
        out = {"ok":False, "text":"DOCX_QUALITY_RENDER"}
    print(json.dumps(dict(out, exports=[])))


if __name__ == "__main__":
    main()
