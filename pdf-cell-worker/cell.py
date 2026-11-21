"""Edit selected numeric text objects in a ruled, digital PDF table."""

from collections import defaultdict
from contextlib import closing
from dataclasses import dataclass
import hashlib
import io
import json
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


def tables_on(page):
    return [(table, table.extract()) for table in page.find_tables()]


def locate(page, row_key, column, old, *, tables=None):
    if tables is None:
        tables = tables_on(page)
    matches = []
    for table, values in tables:
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
    replace_operands(page, {i: value for i in ids})
    return write_pdf(writer)


def replace_operands(page, changes):
    stream = page.get_contents()
    ops = stream.operations
    for index, value in changes.items():
        args, operator = ops[index]
        slot(args, operator)[0] = ByteStringObject(value)
    stream.operations = ops
    page.replace_contents(stream)


def write_pdf(writer):
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


@dataclass(frozen=True)
class Change:
    page_number: int
    row_key: str
    column: str
    old: str
    new: str

    def validate(self, page_count):
        require(type(self.page_number) is int and 1 <= self.page_number <= page_count, 'PDF_CELL_PAGE')
        require(all(isinstance(x, str) and 0 < len(x) <= 100 for x in (self.row_key, self.column)), 'PDF_CELL_SELECTOR')
        require(self.old != self.new and all(
            isinstance(x, str) and re.fullmatch(r'[0-9.,/-]{1,24}', x) and re.search(r'[0-9]', x)
            for x in (self.old, self.new)), 'PDF_CELL_NUMERIC_VALUE')

    def receipt(self):
        values = [self.page_number, self.row_key, self.column, self.old, self.new]
        encoded = json.dumps(values, ensure_ascii=False, separators=(',', ':')).encode()
        return hashlib.sha256(encoded).hexdigest()


def overlaps(a, b):
    return a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]


def resolve_changes(reader, doc, changes):
    targets = defaultdict(list)
    tables = {}
    for ordinal, change in enumerate(changes):
        try:
            change.validate(len(reader.pages))
            index = change.page_number - 1
            page = doc.pages[index]
            require(bool(page.chars), 'PDF_CELL_TEXT_LAYER_REQUIRED')
            if index not in tables:
                tables[index] = tables_on(page)
            box = locate(page, change.row_key, change.column, change.old, tables=tables[index])
            require(not any(overlaps(box, prev) for _, prev in targets[index]), 'PDF_CELL_DUPLICATE_TARGET')
            require(not any(overlaps(box, (img['x0'], img['top'], img['x1'], img['bottom']))
                            for img in page.images), 'PDF_CELL_TEXT_LAYER_REQUIRED')
            require(target_text(page, box) == change.old, 'PDF_CELL_UNSUPPORTED')
            targets[index].append((change, box))
        except Rejected as error:
            error.failed_index = ordinal
            raise
    return targets


def verify_text(a, b, targets):
    require(a.bbox == b.bbox, 'PDF_CELL_LAYOUT')
    def untouched(page):
        return [(c['text'], c['x0'], c['x1'], c['top'], c['bottom'], char_style(c))
                for c in page.chars if not any(char_in(c, box) for _, box in targets)]
    require(untouched(a) == untouched(b), 'PDF_CELL_OTHER_CHANGES')
    tables = tables_on(b) if targets else []
    ink_regions = []
    for change, box in targets:
        require(locate(b, change.row_key, change.column, change.new, tables=tables) == box, 'PDF_CELL_LAYOUT')
        old_chars = [c for c in a.chars if char_in(c, box)]
        new_chars = [c for c in b.chars if char_in(c, box)]
        require(target_text(a, box) == change.old and target_text(b, box) == change.new, 'PDF_CELL_VERIFY')
        sample = old_chars[0]
        require(all(char_style(c) == char_style(sample) and c['top'] == sample['top']
                    for c in old_chars + new_chars) and new_chars[0]['x0'] == sample['x0'], 'PDF_CELL_STYLE')
        require(all(box[0]+1 <= c['x0'] <= c['x1'] <= box[2]-1 and
                    box[1]+1 <= c['top'] <= c['bottom'] <= box[3]-1 for c in new_chars), 'PDF_CELL_FIT')
        # Allow a one-point rasterization margin around the old and new glyphs,
        # clipped to the cell interior so a border change remains detectable.
        chars = old_chars + new_chars
        ink_regions.append((max(math.ceil(box[0]*2)+1, math.floor(min(c['x0'] for c in chars)*2)-2),
                            max(math.ceil(box[1]*2)+1, math.floor(min(c['top'] for c in chars)*2)-2),
                            min(math.floor(box[2]*2)-1, math.ceil(max(c['x1'] for c in chars)*2)+2),
                            min(math.floor(box[3]*2)-1, math.ceil(max(c['bottom'] for c in chars)*2)+2)))
    return ink_regions


