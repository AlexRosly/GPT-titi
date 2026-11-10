# DOCX continuation budget fix

Base: `c0842ae2addb2410054a737bd54597d2dae27ccd` (backend main, checked 2026-11-10). Stage 1 must already be installed. Frontend main `9d60806` already supports document statuses; this patch needs no frontend release. This is an unnumbered DOCX follow-up, not OCR patch 43. OCR stays unchanged.

## Problem and behavior

The reported live refusal was correct: $0.042745 spent + $0.163525 next-call estimate = $0.20627, above the $0.20 additional computation cap. Its 20,417 estimated input tokens included repeated source/inspection context. The blocked estimate is not a charged call. The initial model request remains outside this existing additional-call cap.

Changes apply to Chat Completions and Responses:

- After a successful inspection, replace only the server-built repeated extraction of that DOCX with a source reference (file ID, checksum, name and instructions to inspect further regions). A request-local WeakMap identifies real attachment parts. User marker-like strings cannot trigger removal. User messages, system instructions, other attachments, OCR, stored history, original files and saved extraction are unchanged. Inspect results, truncation indicators, pagination and Responses reasoning/output items stay in the continuation. This patch does not summarize or discard old inspections.
- Pass DOCX inspection/verification JSON as `data`, not a JSON string nested in another JSON string. All fields remain available.
- A local DOCX action no longer forecasts the price of an imaginary subsequent provider call. Time/action/size/worker/ownership/checksum/cancellation/quota guards still apply. Python keeps its old preflight. Every actual paid continuation still uses unchanged `accounting.begin`, the same $0.20 cap, reservation extension and actual-usage settlement. There is no extra provider call or model substitution.
- `edit_docx` has a strict boolean `complete`. The model must choose true only if this batch finishes all requested work, including other files and requested explanations. Omitted legacy arguments retain non-terminal behavior. A successful final edit records a completion marker in the same transaction as its verified output. Only then can the server return the attachment with a fixed structural-verification notice, without another model call. False, failure, quota refusal, cancellation or outstanding Responses tool calls cannot short-circuit the task. Explicit create-file/exact-transcription workflows retain their existing finalization.
- A crash after that transaction but before final reply recovers the completed result through existing V2 commit/charge logic; it does not rerun tools or call the provider. Unknown provider usage and cancellation retain their existing handling. Stored completion markers remain readable after disabling the new behavior.

The marker proves the chosen operations were applied and a real DOCX was saved. It does **not** independently prove the model chose every user-intended location. Visual pagination is not checked in production. Unsupported edits still fail explicitly. The final notice is fixed English, consistent with current document-status UI; no language model is called for that notice.

## Offline measurements

Using the supplied private five-page document (74,529 bytes; extracted text 18,908 bytes), a reconstructed fresh-chat prompt, identical current tool contracts in both columns, and $5/$30 per million input/output tokens:

| After inspection | Estimated input before | Estimated input after | Next-call estimate before | Next-call estimate after |
| --- | ---: | ---: | ---: | ---: |
| Table index | 14,163 | 5,811 | $0.132255 | $0.090495 |
| Relevant tables, first 20 rows | 20,255 | 9,737 | $0.162715 | $0.110125 |
| Remaining 5 rows | 21,851 | 10,777 | $0.170695 | $0.115325 |

Every estimate still includes 2,048 output tokens, the existing tokenizer margin and per-message allowance. At the **same hypothetical already-spent amount** of $0.042745, the second-row projection falls from $0.205460 to $0.152870. These are reconstructed estimates, not an exact replay of the production prompt, actual usage, a price guarantee or an estimate of total task cost. Actual spend must be updated between calls; the benchmark's fixed spend is only for comparing one decision boundary. A long history, expensive reasoning or extra operations can still hit the unchanged cap.

The relevant table inspection is paginated: 20 rows plus 5 rows. Completing that plan uses three inspections and one edit, within five actions. Do not ignore `nextOffset` to make a test pass. A terminal edit avoids one final provider request; intermediate edits retain continuation.

