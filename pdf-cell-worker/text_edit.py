"""Scoped, atomic edits of horizontal text in searchable PDFs."""
from collections import defaultdict
from contextlib import closing
from dataclasses import dataclass
import hashlib
import io
import json
import math
import re
from statistics import median

import pypdfium2 as pdfium
from PIL import ImageChops
from pdfminer.converter import PDFPageAggregator
from pdfminer.layout import LTPage
from pdfminer.pdfinterp import PDFPageInterpreter, PDFResourceManager
from pdfminer.pdfpage import PDFPage
from pdfminer.pdffont import PDFUnicodeNotDefined
from pypdf import PdfWriter
from pypdf.generic import ArrayObject, ByteStringObject, FloatObject

from cell import Rejected, open_source, require, source_bytes, write_pdf

PREFIX = 'PDF_CELL_TEXT_'
SHOW = (b'Tj', b'TJ', b"'", b'"')
MAX_EDITS = 64


def check(value, code):
    require(value, PREFIX + code)


@dataclass(eq=False)
class Run:
    index: int
    font: object
    size: float
    scaling: float
    spacing: float
    wordspace: float
    mode: int
    content: list
    chars: list


class Collector(PDFPageAggregator):
    def render_string(self, state, seq, ncs, graphics):
        run = Run(len(self.runs) if isinstance(self.cur_item, LTPage) else -1,
                  state.font, state.fontsize, state.scaling / 100, state.charspace,
                  state.wordspace, state.render, list(seq), [])
        if run.index >= 0:
            self.runs.append(run)
        self.current_run = run
        super().render_string(state, seq, ncs, graphics)

    def render_char(self, matrix, font, fontsize, scaling, rise, cid, ncs, graphics):
        advance = super().render_char(matrix, font, fontsize, scaling, rise, cid, ncs, graphics)
        char = self.cur_item._objs[-1]
        char.run = self.current_run
        char.cid = cid
        char.rise = rise
        self.current_run.chars.append(char)
        self.glyphs.append(char)
        return advance


@dataclass(eq=False)
class Line:
    page: int
    chars: list

    @property
    def text(self):
        return ''.join(c.get_text() for c in self.chars)

    @property
    def x(self):
        return self.chars[0].x0

    @property
    def right(self):
        return self.chars[-1].x1

    @property
    def y(self):
        return self.chars[0].matrix[5]


def partition(page, glyphs):
    # A physical baseline may carry two unrelated columns.
    bands = []
    for c in sorted(glyphs, key=lambda g: -g.matrix[5]):
        if not bands or abs(c.matrix[5] - bands[-1][0].matrix[5]) > 0.6:
            bands.append([])
        bands[-1].append(c)
    lines = []
    for band in bands:
        group = []
        for c in sorted(band, key=lambda g: g.x0):
            if group and c.x0 - group[-1].x1 > max(3, .55 * c.size):
                lines.append(Line(page, group))
                group = []
            group.append(c)
        if group:
            lines.append(Line(page, group))
    return lines


def inspect(data, reader):
    manager = PDFResourceManager()
    device = Collector(manager)
    interpreter = PDFPageInterpreter(manager, device)
    lines, tables = [], []
    for index, page in enumerate(PDFPage.get_pages(io.BytesIO(data))):
        device.runs, device.glyphs = [], []
        interpreter.process_page(page)
        ops = reader.pages[index].get_contents()
        entries = [(i, a, op) for i, (a, op) in enumerate(ops.operations if ops is not None else []) if op in SHOW]
        table = {}
        if len(entries) == len(device.runs):
            for run, (i, args, op) in zip(device.runs, entries):
                if op not in (b'Tj', b'TJ'):
                    continue
                seq = args if op == b'Tj' else args[0]
                raw = [source_bytes(v) if isinstance(v, (str, bytes)) else float(v) for v in seq]
                if raw == run.content:
                    table[run] = i
        lines.extend(partition(index, device.glyphs))
        tables.append(table)
    return lines, tables


def pattern(value, aliases=False):
    # Equivalence applies to search only. The user's replacement is always literal.
    parts = []
    for token in value.split():
        t = token.casefold().rstrip('.')
        if aliases and t in ('район', 'р-н'):
            parts.append(r'(?:район|р[-‑–]н)\.?')
        elif aliases and t == 'смт':
            parts.append(r'смт\.?')
        else:
            parts.append(re.escape(token))
    return re.compile(r'(?<!\w)' + r'\s+'.join(parts) + r'(?!\w)', re.I)


