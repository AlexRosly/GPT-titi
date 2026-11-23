import base64
import json
import sys
from cell import Rejected, edit, edit_batch


def process(request):
    source = base64.b64decode(request['source'], validate=True)
    if sum(key in request for key in ('cell', 'cells', 'text')) != 1:
        raise Rejected('PDF_CELL_SELECTOR')
    if 'text' in request:
        from text_edit import edit_text
        data, report = edit_text(source, request['text'])
    elif 'cells' in request:
        data, report = edit_batch(source, request['cells'])
    else:
        data, report = edit(source, **request['cell'])
    if len(data) > 8 * 1024**2:
        raise Rejected('PDF_CELL_SIZE')
    return {'ok': True, 'text': json.dumps(report), 'exports': [base64.b64encode(data).decode('ascii')]}


if __name__ == '__main__':
    try:
        result = process(json.load(sys.stdin))
    except Rejected as error:
        result = {'ok': False, 'text': str(error), 'exports': []}
        if hasattr(error, 'failed_index'):
            result['failedIndex'] = error.failed_index
    except Exception:
        result = {'ok': False, 'text': 'PDF_CELL_INVALID_DOCUMENT', 'exports': []}
    json.dump(result, sys.stdout)