Read-only reproduction (no API calls, DB or output document):

```sh
node scripts/checkDocxContinuation.js /private/source.docx tables table7,table8,table9,table10,table11
```

Choose actual table IDs from the tested document. The script follows pagination and emits only counts, estimates and resource measurements, never file text or names. Override rates/spend with `DOCX_BENCH_INPUT_PER_M`, `DOCX_BENCH_OUTPUT_PER_M`, `DOCX_BENCH_SPENT_USD` for a different experiment. Defaults match this incident. It compares identical new schemas with/without context optimization, not old vs new deployed model behavior. Resource measurements include parser workers and cold tokenizer initialization; max RSS is the whole CLI process, not a measurement of isolated editor worker RSS. No compute/resource cap is increased.

## Checks and deployment

Local checks: 32 DOCX tests passed; 87 targeted regression tests passed, 7 DB tests skipped because no dedicated replica set was available. Tests use real DOCX workers/editors and mocked providers. Long multilingual fixtures exercise the real budget/accounting function for both APIs. Coverage also includes unchanged source/other parts, old non-terminal behavior, strict completion flag, multiple outstanding calls, local near-cap completion, real paid-boundary refusal, cancellation before publication, quota refusal, rollback and completed-checkpoint recovery/one charge. Existing engine cases cover nested/merged tables and multilingual exact text/alignment edits.

```sh
npm run test:docx
node --test test/computation/policy.test.js test/computation/files.test.js test/computation/agent.test.js test/chatDeliveryV2/responsesProvider.test.js test/chatDeliveryV2/responsesTurn.test.js test/chatDeliveryV2/responsesWorker.test.js test/files/officeInput.test.js test/files/office.test.js test/files/textInput.test.js test/files/storage.integration.test.js
FILES_TEST_MONGO_URI='mongodb://127.0.0.1:27017/gptiti_files_test_docx_continuation?replicaSet=rs0' npm run test:docx:integration
```

The integration test drops its dedicated `gptiti_files_test_*` DB. Never pass a production URI. Its updated scenario expects two provider calls, original/copy/provenance persistence, cumulative known usage, quota accounting, reservation release and one charge after duplicate/recovery. Without a URI it skips; that is not a pass.

1. Start from a clean stage-1 checkout; review intervening commits before applying. `git apply --check backend-docx-continuation.patch`, then `git apply backend-docx-continuation.patch`. No dependency, index, migration or Docker-image changes.
2. Run the checks above on the server's disposable test DB, plus the team's normal V2 reservation regressions.
3. Keep `DOCX_EDIT_ENABLED=true`. Set `DOCX_CONTINUATION_V2_ENABLED=true` explicitly and restart through the usual deployment procedure. The new flag defaults on when omitted; `false` disables these continuation optimizations. `DOCX_EDIT_ENABLED=false` still removes DOCX tools entirely. Do not change `COMPUTE_MAX_USD`, token pricing, model selection or action/output limits.
4. Run one controlled live request on the same model with the original act. Confirm all seven signature lines, unchanged text/formatting, a separate valid Word copy, and actual recorded usage. Follow all inspection pages. Then check F5, Library/history download, duplicate-message idempotency and Cancel/reservation release. Mock-provider success alone does not close live acceptance.

Rollback: drain active turns, set `DOCX_CONTINUATION_V2_ENABLED=false`, restart. This restores full repeated context, nested tool text, old DOCX preflight and normal model finalization while leaving the editor available. Existing completion markers/history/files remain readable. For code rollback, drain turns and apply `git apply --reverse --check backend-docx-continuation.patch` then reverse the patch; do not remove stored files/provenance or clear caches. Pending live requests must not cross a schema-changing code rollback.

No live paid provider test, production access, Microsoft Word acceptance or new DB integration pass is claimed here.
