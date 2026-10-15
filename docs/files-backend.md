# Private files — backend patches 1–3

Base: AlexRosly/GPT-titi main 1878da2006ad0434b508ab507f01da49277fd0a6.
No frontend changes. No model catalogue migration. No changes to context selection (20 messages), reservation formulas, pricing or token ledger implementation.

## Architecture

`ManagedFile` holds owner and canonical metadata; `FileChunk` stores bytes in 256 KiB chunks; `FileQuota` accounts for bytes/count. Metadata, chunks and quota writes share a MongoDB transaction. Generated results join the existing message/billing completion transaction. No filesystem or Cloudinary public URL is used for NEW private files. This uses the existing Mongo replica set without new infrastructure. Include all three collections in backups. It increases database/backup usage; `services/files/store.js` is the boundary for a future object-store adapter. It is NOT GridFS and does not rely on GridFS transaction support.

The legacy FileModels schema is not migrated: the active legacy Cloudinary upload never wrote those records. Historical Cloudinary URLs and `/uploads` remain as before. This patch does NOT retrospectively privatize them. Migration of historical bytes needs a separate inventory and verified ownership mapping.

## Configuration

```
PRIVATE_FILES_ENABLED=false
FILES_MAX_BYTES=26214400
FILES_USER_BYTES=262144000
FILES_USER_COUNT=500
FILE_OUTPUT_MODELS=
```

The switch defaults to false. New file routes return 404 while disabled, existing `/upload` keeps the old implementation. When true, `/upload` POST delegates to the private upload path; new V2 attachments must reference owned private file IDs. Frontend must fetch private downloads/previews with Authorization. An ordinary public `<img src>` is insufficient. Enable only after frontend integration and development verification.

`FILE_OUTPUT_MODELS` is an explicit comma-separated allowlist of already enabled model IDs verified to support Chat Completions function calls. No model is automatically added. File generation is enabled only for requests with `outputFile`. Plain text chats are unchanged. Test provider compatibility in development before adding a model to the allowlist.

Limits: 25 MiB maximum single upload; at most 10 attachments, 25 MiB combined in one new turn; 512 KiB generated UTF-8 content; 250 MiB/500 files per user by default. Memory uploads and bounded downloads are used. HTTP file routes have a per-user 120/min limiter (per process; existing deployment is one process). These are configurable operating defaults, not provider guarantees.

Ready unattached uploads expire in 24h. Binding a supported upload to a message clears expiry in the acceptance transaction. Generated files do not expire automatically. Hourly cleanup processes up to 100 expired items per run. Explicit deletion removes chunks and refunds quota transactionally; the metadata tombstone remains to prevent replay resurrection.

## API for later frontend work

All paths have prefix `/gpt-titi/api`. Same bearer token as existing API. Active account required.

- `POST /files` or `POST /upload`: multipart field `file`; response 201 `{success:true,file}`.
- `GET /files?limit=20&before=<id>`: owner-only page and `{quota:{bytes,count,maxBytes,maxCount}}`.
- `GET /files/:id`: current metadata, including deleted tombstones.
- `GET /files/:id/download`: owner-only attachment download, octet-stream, no-store, nosniff.
- `GET /files/:id/preview`: raster/static SVG image bytes with CSP, or JSON `{kind:'text',text,truncated,mimetype}` (64 KiB text preview), or `{kind:'unavailable'}`. Never insert text/HTML/code as DOM markup. Use textContent/code renderer; render SVG as an image blob, not innerHTML.
- `DELETE /files/:id`: 204, repeat is safe; another user's ID returns 404.

`file` fields: `fileId`, `id`, `originalName`, `mimetype`, `size`, `source`, `status`, `version`, `expiresAt`, `url`, `downloadUrl`, `previewUrl`. URLs are stable backend routes, not public signed URLs. No bytes/base64 in history DTOs.

Upload admission checks filenames, UTF-8 for text and signatures for PNG/JPEG/WEBP/PDF/ZIP containers. ZIP/Office containers are opaque downloads in this phase, NOT parsed/virus-scanned and NOT promised as a complete format validator. Audio transcription endpoint is unchanged.

### V2 input

```
{
  "protocolVersion": 2,
  "event": "chat:send",
  "type": "request",
  "payload": {
    "clientMessageId": "a UUID v4",
    "conversationId": "a Mongo ObjectId",
    "modelId": "an enabled model ID",
    "message": "Describe this image",
    "files": [{"fileId": "an owned upload ID"}]
  }
}
```

