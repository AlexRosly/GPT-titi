# XLSX T1: interrupted response — 12.11.2026

## What is confirmed

The screenshot shows a failed V2 turn with `PROCESS_INTERRUPTED` and unresolved provider usage. It does not identify the original cause or prove that an XLSX background job was created.

Current main `2d5e6ef` matches the delivered background-jobs patch. The following error-handling defects are reproducible locally:

- Responses errors between completed provider calls (including a budget refusal after inspection) can reach `failTurn`, which treats any `providerStartedAt` as uncertain and hides the original reason.
- An incomplete terminal response can include authoritative usage. The old path discards that usage and incorrectly requires reconciliation.
- A rejected follow-up request can leave the Responses checkpoint pending even though no additional usage occurred.

## Change

Confirmed terminal usage is checkpointed without executing unfinished tool arguments. Completed usage with no in-flight call produces a partial result, preserves the error code and follows existing idempotent billing. Pending/unknown usage, active background jobs, cancellation and conflicting checkpoints remain excluded from this path. No automatic provider retry is added.

Failure diagnostics retain bounded codes, HTTP status, provider request ID and phase metadata. They exclude prompts, file contents, raw exceptions, credentials and complete provider responses. `PROVIDER_REQUEST_REJECTED` identifies HTTP 400/422 without exposing provider messages.

`scripts/diagnoseDocumentTurn.js` is read-only and works against the preceding deployment as a standalone script. Run it from the backend root. It reports recent XLSX turns or a specified turn/conversation, persisted call states, model settings, background jobs and billing counts. It never changes reservations, charges users, runs a model or starts workers.

## Deployment and acceptance

First capture the old failed turn with the script. Apply this patch after `2d5e6ef`, run the documented tests and restart the backend normally. No frontend changes, dependencies, new indexes or configuration changes are required.

Do not reset the already-failed turn, release its reservation or set `noCharge` just to clear the warning. This patch does not retroactively settle that turn. Resolve it only after inspecting the saved state and, where still uncertain, provider evidence.

This patch fixes error reporting and confirmed-usage settlement. It does **not** establish or fix the primary cause of the screenshot without its diagnostic report. It does not raise token/output/budget limits, change model configuration, implement XML namespace compatibility or certify the 10,000-row live test.