def render_and_read(page, targets, original):
    if targets:
        with closing(page.get_textpage()) as text:
            height = page.get_height()
            for change, box in targets:
                value = text.get_text_bounded(box[0], height-box[3], box[2], height-box[1])
                require(value.strip() == (change.old if original else change.new), 'PDF_CELL_VERIFY')
    image = page.render(scale=2)
    try:
        return image.to_pil().convert('RGB')
    finally:
        image.close()


def verify_result(source, result, targets):
    open_source(result)
    ink_regions = {}
    with pdfplumber.open(io.BytesIO(source)) as before, pdfplumber.open(io.BytesIO(result)) as after:
        require(len(before.pages) == len(after.pages), 'PDF_CELL_OTHER_CHANGES')
        for index, (a, b) in enumerate(zip(before.pages, after.pages)):
            ink_regions[index] = verify_text(a, b, targets.get(index, []))

    with pdfium.PdfDocument(source) as before, pdfium.PdfDocument(result) as after:
        for index in range(len(before)):
            selected = targets.get(index, [])
            with closing(before[index]) as p, closing(after[index]) as q:
                left = render_and_read(p, selected, True)
                right = render_and_read(q, selected, False)
            require(left.size == right.size, 'PDF_CELL_LAYOUT')
            diff = ImageChops.difference(left, right)
            for region in ink_regions[index]:
                require(diff.crop(region).getbbox() is not None, 'PDF_CELL_VISUAL_CHECK')
                diff.paste((0, 0, 0), region)
            require(not diff.getbbox(), 'PDF_CELL_VISUAL_CHECK' if selected else 'PDF_CELL_OTHER_CHANGES')
        return len(before)


def verify(source, result, index, row_key, column, old, new):
    change = Change(index + 1, row_key, column, old, new)
    with pdfplumber.open(io.BytesIO(source)) as doc:
        targets = resolve_changes(open_source(source), doc, [change])
    pages = verify_result(source, result, targets)
    return {'page': index + 1, 'pages': pages, 'changedPages': 1, 'changedCells': 1}


def edit_changes(source, changes, *, batch):
    reader = open_source(source)
    with pdfplumber.open(io.BytesIO(source)) as doc:
        targets = resolve_changes(reader, doc, changes)
    writer = PdfWriter()
    writer.clone_document_from_reader(reader)
    for index, selected in targets.items():
        replacements = {}
        for change, box in selected:
            operator = target_operator(reader, index, box, change.old)
            require(operator not in replacements, 'PDF_CELL_DUPLICATE_TARGET')
            replacements[operator] = change.new.encode('ascii')
        replace_operands(writer.pages[index], replacements)
    result = write_pdf(writer)
    pages = verify_result(source, result, targets)
    report = {'pages': pages, 'changedPages': len(targets), 'changedCells': len(changes)}
    if batch:
        report['verifiedCells'] = [change.receipt() for change in changes]
    else:
        report['page'] = changes[0].page_number
    return result, report


def edit_batch(source, cells):
    require(isinstance(cells, list) and 2 <= len(cells) <= 64, 'PDF_CELL_BATCH_SIZE')
    require(all(isinstance(c, dict) and set(c) == set(Change.__dataclass_fields__) for c in cells), 'PDF_CELL_SELECTOR')
    return edit_changes(source, [Change(**c) for c in cells], batch=True)


def edit(source, page_number, row_key, column, old, new):
    return edit_changes(source, [Change(page_number, row_key, column, old, new)], batch=False)
