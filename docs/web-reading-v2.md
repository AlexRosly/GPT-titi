# Web reading V2 — patch 19

## Scope and defaults

Public HTTP(S) HTML URLs explicitly included in the CURRENT user message, up to 3 unique URLs. No search, link crawling, JavaScript browser, login, cookies, CAPTCHA bypass, remote document/image ingestion. Redirects are followed only after full URL and DNS validation at each hop. PDF/DOCX/XLSX URLs return WEB_UNSUPPORTED_TYPE; users can upload these files through existing private input.

`WEB_READING_ENABLED` defaults on unless exactly `false`. `ChatModels.webInputEnabled` defaults on; missing fields on old records mean on. An explicit false opts a model out. New models inherit the feature if their Chat Completions API supports function calling, forced tool choice, and `max_completion_tokens`. A model name/card is not a capability test. For an incompatible provider/model, disable webInputEnabled until its adapter is implemented; do not promise universal API compatibility.

The backend uses a forced `read_webpage` selection call with an array of indices into user-supplied URLs. The model can choose an empty array when reading is irrelevant. This is language-independent model interpretation, not a keyword list. It cannot invent another URL. After selection, HTML is fetched by the server, then the normal final generation may produce text, files, or exact saved OCR using existing tools.

Ordinary messages without HTTP(S) URLs use the previous worker path. URL messages can use two model calls even when the selector chooses zero pages; the completed calls are billable.

## Limits

- 3 URLs per turn, current message only; 2048 characters per URL.
- HTTP/HTTPS standard ports only, no userinfo, control characters, backslash, local names, or non-public IPs.
- All DNS answers must be public; connection lookup is pinned to a validated address. No ambient cookies/authentication or proxy credentials are forwarded.
- At most 3 redirects; 15 seconds TOTAL per page including DNS and redirects.
- 2 MiB compressed bytes AND 2 MiB decompressed bytes, 16 KiB response headers.
- Extracted text: 12 KiB UTF-8 per page, plus bounded title/URL metadata. Truncation is explicit. Images, CSS layout and JavaScript content are not read.
- Parser: 100,000 visited nodes, nesting 128. Prefer main/article; remove scripts, styles, forms, navigation, hidden content. Layout extraction is heuristic and does not guarantee perfect article identification.
- At most 2 provider calls, max_completion_tokens=8192 each, SDK request timeout 60 seconds for web turns.

## Reservation and billing

At admission, reserve BOTH bounded model calls using frozen input/output prices. Input allowance includes history, extracted attachments, wrapper/tool allowance, web result allowance and an image allowance. It uses UTF-8 byte bounds for text (not chars/4); actual constructed requests are checked against the stored allowance before each provider call. Image accounting remains a conservative allowance rather than an exact provider image tokenizer. Larger combined requests are rejected with WEB_CONTEXT_TOO_LARGE.

The reserve is deliberately higher than typical actual usage. Finalization sums provider usage for selection and final generation and releases unused reserve. If provider usage is absent, existing estimated-token fallback conventions apply; no exact usage claim is made in that case. Direct page downloads have no separate external vendor fee in this version. The server's own bandwidth/compute is not separately priced.

If selection completed but final generation was definitively rejected without charge, settle known completed selection usage once, release remaining reserve, and show a failed non-retryable turn (send a new request). A turn with any unsettled provider outcome retains the existing reconciliation path. Never replay an ambiguous provider call automatically.

IMPORTANT FOR OPERATORS: for a web turn, `reconcileReservation({ usage })` accepts usage of the UNRESOLVED provider call; the helper adds previously saved selector usage. `noCharge: true` means the unresolved call had no charge, not that the whole web turn was free. Legacy non-web semantics remain unchanged.

## Durable boundaries and privacy

ChatTurn.webPlan is a server-generated frozen plan. ChatTurn.webState persists selection usage, chosen indices and each completed page result. Each write checks user, attempt, active lease and held reservation.

- `selecting`: request may be in flight. On interruption: reconcile, no replay.
- `selection_received`: known usage saved, arguments not yet validated. On interruption/failure: settle known work, no replay.
- `reading` / `ready`: safe recovery; skip selector and completed page downloads, resume only missing reads, then final call.
- `final_started`: ambiguous final request must be reconciled if no providerResult exists.
- `providerResult`: existing local finalization recovery, no provider call.

