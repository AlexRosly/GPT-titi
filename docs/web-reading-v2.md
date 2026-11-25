# Web reading V2 — replacement implementation (patch 20)

Base: c7f5218 (patch 19 reverted). Requires frontend PR 211 for WEB_* messages.

## Activation

Off by default. Set `WEB_READING_V2_ENABLED=true` in the actual PM2 environment,
then restart with updated environment after tests. `WEB_READING_ENABLED` from
patch 19 has no effect. Existing/new model records are eligible unless
`webInputEnabled:false`. No migration/backfill is required.

## Scope and contract

Source selection is shared by both V2 provider APIs and by the HTML and browser workers.

- A bare HTTP(S) URL or a plain list of up to three distinct URLs is handled at admission. Common schemeless domains default to HTTPS. Supply an explicit scheme for other domains. The worker receives the selected public sources.
- In prose, the user's selected chat model interprets the current message in its own language. Its normal first call can answer directly, ask which source was intended, or request `read_supplied_pages`. No keyword dictionary, translator or separate router model is involved. The user can mention URLs in instructions, code, examples or questions about router setup.
- The backend validates every model-selected URL against the canonical public candidates from the current message. Historical, unrelated and invented destinations are ineligible. The original user message is preserved. Any selection containing an ineligible target is rejected as a whole. Failure to select a valid target can yield a clarification.
- In messages containing only local addresses and prose, the model can explain the question or the access limitation in the user's language. An isolated local URL returns the existing protocol restriction. Actual downloads retain the normal DNS, redirect and origin controls.
- The ordinary first call is also where document tools are selected. Forced PDF/DOCX editing workflows keep their existing document tool contract. Source selection is offered on models with web input enabled and requires function-calling support for prose. Reading quality in a language depends on the selected model.
- On a semantic read, source choice and observed usage are recorded before retrieval. HTML preparation supplies the actual pages for the answer. The browser opens the selected pages in order within its limits. A Responses conversation carries the original function call ID and tool result into the continuation. Only the previous plan of an already queued request is used when recovering it.

Limits: 15 seconds per URL including DNS/redirects/body, at most 3 redirects,
2 MiB compressed and 2 MiB decoded bytes, 16 KiB response headers, 12 KiB UTF-8
extracted text per page, 100000 parsed nodes/128 nesting levels. Truncation is
explicit in source data and the server-generated source footer. Provider deadline
120 seconds, maximum completion tokens 4096 for web turns only. Length termination
is disclosed. Server-rendered text can be read; client-only pages return
WEB_JAVASCRIPT_REQUIRED when detected. Some sites may return an incomplete shell
that cannot reliably be detected: this is not full browser rendering.

## Reservation and billing

The admission hold remains the existing request/attachment estimate. After the
page text and actual model payload are prepared, compute a single-call estimate:
max(cl100k_base, o200k_base token count of messages/tools JSON) + 15% + framing
headroom (512 + 16/message), plus conservative 32768 tokens per image. The JSON
input cap is 256 KiB; the estimated input plus output cap is 65536 tokens.
The estimate is conservative, not a provider-context guarantee for every future
model. Existing model input/output prices and frozen token value are used.

Hold = max(admission hold, ceil((estimated input * input price + 4096 * output
price) / 1e6 / token value)). The extra hold and providerStartedAt commit in ONE
transaction with lease/attempt/owner guards. A separate `reservation_hold:web:...`
ledger key avoids colliding with admission. No direct balance writes bypass the
ledger or its balance events. The full hold is released/settled once through V2.
Insufficient balance returns INSUFFICIENT_BALANCE with details before provider
start; the admission hold is released, no model charge occurs. It does not
silently shorten the requested context to fit the balance.

Actual provider usage is billed by the existing V2 logic, with its existing
fallback if usage is absent. Website downloads have no paid provider API fee.
A bare-link HTML turn usually has one paid model call. A prose mention answered directly also uses one. If the first call selects a page, the subsequent answer is a paid continuation. The backend aggregates actual usage across those calls into one chat charge, and includes earlier usage when reserving for a continuation. Browser turns may make further calls within their existing budget. Ambiguous provider failures
retain the existing reconciliation behavior; they are never blindly replayed.

## Recovery, history and privacy

Page checkpoints contain at most 36 KiB extracted text plus metadata per turn.
They live in the private turn record, not public file storage. Snapshot responses
never expose the raw cache. A crash before providerStartedAt requeues via the
normal concurrency-limited scheduler; completed page reads are reused. A crash
during an unfinished download may repeat that GET. Known-retryable failures keep
successful pages; explicit retry reattempts only failed pages. Saved provider
results recover through existing V2 completion without another model call/charge.

Assistant messages retain webSources (id, URL, requested URL, title, status,
truncation, fetchedAt or error), including private history reloads. The server
adds clickable source URLs to the answer, including file-generation summaries.
Failures are disclosed alongside successful pages. For direct HTML retrieval, all pages failing yields a specific WEB_* error before a model call. For a model-selected read, the answer can explain the retrieval failure in the user’s language, with completed model calls accounted for. Reading a source is not a claim that
all content on the website was read. Page text is untrusted data; it cannot grant
new tools or change system rules.

The current request gets raw page text. Subsequent turns use the normal existing
20-message history (including prior answer/source footer), not automatically
reinserted raw page caches. Supply the URL again to retrieve a fresh page.

SSRF defenses: HTTP(S) only, no credentials/custom ports, URL-normalized IP forms,
non-public IP and local host-name rejection, validate all DNS answers, pin the
chosen IP in the HTTP connection, and repeat checks for every redirect. There
are no ambient cookies/auth headers and no subresource requests. Do not weaken
these checks to solve a blocked site.

## Frontend compatibility

Old V2 envelope shapes are preserved. PR 211 accepts WEB_* errors and future
error codes. Optional snapshot `webStatus` is `{stage:'reading_web'|'answering',
completed,total}` during processing, otherwise null. Assistant DTO/history gets
`webSources`. Current frontend can display the textual source footer; richer
progress/source cards and info help remain a separate frontend PR.

## Tests and operational checks

`npm run test:web` — 13 reader/policy/token budget/cache/lease unit tests.
`npm run test:web:integration` — 11 Mongo replica-set tests including real local
Socket.IO admission ACK, provider cache recovery, reservation concurrency, new
account, explicit failures, retry and file coexistence. Model calls and downloads
are mocked, not paid API calls. Requires FILES_TEST_MONGO_URI with database name
`gptiti_files_test_*`; deletes that database. Never use a development/production
database containing application data. Also run existing file and V2 suites.

Local verification for this patch: 13 new tests and 92 existing file/V2 unit
regressions passed; all 15 WEB_* errors accepted by the merged frontend parser.
The international OCR engine suite was not rerun. Mongo integration tests are
provided but not executed here (no replica-set URI available). Live public URL
checks in this environment failed DNS with EAI_AGAIN, so server live checks remain
mandatory. These are not represented as successful integration/live tests.

After applying, keep the feature off for regression checks; then enable it in
staging. Test with the actual frontend: new account + short HTML URL, normal
message, attachment, generated file, a bad URL, all pages failing, mixed success,
retry, reload, and low balance. Verify one chat_charge operation per successful
turn and released holds on pre-provider failures. Logs WEB_V2_PREPARED and
WEB_V2_RESULT include only turn/model IDs, counts, estimate and error/status;
no page text, cookies or authorization headers are added by this feature.