def section_label(line):
    match = re.match(r'^\s*(\d+)[.)]\s+\S', line.text)
    return int(match[1]) if match else None


def scoped(lines, scope):
    page, section, party = scope['page'], scope['section'], scope['party']
    eligible = [l for l in lines if page is None or l.page + 1 == page]
    if section:
        heading = pattern(section)
        headers = [l for l in eligible if heading.search(l.text) and
                   (l.text.strip().isupper() or section_label(l) is not None or
                    l.text.strip().casefold().rstrip(':') == section.casefold())]
        check(headers, 'SCOPE')
        check(len(headers) == 1, 'AMBIGUOUS')
        h = headers[0]
        eligible = [l for l in eligible if l.page == h.page and l.y < h.y - 1]
        level = section_label(h)
        ends = [l.y for l in eligible if section_label(l) is not None and
                (level is None or section_label(l) > level)]
        if level is None and not party:
            ends.extend(l.y for l in eligible if l.text.strip() and abs(l.x-h.x) < 4
                        and l.chars[0].size >= h.chars[0].size and
                        (l.text.strip().isupper() or
                         re.fullmatch(r'[A-ZА-ЯІЇЄҐ][\w’\- ]{0,70}:?', l.text.strip()) and
                         l.chars[0].fontname == h.chars[0].fontname))
        if ends:
            eligible = [l for l in eligible if l.y > max(ends)]
    if party:
        anchor = pattern(party)
        headings = [l for l in eligible if anchor.search(l.text) and
                    (l.text.strip().isupper() or l.text.strip().casefold() == party.casefold())]
        check(headings, 'SCOPE')
        check(len(headings) == 1, 'AMBIGUOUS')
        h = headings[0]
        peers = [l for l in eligible if l is not h and l.page == h.page and
                 abs(l.y-h.y) < 1 and l.text.strip()]
        left = max(((l.right+h.x)/2 for l in peers if l.right < h.x), default=0)
        right = min(((h.right+l.x)/2 for l in peers if l.x > h.right), default=math.inf)
        eligible = [l for l in eligible if l.page == h.page and l.y < h.y-1 and left <= l.x < right and
                    (peers or l.right >= h.x-4 and l.x < h.right+4)]
        # In a stacked layout a subsequent party heading ends this block.
        end = [l.y for l in eligible if l.text.strip().isupper() and
               (abs(l.x-h.x) < 4 or abs((l.x+l.right-h.x-h.right)/2) < 4)]
        if end:
            eligible = [l for l in eligible if l.y > max(end)]
    return eligible


def validate(plan):
    check(isinstance(plan, dict) and set(plan) == {'scope', 'changes'}, 'SYNTAX')
    def literal(v):
        return isinstance(v, str) and 0 < len(v) <= 160 and v == v.strip() and all(c.isprintable() for c in v)

    def validate_scope(s):
        check(isinstance(s, dict) and set(s) == {'page', 'section', 'party'}, 'SYNTAX')
        check(s['page'] is None or type(s['page']) is int and s['page'] > 0, 'SYNTAX')
        check(all(v is None or literal(v) for v in [s['party'], s['section']]), 'SYNTAX')

    validate_scope(plan['scope'])
    changes = plan['changes']
    check(isinstance(changes, list) and 1 <= len(changes) <= MAX_EDITS, 'SYNTAX')
    for c in changes:
        check(isinstance(c, dict) and set(c) in ({'old','new'},{'old','new','scope'}) and
              literal(c['old']) and literal(c['new']) and c['old'] != c['new'], 'SYNTAX')
        if 'scope' in c:
            validate_scope(c['scope'])


