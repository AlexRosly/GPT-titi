"""Edit a single numeric text object in a ruled, digital PDF table."""

import io
import math
import re

import pdfplumber
import pypdfium2 as pdfium
from PIL import ImageChops
from pypdf import PdfReader, PdfWriter
from pypdf.generic import ArrayObject, ByteStringObject, TextStringObject


class Rejected(ValueError):
    pass


def require(condition, code):
    if not condition:
        raise Rejected(code)


def open_source(data):
    require(isinstance(data, bytes) and 0 < len(data) <= 5 * 1024**2, 'PDF_CELL_SIZE')
    reader = PdfReader(io.BytesIO(data), strict=True)
    require(not reader.is_encrypted, 'PDF_CELL_ENCRYPTED')
    root = reader.trailer['/Root']
    require(not any(key in root for key in ('/AcroForm', '/Perms', '/OpenAction', '/AA', '/OCProperties',
                                            '/Names', '/StructTreeRoot', '/Collection', '/AF')),
            'PDF_CELL_UNSUPPORTED')
    require(1 <= len(reader.pages) <= 12, 'PDF_CELL_PAGES')
    for page in reader.pages:
        require(not page.rotation and not any(key in page for key in ('/Annots', '/AA', '/UserUnit')),
                'PDF_CELL_UNSUPPORTED')
        box = tuple(float(x) for x in page.mediabox)
        require(box[:2] == (0, 0) and tuple(float(x) for x in page.cropbox) == box
                and all(1 <= n <= 1000 for n in box[2:]), 'PDF_CELL_UNSUPPORTED')
    return reader


def locate(page, row_key, column, old):
    matches = []
    for table in page.find_tables():
        values = table.extract()
        if not values or column not in values[0]:
            continue
        require(values[0].count(column) == 1, 'PDF_CELL_AMBIGUOUS')
        col = values[0].index(column)
        require(col > 0, 'PDF_CELL_UNSUPPORTED')
        for i, row in enumerate(values[1:], 1):
            if row[0] == row_key:
                matches.append((table.rows[i].cells[col], row[col]))
    require(len(matches) == 1, 'PDF_CELL_AMBIGUOUS' if matches else 'PDF_CELL_NOT_FOUND')
    bbox, value = matches[0]
    require(bbox is not None and value == old, 'PDF_CELL_VALUE_MISMATCH')
    return bbox


def char_in(char, box):
    x, y = (char['x0'] + char['x1']) / 2, (char['top'] + char['bottom']) / 2
    return box[0] < x < box[2] and box[1] < y < box[3]


def target_text(page, box):
    return ''.join(c['text'] for c in page.chars if char_in(c, box))


def source_bytes(value):
    if isinstance(value, TextStringObject):
        return value.original_bytes
    if isinstance(value, ByteStringObject):
        return bytes(value)
    return None


def slot(args, operator):
    if operator == b'Tj' and len(args) == 1:
        return args
    if operator == b'TJ' and len(args) == 1 and isinstance(args[0], ArrayObject) and len(args[0]) == 1:
        return args[0]
    return None


def rewritten(reader, index, ids, value, only_page=False):
    writer = PdfWriter()
    if only_page:
        page = writer.add_page(reader.pages[index])
    else:
        writer.clone_document_from_reader(reader)
        page = writer.pages[index]
    stream = page.get_contents()
    ops = stream.operations
    for i in ids:
        args, operator = ops[i]
        slot(args, operator)[0] = ByteStringObject(value)
    stream.operations = ops
    page.replace_contents(stream)
    data = io.BytesIO()
    writer.write(data)
    return data.getvalue()


def target_operator(reader, index, box, old):
    stream = reader.pages[index].get_contents()
    require(stream is not None, 'PDF_CELL_UNSUPPORTED')
    ids = []
    old_bytes = old.encode('ascii')
    for i, (args, operator) in enumerate(stream.operations):
        operand = slot(args, operator)
        if operand is not None and source_bytes(operand[0]) == old_bytes:
            ids.append(i)
    require(1 <= len(ids) <= 4096, 'PDF_CELL_UNSUPPORTED')
    # Temporary probes associate a text-showing operation with the selected physical cell.
    # They are never published. Every probe is made from the original page.
    while len(ids) > 1:
        mid = len(ids) // 2
        probe = rewritten(reader, index, ids[:mid], b'', only_page=True)
        with pdfplumber.open(io.BytesIO(probe)) as doc:
            found = target_text(doc.pages[0], box)
            require(found in ('', old), 'PDF_CELL_UNSUPPORTED')
            ids = ids[:mid] if found == '' else ids[mid:]
    return ids[0]