Client file MIME/URL/size is never trusted in private mode. Resolve canonical metadata in the same transaction as message acceptance. Only PNG/JPEG/WEBP can currently enter model input. PDFs, text and Office are stored/downloadable but return `DOCUMENT_PROCESSING_NOT_ENABLED` when attached to a new turn. Implementing document model input belongs to the next phase; no silent skipping or new document inference charges.

Private images are loaded by the worker and passed as data URLs. Deleted historical private images become an explicit unavailable-image marker, so the remaining conversation can continue. Existing 20-message context selection remains unchanged.

### V2 output

Add `"outputFile":{"filename":"diagram.svg"}` to the normal send payload. Supported extensions: txt, md, csv, tsv, json, svg and the allowlisted text/code extensions in `validation.js`. No automatic code-block extraction; no arbitrary extensions, paths or executables.

The worker forces a single `create_file` function with `{content,summary}`. Tool arguments are accumulated internally and are not streamed as chat text. The existing turn status indicates processing. There is no extra provider request to render or save the file. Provider usage includes tool argument tokens; the existing reserve estimator remains unchanged. Keep feature disabled in production until the separate reserve/cost rollout is approved.

The complete provider result is durably stored before finalization. Rendering, file record/chunks, quota, assistant message and existing charge settle together. An expired worker with a persisted result uses recovery without another provider request. `chat:end`, `chat:status` and HTTP history include:

```
"attachments": [{"fileId":"...","storage":"private","status":"ready","downloadUrl":"...","previewUrl":"..."}],
"fileResult": {"status":"ready","filename":"diagram.svg","fileId":"...","error":null}
```

On invalid content or exhausted file quota, the turn completes with `fileResult.status='failed'`, an error code and no download link. Provider token usage is still settled because generation occurred. Transient DB errors leave providerResult recoverable. A semantic/validation failure is not automatically regenerated; a new generation request is a new paid turn. Downloads and status refresh never invoke the model.

`outputFile` participates in the idempotency hash. Same clientMessageId with another filename conflicts. Stable result key is `turnId:attempt:0`. Frontend should upsert cards by fileId and treat snapshot/history as authoritative after reconnect. After explicit deletion, hydrated history/status returns deleted metadata and null URLs.

CSV/TSV parser preserves quoted cells/newlines and neutralizes potential spreadsheet formulas with an apostrophe, except plain numeric negatives. This intentionally changes dangerous formula-like text. JSON must parse. SVG is parsed and reconstructed with a static allowlist: no script, foreignObject, animation, style, external URLs, DTD, entities or processing instructions. Unsafe SVG fails instead of silently stripping meaningful content. Code is stored as text and never executed.

## Lifecycle integration

Clear-conversation now writes the actual `deleted` schema field, then removes private files only if no nondeleted message references them. Fork copies attachment references. Explicit file deletion deletes the shared owner file everywhere, not merely one card. Archiving does not delete files. Version is 1 in this release: editing/version branching is a later feature.

## Deployment and verification

1. Back up code and MongoDB. Record server git HEAD and local changes. The production server may include patches not committed to this base: do not overwrite them.
2. Apply patches 01, 02, 03 sequentially; use `git apply --check` before each. On conflict, reconcile the affected files, never force overwrite.
3. `npm ci`
4. `npm run db:indexes:files` with the normal intended environment (`MONGO_URI`). Create indexes before enabling the feature. Do not use syncIndexes.
5. `npm run test:files`
6. Set `FILES_TEST_MONGO_URI` to a dedicated development replica-set database named `gptiti_files_test_<suffix>`; run `npm run test:files:integration`. Tests DROP that dedicated database. They never fall back to MONGO_URI. Do not use production.
7. Run existing `npm run test:chat-v2:dod` and `npm run test:reservations` against their isolated development configuration.
8. Verify one actual supported model in development, including invalid SVG and quota failure, download with owner/another account, reconnect and worker restart. Verify backup/restore includes file chunks.
9. Keep PRIVATE_FILES_ENABLED=false on production until frontend Authorization/blob handling and cost rollout are ready. Restart PM2 using the existing deployment process; no extra process is needed.

Rollback before enabling: disable flags and revert code in reverse patch order. After private files are used, simply disabling the switch also hides file endpoints; prefer disabling new output models while retaining read APIs until a migration is arranged. Do not drop collections. A code rollback must account for already queued outputFile turns and existing private image references: drain workers first.

## Verification actually performed in the preparation environment

Unit/protocol tests were run locally. Mongo-backed storage/HTTP/worker tests are supplied but could not run: local mongod exits with `open: Operation not permitted`. They are NOT counted as passed. No production API keys or production database were used; no live OpenAI inference was performed. Development integration tests are a deployment gate, not an optional check.