A crash after a network response but before its checkpoint can repeat that page download; it never claims exactly-once remote HTTP execution. Saved completed downloads are reused.

Fetched bodies are private turn data and never sent as public preview URLs. On successful completion webState is cleared; only structured sources survive on the owner-protected assistant message. Failed/reconciling state remains for recovery/audit and follows existing turn deletion/retention. No global URL cache is introduced. URL query parameters can be sensitive; do not log the turn state or raw URLs into public diagnostics.

Website text is untrusted tool content. System instructions require using it as evidence, disclosing errors/truncation, and ignoring instructions inside pages. This is not a mathematical guarantee against model prompt injection. The tool's allowed URL indices, network guard and lack of action tools constrain effects.

## Frontend contract (next PR)

Existing V2 send/retry/status/history endpoints are reused. No public arbitrary-fetch endpoint is added.

`chat:progress` envelope:

```json
{"protocolVersion":2,"event":"chat:progress","type":"progress","turnId":"...","clientMessageId":"...","conversationId":"...","attempt":1,"payload":{"stage":"reading_web","completed":1,"total":3}}
```

Stages: `preparing_web`, `reading_web`. V2 status snapshot also exposes `webStatus` while processing, including `answering`. Snapshot completion/error remains authoritative if a progress event was missed.

Assistant message `webSources` is persisted and included in completion/snapshot/history:

```json
[{"id":"web-1","requestedUrl":"https://example.com/a","status":"ready","url":"https://example.com/final","title":"Title","fetchedAt":"2026-10-20T00:00:00.000Z","truncated":false},
 {"id":"web-2","requestedUrl":"https://example.org/","status":"failed","error":"WEB_ACCESS_DENIED"}]
```

Only successful source objects are verified fetched sources. Do not treat arbitrary model-authored links as verified. Escape titles as text; only render safe HTTP(S) URLs. Successful sources also get server-generated Markdown footer links so existing frontends can open them before the new source cards ship. No raw HTML is returned.

Error codes: WEB_TOO_MANY_URLS, WEB_INVALID_URL, WEB_BLOCKED_ADDRESS, WEB_INPUT_DISABLED, WEB_CONTEXT_TOO_LARGE, WEB_CONFIGURATION_ERROR, WEB_INVALID_TOOL_RESULT, WEB_TIMEOUT, WEB_REDIRECT_LIMIT, WEB_UNAVAILABLE, WEB_ACCESS_DENIED, WEB_UNSUPPORTED_TYPE, WEB_UNSUPPORTED_ENCODING, WEB_PAGE_TOO_LARGE, WEB_JAVASCRIPT_REQUIRED, WEB_NO_READABLE_TEXT.

Per-page failures are data in the final model request, not false successful reads. The final answer should explain them in the user's language. Authentication/JS/CAPTCHA recognition is partly heuristic; the backend does not guarantee detecting every access wall returned as HTTP 200.

## Deployment and acceptance

Base: 98f1a60 (patch 18 already applied). Apply patch, `npm ci`, run:

```bash
npm run test:web
npm run test:files
npm run test:files:integration
```

Integration runner requires FILES_TEST_MONGO_URI for the existing dedicated replica-set test database named gptiti_files_test_*. It deletes that database. Do not point it at development/user data.

No new indexes or migrations. Restart application/worker processes after successful checks. Keep OCR language models and existing file feature configuration.

Live smoke checks after deployment:
1. Ask in Ukrainian/English to summarize one public article with URL.
2. Compare 3 URLs, verify returned sources and their timestamps, reload chat.
3. Ask to save the result as TXT, verify file generation and sources.
4. Request a JavaScript shell, protected page, non-HTML URL and 4 URLs: verify explicit failures and admission limit.
5. Test an old model record and a new compatible record; webInputEnabled=false must opt out.
6. Verify reserve returns to zero and Token History has one combined debit for a completed turn.

Network guard references used during implementation:
- https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html
- https://nodejs.org/api/http.html
