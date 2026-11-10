# DOCX editing — stage 1

Base: backend `e5651168f2fbcaf5c4c8cfadd1ad3b9a0d99254d`, frontend `1f64c48478d56048de50b60388d4381a7070fa63` (main checked 2026-11-10). Includes current file library, provider adapters and V2 reservation/checkpoint code. Last numbered OCR patch is 42; later library/model changes are unnumbered. This release uses the name `docx-editing-stage1`, not an assumed OCR patch number. OCR remains `regions-4`.

## Behavior

The model receives `inspect_docx` and `edit_docx` when enabled. It inspects the original package, identifies real table/cell/paragraph/text-node IDs, and submits explicit operations against that source checksum. The server produces a separate binary DOCX. The source file is never overwritten. The output name must differ from the source name.

Supported operations:

- Physical table-cell borders: top/bottom/left/right, line style, thickness, color. Extend a signature line by copying the observed middle-cell bottom border to adjacent cells, without changing cell widths or text.
- Paragraph alignment, preserving other paragraph and run properties.
- Exact replacement of one inspected text node with an expected-value check. Split runs need explicit separate replacements; overlapping parent/child targets are refused.

`inspect_docx` targets: `tables` (table index), `document` (paragraph/table outline), `table7`, up to five comma-separated table IDs, `p12`, or a cell's first paragraph. Follow `nextOffset`; snippets disclose truncation. Table inspection reports physical cells, spans, vertical merges, widths and direct borders, not fully resolved inherited styling. This is language-independent and does not invoke OCR or silently correct names, amounts or codes.

For table tasks, use the table index first: tables index → relevant rows → one edit. This avoids paging through unrelated body paragraphs within the existing action limit. The adapter verifies requested operations, not whether the model selected every location intended by the user.

## Preservation and verification

- Strict production OOXML package, relationship and XML checks run in a bounded worker before and after editing.
- Only selected property/text nodes inside `word/document.xml` are patched. The original XML is not reserialized. Inserted properties reuse the source namespace prefix and schema order.
- Reopen output and verify every requested property/text value, the package member set and every other part's uncompressed bytes. Styles, fonts, images, headers, footers and unrelated document XML remain unchanged.
- ZIP compression/metadata and the binary checksum change. This is not a byte-identical ZIP promise.
- Source/result checksums, operation list and verification flags are retained in private `ManagedFile.documentEdit` metadata and the turn checkpoint.
- Production verification is structural. `visualVerification:false` is explicit in tool output; the model must not claim it saw rendered pages. Rendering in CI/manual QA is separate. Exact pagination in Microsoft Word still needs acceptance testing there.

Fail closed for macro/embedded/ActiveX/signed packages, external non-hyperlink dependencies, protection, tracked changes, altChunk/subDoc, unsupported encodings and unsupported targets with fields/drawings/content controls. The editor does not execute uploaded code or fetch package URLs. It does not edit text boxes, shapes, header/footer contents, section geometry, table geometry or arbitrary styles in this stage.

## V2 integration and limits

Both Chat Completions and Responses use the existing computation executor, reservations, accumulated provider usage, leases, quota transaction, temporary output, final attachment promotion, history and recovery. Checkpoint publication uses the existing turn lease/cancellation guard. No new billing tariff is added. Unknown provider usage retains the existing reconciliation behavior. No model-price, context, reservation, OCR/cache or quota limits are increased.

The feature shares existing action/call/cost caps (default 5 actions, 6 follow-up calls, $0.20 additional computation budget). Each inspection is an action. Tool schemas and inspection results add model context; paid cost depends on actual provider usage. The prior `COMPUTE_BUDGET_LIMIT` can still occur before any edit, especially with expensive models or long history. This release supplies the missing editing capability; it does not certify that the previously failing production request now fits its budget.

Editor-specific bounds: source/result ≤5 MiB, expanded ZIP ≤20 MiB, individual ZIP entry ≤8 MiB, ≤100 operations / 32 KiB arguments, inspection ≤20 entries / about 14 KiB, two local workers, 192 MiB old-generation heap plus 16 MiB young-generation heap per worker. Heap caps are not an RSS guarantee. Worker deadline is the minimum of 10 seconds and remaining configured per-run/total time. These are additional restrictions within existing compute quotas.

