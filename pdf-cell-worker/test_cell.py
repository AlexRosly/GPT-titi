import io
import sys
import unittest
from pathlib import Path

from pypdf import PdfWriter
from pypdf.generic import DictionaryObject, NameObject
from cell import Rejected, edit, open_source, rewritten, source_bytes, slot, verify


SOURCE = Path(sys.argv.pop(1)).read_bytes()
DATE = (2, 'QA-202', 'Дата', '13.11.2026', '07.11.2026')


def with_change(change):
    writer = PdfWriter()
    writer.clone_document_from_reader(open_source(SOURCE))
    change(writer)
    data = io.BytesIO()
    writer.write(data)
    return data.getvalue()


class CellTests(unittest.TestCase):
    def test_changes_only_requested_date_or_longer_amount(self):
        for target in (DATE, (2, 'QA-202', 'Сума, грн', '760,18', '7606,18')):
            result, report = edit(SOURCE, *target)
            self.assertNotEqual(result, SOURCE)
            self.assertEqual(report, {'page': 2, 'pages': 2, 'changedPages': 1, 'changedCells': 1})

    def test_wrong_page_value_column(self):
        for args, code in [((1,*DATE[1:]), 'PDF_CELL_NOT_FOUND'),
                           ((2,'QA-202','Дата','15.11.2026',DATE[-1]), 'PDF_CELL_VALUE_MISMATCH'),
                           ((2,'QA-202','Ціна',*DATE[-2:]), 'PDF_CELL_NOT_FOUND')]:
            with self.assertRaisesRegex(Rejected, code):
                edit(SOURCE, *args)

    def test_repeated_row_key(self):
        reader = open_source(SOURCE)
        ops = reader.pages[1].get_contents().operations
        ids = [i for i,(args,op) in enumerate(ops) if slot(args,op) and source_bytes(slot(args,op)[0]) == b'QA-203']
        self.assertEqual(len(ids), 1)
        duplicated = rewritten(reader, 1, ids, b'QA-202')
        with self.assertRaisesRegex(Rejected, 'PDF_CELL_AMBIGUOUS'):
            edit(duplicated, *DATE)

    def test_refuses_overflow(self):
        with self.assertRaises(Rejected):
            edit(SOURCE, 2,'QA-202','Сума, грн','760,18','9'*24)

    def test_rejects_changed_neighbor_and_another_page(self):
        result,_ = edit(SOURCE, *DATE)
        for page, row in [(2,'QA-203'), (1,'QA-101')]:
            other,_ = edit(result, page,row,'Сума, грн','760,18','7606,18')
            with self.assertRaisesRegex(Rejected,'PDF_CELL_OTHER_CHANGES'):
                verify(SOURCE, other, 1, *DATE[1:])

    def test_rejects_graphical_change_outside_target(self):
        result, _ = edit(SOURCE, *DATE)
        def extra_mark(writer):
            from pypdf.generic import ContentStream
            stream = ContentStream(writer.pages[1].get_contents(), writer)
            stream.set_data(stream.get_data()+b'\nq 0 g 12 12 20 20 re f Q\n')
            writer.pages[1].replace_contents(stream)
        writer = PdfWriter()
        writer.clone_document_from_reader(open_source(result))
        extra_mark(writer)
        data=io.BytesIO()
        writer.write(data)
        with self.assertRaisesRegex(Rejected,'PDF_CELL_VISUAL_CHECK'):
            verify(SOURCE,data.getvalue(),1,*DATE[1:])

    def test_refuses_encrypted_and_interactive_sources(self):
        writer = PdfWriter()
        writer.add_blank_page(100,100)
        writer.encrypt('test', algorithm='AES-128')
        encrypted=io.BytesIO()
        writer.write(encrypted)
        protected=encrypted.getvalue()
        with self.assertRaisesRegex(Rejected, 'PDF_CELL_ENCRYPTED'):
            edit(protected, *DATE)
        for key in ('/AcroForm','/Perms'):
            document=with_change(lambda w: w.root_object.update({NameObject(key):DictionaryObject()}))
            with self.assertRaisesRegex(Rejected, 'PDF_CELL_UNSUPPORTED'):
                edit(document,*DATE)

    def test_image_only_page_cannot_produce_an_edit(self):
        from PIL import Image
        data=io.BytesIO()
        Image.new('RGB',(80,50),'white').save(data,'PDF')
        with self.assertRaisesRegex(Rejected,'PDF_CELL_TEXT_LAYER_REQUIRED'):
            edit(data.getvalue(),1,*DATE[1:])


if __name__=='__main__':
    unittest.main()
