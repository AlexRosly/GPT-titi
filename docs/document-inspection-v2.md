# Document inspection and execution V2

Baseline: `AlexRosly/GPT-titi` main `1e6589989a34d0c1f1ecada6a219f200493a82a0`.

## Problem and behavior

The old DOCX inspector returned at most 20 rows, even when the remaining rows fit
its existing byte budget. A 25-row inspection therefore needed another model
round trip. Each continuation also repeated JSON field names and already-read
attachment text. The additional-call budget could expire before a small edit.

Inspection now separates the complete local selection from what is sent to the
model. A bounded view is not a file-size or execution-range limit. The model
chooses the intended operation; the worker scans and executes it locally.

This patch implements the shared selection/presentation layer and a DOCX adapter.
It does **not** implement an XLSX original-preserving editor, spreadsheet formula
evaluation or unrestricted large-file support.

## Inspection contract

`inspect_docx(fileId, target, offset, query)`:

- Start with `tables` for table/border work, or `document` for paragraphs.
- Batch up to 64 distinct table IDs in one target, such as `table7,table8`.
- `query: null` retains detailed inspection. Legacy actions may omit the field;
  new strict provider schemas require it, with null allowed.
- A table query has `mode: "rows" | "summary"`, `start`, `end`, `contains`.
  Start/end select original zero-based row coordinates `[start,end)` separately
  within each requested table. Null end means through the end.
- `contains` is a case-insensitive NFC-normalized literal substring, not code or
  a regular expression. It scans full selected row text, including undisplayed
  rows. Null means no text filter. No cell-column predicate is provided yet.
- Detailed responses use the existing 14,000-byte UTF-8 JSON bound, with explicit
  `nextOffset` if needed. There is no 20-row page. Offset indexes the filtered
  result and requires the same target/query.
- Summary shows up to three labeled source rows (first, second, last) and exact
  counts. It is explicitly sampled, not a complete read. A very wide individual
  row may still exceed the response bound and is rejected explicitly.
- Cell snippets retain `textTruncated`; paragraph IDs expose exact text nodes.
  A cell snippet or summary must not be presented as a full-document analysis.
- Provider serialization uses `cellColumns`/`tableColumns` arrays and a versioned
  encoding, preserving every value and all selection/coverage metadata. Unknown
  shapes retain their original object representation.

Every table view includes a selection ID bound to source checksum, target and
predicate, plus exact row/cell counts. Mode and pagination do not change the
selection. `coverage` distinguishes displayed, matched, complete and sampled.
The selection ID covers **all matched physical cells**, not just the preview.

## Execution contract

For an explicitly requested uniform whole-selection border change, the model
submits one `selection_border` descriptor with `selectionId`, `expectedCells`,
`side`, `style`, `size`, `color`. For specific cells it uses observed `cell_border`
IDs; existing paragraph alignment and exact text-node replacement remain.

The server saves selections in the turn checkpoint and binds them to file ID.
The worker reloads the original private bytes, checks the checksum, re-evaluates
the predicate, and verifies expected counts before applying changes. Unobserved,
stale, wrong-file, duplicate and overlapping selections fail without publishing.
Arguments cannot inject their own saved-selection object.

Expansion runs locally, not as one model request per row. XML replacements are
joined in one pass; protected-field checks use a precomputed ancestor set.
The output is a distinct file. It is reopened, every requested property is
checked, all unrelated ZIP parts remain byte-identical, and XML outside edited
targets is preserved. This is structural verification, not runtime visual QA.

`complete: true` still finalizes only a successful, committed final edit. It
avoids a paid narration call. Other outstanding tool actions prevent premature
completion. Existing quota, owner checks, cancellation, usage settlement and
one-charge recovery are preserved.

## Large-document admission and resource limits

Ordinary Office text extraction is unchanged. If a DOCX exceeds the 64 KiB
extracted-text bound and structured tools are actually enabled for its model,
admission supplies an explicitly incomplete bounded outline instead. The worker
validates the full package without materializing all text into model context.
It retains ZIP, relationship, external-dependency, XML and unsupported-content
checks. Other formats and disabled-tool cases retain their previous behavior.