def char_style(c):
    return c['fontname'], c['size'], c['non_stroking_color'], c['stroking_color'], tuple(c['matrix'][:4])


def verify(source, result, index, row_key, column, old, new):
    open_source(result)
    with pdfplumber.open(io.BytesIO(source)) as before, pdfplumber.open(io.BytesIO(result)) as after:
        require(len(before.pages) == len(after.pages), 'PDF_CELL_OTHER_CHANGES')
        box = locate(before.pages[index], row_key, column, old)
        require(locate(after.pages[index], row_key, column, new) == box, 'PDF_CELL_LAYOUT')
        for i, (a, b) in enumerate(zip(before.pages, after.pages)):
            require(a.bbox == b.bbox, 'PDF_CELL_LAYOUT')
            def untouched(page):
                return [(c['text'], c['x0'], c['x1'], c['top'], c['bottom'], char_style(c))
                        for c in page.chars if i != index or not char_in(c, box)]
            require(untouched(a) == untouched(b), 'PDF_CELL_OTHER_CHANGES')
            if i != index:
                continue
            a_chars = [c for c in a.chars if char_in(c, box)]
            b_chars = [c for c in b.chars if char_in(c, box)]
            require(target_text(a, box) == old and target_text(b, box) == new, 'PDF_CELL_VERIFY')
            sample = a_chars[0]
            require(all(char_style(c) == char_style(sample) and c['top'] == sample['top']
                        for c in a_chars + b_chars) and b_chars[0]['x0'] == sample['x0'], 'PDF_CELL_STYLE')
            require(all(box[0]+1 <= c['x0'] <= c['x1'] <= box[2]-1 and
                        box[1]+1 <= c['top'] <= c['bottom'] <= box[3]-1 for c in b_chars), 'PDF_CELL_FIT')

    with pdfium.PdfDocument(source) as before, pdfium.PdfDocument(result) as after:
        for i in range(len(before)):
            p, q = before[i], after[i]
            try:
                if i == index:
                    # PDFium is independent of the parser used to locate the table.
                    for page, expected in ((p, old), (q, new)):
                        height = page.get_height()
                        text = page.get_textpage()
                        try:
                            value = text.get_text_bounded(box[0], height-box[3], box[2], height-box[1])
                            require(value.strip() == expected, 'PDF_CELL_VERIFY')
                        finally:
                            text.close()
                left, right = p.render(scale=2), q.render(scale=2)
                try:
                    image_a = left.to_pil().convert('RGB')
                    image_b = right.to_pil().convert('RGB')
                    require(image_a.size == image_b.size, 'PDF_CELL_LAYOUT')
                    bounds = ImageChops.difference(image_a, image_b).getbbox()
                finally:
                    left.close()
                    right.close()
            finally:
                p.close()
                q.close()
            if i != index:
                require(bounds is None, 'PDF_CELL_OTHER_CHANGES')
            else:
                require(bounds and math.ceil(box[0]*2)+1 <= bounds[0] < bounds[2] <= math.floor(box[2]*2)-1
                        and math.ceil(box[1]*2)+1 <= bounds[1] < bounds[3] <= math.floor(box[3]*2)-1,
                        'PDF_CELL_VISUAL_CHECK')
        return {'pages': len(before), 'page': index+1, 'changedCells': 1, 'changedPages': 1}


def edit(source, page_number, row_key, column, old, new):
    require(all(isinstance(x, str) and 0 < len(x) <= 100 for x in (row_key, column)), 'PDF_CELL_SELECTOR')
    require(all(isinstance(x, str) and re.fullmatch(r'[0-9.,/-]{1,24}', x) for x in (old, new))
            and all(re.search(r'[0-9]', x) for x in (old, new)) and old != new, 'PDF_CELL_NUMERIC_VALUE')
    reader = open_source(source)
    require(type(page_number) is int and 1 <= page_number <= len(reader.pages), 'PDF_CELL_PAGE')
    index = page_number - 1
    with pdfplumber.open(io.BytesIO(source)) as doc:
        page = doc.pages[index]
        require(bool(page.chars), 'PDF_CELL_TEXT_LAYER_REQUIRED')
        box = locate(page, row_key, column, old)
        require(not any(img['x0'] < box[2] and img['x1'] > box[0] and
                        img['top'] < box[3] and img['bottom'] > box[1] for img in page.images),
                'PDF_CELL_TEXT_LAYER_REQUIRED')
        require(target_text(page, box) == old, 'PDF_CELL_UNSUPPORTED')
    operator = target_operator(reader, index, box, old)
    result = rewritten(reader, index, [operator], new.encode('ascii'))
    return result, verify(source, result, index, row_key, column, old, new)
