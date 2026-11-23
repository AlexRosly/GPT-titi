"""Acceptance cases on a synthetic two-column Cyrillic fixture."""
import base64
import sys
import unittest
from pathlib import Path

from cell import Rejected
from text_edit import edit_text
from worker import process

SOURCE = Path(sys.argv.pop(1)).read_bytes()
SCOPE = {'page': None, 'section':'Реквізити', 'party':'QA-200'}
CHANGES = [{'old':'Колишній район','new':'Самарівський район'}, {'old':'смт.','new':'селище'}]
ANY = {'page':None, 'section':None, 'party':None}


class TextTests(unittest.TestCase):
    def test_fragmented_address_and_duplicate_in_other_column(self):
        import io
        from pdfplumber import open as open_pdf
        result, report = edit_text(SOURCE, {'scope':SCOPE, 'changes':CHANGES})
        self.assertEqual(report['changedPages'], 1)
        self.assertEqual(report['targetPages'], [2,2])
        with open_pdf(io.BytesIO(result)) as doc:
            page = doc.pages[1]
            self.assertIn('смт Зразкове, Колишній р-н,', page.crop((0,0,290,page.height)).extract_text())
            self.assertIn('селище Зразкове, Самарівський район,', page.crop((290,0,page.width,page.height)).extract_text())

    def test_multiple_scopes_in_one_copy(self):
        changes = [{'old':'10 днів','new':'15 днів','scope':dict(ANY,section='Умови оплати')},
                   {'old':'100 грн.','new':'150 грн.','scope':dict(ANY,page=2)}]
        _, report = edit_text(SOURCE, {'scope':ANY,'changes':changes})
        self.assertEqual(report['changedPages'], 2)
        self.assertEqual(report['targetPages'], [1,2])

    def test_missing_second_edit_and_scope_isolation(self):
        for scope,changes,code in [
                (SCOPE,[CHANGES[0], {'old':'відсутній','new':'інший'}],'NOT_FOUND'),
                (dict(SCOPE,party='QA-999'),CHANGES,'SCOPE'),
                (dict(ANY,section='Умови оплати'),[{'old':'100 грн.','new':'150 грн.'}],'NOT_FOUND'),
                (ANY,[CHANGES[1]],'AMBIGUOUS'),
                (SCOPE,[CHANGES[1],CHANGES[1]],'OVERLAP'),
                (SCOPE,[dict(CHANGES[0],new='漢字')],'GLYPH'),
                (SCOPE,[dict(CHANGES[0],new='широкий '*18+'текст')],'FIT')]:
            with self.subTest(code=code), self.assertRaisesRegex(Rejected, code):
                process({'source':base64.b64encode(SOURCE),'text':{'scope':scope,'changes':changes}})

    def test_protocol_refuses_mixed_selectors(self):
        with self.assertRaisesRegex(Rejected,'SELECTOR'):
            process({'source':base64.b64encode(SOURCE),'cell':{},'text':{'scope':SCOPE,'changes':CHANGES}})

    def test_visible_mark_outside_edit_fails_verification(self):
        from text_edit import inspect, verify, edits_by_line
        from cell import open_source, write_pdf
        from pypdf import PdfWriter
        plan = {'scope':SCOPE,'changes':CHANGES}
        good, _ = edit_text(SOURCE, plan)
        lines, _ = inspect(SOURCE,open_source(SOURCE))
        changes, _, _ = edits_by_line(lines,plan)
        line, = changes
        writer = PdfWriter(open_source(good), full=True)
        stream = writer.pages[1].get_contents()
        stream.set_data(stream.get_data()+b'\nq 0 g 40 200 14 10 re f Q')
        writer.pages[1].replace_contents(stream)
        with self.assertRaisesRegex(Rejected,'VERIFY'):
            verify(SOURCE,write_pdf(writer),{line:'селище Зразкове, Самарівський район,'},lines,changes)


if __name__ == '__main__':
    unittest.main()