Existing bounds remain: 5 MiB compressed input, 20 MiB total ZIP expansion,
8 MiB per part, XML depth 64 and 100,000 parsed nodes, 192 MiB DOCX worker old
generation, up to 10 seconds per worker action, and existing total time/action
limits. These resource bounds can reject a complex file with fewer rows.
There are at most 100 model operation descriptors and 10,000 expanded cell
changes per atomic edit. These are execution safeguards, not preview row limits.

A tested 5,000-row, one-cell-per-row DOCX uses one summary and one local edit
with 5,000 cell changes. This is evidence for that fixture, not a claim that every
5,000-row document or 5,000-by-100 workbook fits these bounds.

The additional-provider-call cap remains $0.20 and the per-call output ceiling
remains 2,048 tokens. The initial provider call is outside that existing cap.
Pricing, reservation policy and user billing semantics are unchanged. A verbose
or inefficient model route can still exhaust the cap; no unlimited-spend path
has been added.

## State, diagnostics and restart behavior

Persisted additions: `computeState.docxSelections` and `docxLastInspection`.
No database migration or new index is required. Budget diagnostics version 2
add only bounded numeric counts and booleans for the last inspection; document
text, selection filters and file content are not logged.

Completed DOCX checkpoints recover through the existing completion marker
without another provider request or a second charge. A crash in an unfinished
plan still follows existing partial/interrupted recovery. This patch does not
add automatic replay of arbitrary unfinished plans or unknown provider usage.

Drain active document turns before updating or rolling back code, since an
in-flight provider action may refer to a newly introduced selection operation.

## Validation

Local checks on this baseline:

- `npm run test:docx`: 43 passed, zero failed/skipped.
- Regression command in the package README: 88 passed, zero failed; seven
  MongoDB-dependent cases skipped because no test replica set was available.
- Both provider APIs exercise the actual local inspector/editor, byte limits,
  saved selections, cumulative budget checks, cancellation and finalization.
  Provider responses and MongoDB are mocked in those unit/workflow tests.
- The cumulative-budget tests charge nonzero prompt and output tokens at each
  simulated step; output includes an assumed reasoning allowance. They do not
  prove a particular live model will choose the same route.
- Supplied act: five relevant tables, 25 rows, 55 cells, one 12,001-byte detailed
  inspection, no next page. Seven signature lines extended with 14 targeted
  cell edits. Text and unrelated ZIP parts remained exact. Five-page render
  inspection confirmed all seven full-width lines; pages 1–3 were pixel-identical.
  Local rendering showed a filename-dependent converter artifact even for a
  byte-identical unedited copy; the verified comparison used Cyrillic filenames
  for both source and result. No rendering library is added to the backend.
- No live paid provider request or production deployment was performed.

`scripts/checkDocxWorkflowBudget.js` performs an offline cumulative simulation.
Unlike the older single-step comparison, it increases spend after each planned
provider call. It uses conservative input estimates and configurable **assumed**
output tokens, including reasoning. It emits no source content and makes no API
calls. The sample route is supplied by the operator, not discovered by a model.
The included validation JSON records both 1,024- and 2,048-output-token scenarios.

Run the real integration tests on a dedicated `gptiti_files_test_*` replica-set
database before server acceptance. The test suite drops that database.

## Extending this design to XLSX

Reuse `services/documents/inspection.js` for source-coordinate selection,
literal filtering, selection identity and bounded views. An XLSX adapter must
add worksheet/column/range addressing, typed predicates, workbook-specific
resource bounds, and preservation rules for formulas, styles, merges and
relationships. It should stream or chunk local work as needed while presenting
one execution job to the user. Chunking must not create one paid model call per
20 rows. Do not claim a sample covers the whole workbook or rebuild an existing
workbook from sampled rows. Existing XLSX read/create behavior is unchanged.