def edits_by_line(lines, plan):
    changes = defaultdict(list)
    receipts, target_pages = [], []
    scopes = {}
    for ordinal, change in enumerate(plan['changes']):
        try:
            scope = change.get('scope', plan['scope'])
            key = (scope['page'], scope['section'], scope['party'])
            if key not in scopes:
                scopes[key] = scoped(lines, scope)
            rx = pattern(change['old'], aliases=True)
            hits = [(line, m) for line in scopes[key] for m in rx.finditer(line.text)]
            check(hits, 'NOT_FOUND')
            check(len(hits) == 1, 'AMBIGUOUS')
            line, match = hits[0]
            start, end = match.span()
            check(all(end <= a or start >= b for a,b,_ in changes[line]), 'OVERLAP')
            check(match[0] != change['new'], 'NO_CHANGE')
            changes[line].append((start, end, change['new']))
            target_pages.append(line.page + 1)
            receipts.append(hashlib.sha256(json.dumps([change['old'], change['new'], line.page+1],
                            ensure_ascii=False, separators=(',', ':')).encode()).hexdigest())
        except Rejected as error:
            error.failed_index = ordinal
            raise
    return changes, receipts, target_pages


def style(c):
    g = c.graphicstate
    return (c.fontname, c.size, tuple(c.matrix[:4]), c.rise, c.run.scaling, c.run.mode,
            g.ncolor, g.scolor)


def encode_font(font, used):
    result = {}
    if not font.is_multibyte():
        explicit = getattr(font, 'unicode_map', None)
        for cid in range(256):
            try:
                text = explicit.get_unichr(cid) if explicit else font.to_unichr(cid)
            except (KeyError, PDFUnicodeNotDefined):
                continue
            if len(text) == 1 and font.char_width(cid) > 0:
                result.setdefault(text, (cid, bytes([cid])))
    # Also support verified fixed-width identity CIDs, without guessing an encoding.
    identity = getattr(getattr(font, 'cmap', None), 'attrs', {}).get('CMapName')
    if font.is_multibyte() and 'Identity-H' in str(identity):
        mapping = getattr(getattr(font, 'unicode_map', None), 'cid2unichr', {})
        for cid, text in mapping.items():
            if 0 <= cid <= 65535 and len(text) == 1 and font.char_width(cid) > 0:
                result.setdefault(text, (cid, cid.to_bytes(2, 'big')))
    for c in used:
        if not font.is_multibyte():
            result[c.get_text()] = (c.cid, bytes([c.cid]))
    return result


def rewrite_line(line, changes, table, operations):
    chars = line.chars
    first = chars[0]
    run = first.run
    runs = {c.run for c in chars}
    check(all(len(c.get_text()) == 1 and c.run.font is run.font and style(c) == style(first)
              and abs(c.matrix[5]-first.matrix[5]) < .01 for c in chars), 'STYLE')
    check(first.matrix[0] > 0 and first.matrix[3] > 0 and first.matrix[1:3] == (0,0) and
          run.mode == 0 and not run.font.is_vertical() and run.size > 0 and run.scaling > 0, 'STYLE')
    check(all(r in table and set(r.chars).issubset(chars) for r in runs) and first is run.chars[0], 'STYLE')
    check(not run.content or isinstance(run.content[0], bytes), 'STYLE')
    scale = first.matrix[0] * run.size * run.scaling
    font = run.font
    encoding = encode_font(font, chars)
    def advance(cid):
        return font.char_width(cid)*scale + first.matrix[0]*run.scaling*(
            run.spacing + (run.wordspace if cid == 32 and not font.is_multibyte() else 0))
    # Single-letter operators sometimes use zero Tc even when the rest of the
    # word uses tracking. Measure the source word spacing in physical points.
    tracking_samples = [b.x0 - a.x0 - font.char_width(a.cid)*scale
                        for a,b in zip(chars,chars[1:]) if a.get_text().isalnum() and b.get_text().isalnum()
                        and abs(b.x0-a.x1) < first.size*.15]
    tracking = median(tracking_samples) if tracking_samples else first.matrix[0]*run.scaling*run.spacing
    segments = []
    def original(a,b):
        for i in range(a,b):
            c = chars[i]
            width = chars[i+1].x0 - c.x0 if i+1 < len(chars) else advance(c.cid)
            segments.append((c.get_text(),width))
    cursor = 0
    for start,end,new in sorted(changes):
        original(cursor,start)
        for s in new:
            check(s in encoding, 'GLYPH')
            cid = encoding[s][0]
            width = font.char_width(cid)*scale + tracking
            if cid == 32 and not font.is_multibyte():
                width += first.matrix[0]*run.scaling*run.wordspace
            segments.append((s, width))
        cursor = end
    original(cursor,len(chars))
    output = ArrayObject()
    for i,(s,width) in enumerate(segments):
        check(s in encoding, 'GLYPH')
        cid, code = encoding[s]
        output.append(ByteStringObject(code))
        kern = (advance(cid)-width)*1000/scale
        if i < len(segments)-1 and abs(kern) > .001:
            output.append(FloatObject(round(kern,5)))
    # Other drawing instructions and text states remain in place.
    for r in runs:
        operations[table[r]] = ([output if r is run else ArrayObject()], b'TJ')
    return ''.join(s for s,_ in segments)