## Installation for Alex

1. Start from the base above or review intervening changes. Use a clean checkout; do not force a failed patch.
2. `git apply --check /path/to/backend-docx-stage1.patch`
3. `git apply /path/to/backend-docx-stage1.patch`
4. `npm ci` — JSZip 3.10.1 moves from development to production dependencies. No new version is introduced.
5. Run `npm run test:docx` and the regression commands below.
6. Run database integration on a dedicated disposable Mongo replica-set database only:
   `FILES_TEST_MONGO_URI='mongodb://127.0.0.1:27017/gptiti_files_test_docx_stage1?replicaSet=rs0' npm run test:docx:integration`
   This test drops that database. Never supply a production URI. A run without the variable skips the test and is not a pass.
7. Deploy with `DOCX_EDIT_ENABLED=false` initially. Deploy the matching frontend status change before enabling the feature. No database migration/index or Python Docker rebuild is required.
8. In staging set `DOCX_EDIT_ENABLED=true`. Existing `PRIVATE_FILES_ENABLED=true`, `COMPUTE_V2_ENABLED=true`, Office input and file output must be enabled; per-model disable flags remain authoritative. Restart the existing app process with updated environment through the normal deployment procedure.
9. Execute the acceptance scenarios, including the actual chosen model and its production-like prices/context. Enable production only after those pass. Do not raise the cap to make a failing test green.

Rollback: drain active editing turns, set `DOCX_EDIT_ENABLED=false` and restart normally. Existing files/history remain readable. To revert code, apply the patch in reverse after `git apply --reverse --check` and run `npm ci`. Leave optional stored provenance in place; no deletion or cache purge is needed. The frontend is backward-compatible without the optional `kind:'document'` metadata.

## Validation recorded locally

- 19 new engine/workflow tests passed. Real DOCX parsing/writing and worker cancellation are exercised; database/provider boundaries in workflow tests are mocked.
- 74 existing targeted regression tests and one new document-recovery regression test passed (computation, Responses, Office input/output, upload validation). Six existing database tests and the new full V2 database test were skipped because no isolated Mongo replica set was available.
- Frontend delivery suite: 144 tests passed; TypeScript and ESLint on changed frontend files passed.
- Backend syntax checks and `git diff --check` passed. Repository-wide ESLint could not run: ESLint 9 has no configured `eslint.config.*` in this base.
- Private supplied five-page DOCX exercised outside the repository: 7 signature rows / 14 outer-cell border changes, extracted text identical, other package parts byte-identical. Rendered original/copy: pages 1–3 pixel-identical; pages 4–5 changed only at the seven extended signature lines, with no pagination shift. The private input/output and its data are not distributed with the patch.
- No paid provider call, production database test, browser end-to-end test or Microsoft Word acceptance test was executed here. The mock provider tests prove protocol wiring, not live model tool-selection accuracy.

Regression command:

```sh
node --test test/computation/policy.test.js test/computation/files.test.js test/computation/agent.test.js test/chatDeliveryV2/responsesProvider.test.js test/chatDeliveryV2/responsesTurn.test.js test/chatDeliveryV2/responsesWorker.test.js test/files/officeInput.test.js test/files/office.test.js test/files/storage.integration.test.js
```

Staging acceptance:

- Upload a DOCX; request border-only change. Original downloads unchanged; a separate valid Word copy is attached; all intended lines are changed; text/widths/styles are unchanged. Check Word as well as the raw extraction.
- F5 after success: same attachment/status, no second charge; file is available in Library. A duplicate `clientMessageId` does not rerun the edit.
- Cancel during inspection/edit and during provider continuation: keep source/draft; no partly written file, no leaked quota/reservation. Verify existing recovery behavior after worker interruption.
- Resume a task using its file from history/Library. Verify ownership and missing/deleted-source errors.
- Quota exhaustion, unsupported document, stale checksum and cost-cap refusal: precise incomplete status, no invalid output, known usage settled once. The model must not announce a completed edit without an attached verified result.
- Flag off: original Python/file/OCR behavior and UI remain available, DOCX tools absent.
