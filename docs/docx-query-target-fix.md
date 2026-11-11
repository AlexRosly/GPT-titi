# DOCX query-target hotfix

Base: `1f86b0ffa41fa26706612dc41862c1feb0f937f2`, the deployed inspection-V2 patch.

## Reproduced defect

The live failure showed `DOCX_INVALID_QUERY_TARGET` on repeated fresh chats with
the same source. The live model arguments were not available. The deployed code
raises this error when a well-formed, non-null `query` is supplied for an index,
paragraph or cell target, although the public tool schema permits that object.
Only explicit table IDs accepted queries. For example, this schema-valid call
was rejected before file reading:

```json
{
  "fileId": "012345678901234567890123",
  "target": "tables",
  "offset": 0,
  "query": {"mode": "rows", "start": 0, "end": null, "contains": null}
}
```

The same rejection was reproduced for `document`, `p0` and `cell0`. Null query
worked, explaining how different model argument choices can take different
paths for the same task. This is a contract bug in our integration, not evidence
of a damaged source file or an exhausted cost budget.

## Changes

- Every advertised target now accepts the query contract. Table IDs retain
  their row-selection semantics and checksum-bound edit selections.
- Indexes and paragraph text nodes apply source-item ranges and literal filters
  to complete source text. `sourceIndex` identifies the original position;
  `sourceTotal` identifies pre-filter size. Summaries remain explicitly sampled.
  Indexes never issue selection IDs for bulk editing.
- A cell alias passes its query through to its existing paragraph target.
- Null/default queries are equivalent. Non-default predicates are executed,
  not silently discarded to suppress the error. Byte limits and cursor coverage
  remain enforced after filtering.
- Column encoding includes sourceIndex and preserves compatibility with old
  index shapes. No values are removed.
- The prompt specifies target-specific coordinates and recommends a full
  bounded initial index (`query: null`) before choosing relevant detail targets.
- DOCX argument validation now runs inside the common guarded action handler,
  before ownership/storage reads. Argument errors reaching this handler become a failed tool
  result with a fixed correction hint, allowing a corrected call within the
  same turn. These failed attempts count toward the existing five-action ceiling.
  Responses API schema validation still runs before this handler; its rejected
  calls retain the existing protocol feedback and overall call bound.
  Budget checks still precede every paid continuation; recovery is bounded and
  is not guaranteed if the model repeats errors or remaining budget is too low.
- Python execution, prices, reservations, ownership, quota, cancellation,
  unknown-usage handling and final output transactions remain unchanged.

## Validation scope

The new tests exercise null/default/summary on every target; ranges, empty
matches and matches beyond a displayed snippet; filtered byte pagination;
production workers; both provider APIs with non-null rows/summary/filtered
indexes; argument correction before any file read; and the unchanged retry/run
bound. Existing regression suites also run. Provider replies in these workflow
tests are mocked. No live paid provider stability claim is made.

The real MongoDB integration fixture now follows index-with-query → table
selection → final edit, asserts all three calls' usage, and verifies one ledger
charge plus duplicate-request protection. It requires a dedicated test replica
set and is skipped when `FILES_TEST_MONGO_URI` is unavailable.

On the supplied act, five independent offline routes use different index query
forms, then inspect all 25 signature-table rows and perform the same 14 targeted
border changes. The output's uncompressed ZIP parts are compared with the
previously visually verified output, including all seven full-width lines.
These routes use the real worker but predetermined edit targets; they are not
five live model runs. Release counts and results are in the package validation
JSON and README.

## Deployment

Apply only after inspection V2, run the package checks and the updated dedicated
MongoDB integration test, then restart the backend after active document turns
finish. No new dependencies, migrations, indexes, frontend changes or flags.
Keep existing DOCX flags enabled. Do not reverse this patch during active turns
whose index queries may depend on the new semantics.

The previously documented limits for file size, processing resources, formats
and large-file support remain. This fix addresses argument compatibility and
correction; it does not implement the future large-XLSX/background-job stage.