def verify(source, result, expected, before, changes):
    after, _ = inspect(result, open_source(result))
    check(len(before) == len(after), 'FIT')
    areas = defaultdict(list)
    for a,b in zip(before, after):
        check(a.page == b.page and abs(a.x-b.x)<.015 and abs(a.y-b.y)<.015, 'FIT')
        if a not in expected:
            check(a.text == b.text and [(c.bbox, style(c)) for c in a.chars] ==
                  [(c.bbox, style(c)) for c in b.chars], 'VERIFY')
            continue
        check(b.text == expected[a] and all(style(c) == style(a.chars[0]) for c in b.chars), 'VERIFY')
        glyphs = a.chars+b.chars
        start = min(edit[0] for edit in changes[a])
        check(all(left.get_text() == right.get_text() and abs(left.x0-right.x0) < .01
                  for left,right in zip(a.chars[:start], b.chars[:start])), 'VERIFY')
        areas[a.page].append((a, b, a.chars[start].x0, min(c.y0 for c in glyphs), max(c.y1 for c in glyphs)))
    with pdfium.PdfDocument(source) as old, pdfium.PdfDocument(result) as new:
        check(len(old) == len(new), 'VERIFY')
        for index in range(len(old)):
            with closing(old[index]) as p, closing(new[index]) as q:
                check(p.get_size() == q.get_size(), 'VERIFY')
                width,height = p.get_size()
                with closing(p.render(scale=2)) as im, closing(q.render(scale=2)) as jm:
                    left,right = im.to_pil().convert('RGB'),jm.to_pil().convert('RGB')
                diff = ImageChops.difference(left,right)
                for a,b,start_x,y0,y1 in areas.get(index, []):
                    check(b.right <= width-1, 'FIT')
                    # Verify visible text with an independent PDF engine at the baseline.
                    with closing(q.get_textpage()) as txt:
                        value = txt.get_text_bounded(b.x-.5, b.y-.6, b.right+.5, b.y+2)
                    check(' '.join(value.split()) == ' '.join(b.text.split()), 'VERIFY')
                    box = (max(0,math.floor(start_x*2)-2),max(0,math.floor((height-y1)*2)-3),
                           min(left.width,math.ceil(max(a.right,b.right)*2)+2),
                           min(left.height,math.ceil((height-y0)*2)+3))
                    if b.right > a.right+2:
                        ext = left.crop((math.ceil(a.right*2)+2,box[1],box[2],box[3]))
                        check(all(lo==hi for lo,hi in ext.getextrema()), 'FIT')
                    check(diff.crop(box).getbbox(), 'VERIFY')
                    diff.paste((0,0,0),box)
                check(not diff.getbbox(), 'VERIFY')
        return len(old),len(areas)


def edit_text(source, plan):
    validate(plan)
    reader = open_source(source)
    if plan['scope']['page']:
        check(plan['scope']['page'] <= len(reader.pages), 'SCOPE')
    lines, tables = inspect(source, reader)
    check(any(l.text.strip() for l in lines), 'LAYER')
    changes, receipts, target_pages = edits_by_line(lines, plan)
    writer = PdfWriter(reader, full=True)
    expected = {}
    for index in sorted({line.page for line in changes}):
        page = writer.pages[index]
        stream = page.get_contents()
        ops = stream.operations
        for line, edits in changes.items():
            if line.page == index:
                expected[line] = rewrite_line(line, edits, tables[index], ops)
        stream.operations = ops
        page.replace_contents(stream)
    result = write_pdf(writer)
    pages, changed_pages = verify(source, result, expected, lines, changes)
    return result, {'pages':pages, 'changedPages':changed_pages, 'changedTexts':len(receipts),
                    'targetPages':target_pages, 'verifiedTexts':receipts}
