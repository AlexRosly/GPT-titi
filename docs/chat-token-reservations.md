# Chat reservations and retiring legacy generation

## Runtime behavior

V2 admission uses the existing estimateTokens(message) + estimateCost algorithm.
It does not yet price full history or reserve a maximum response budget. An
accepted request holds that many TITI on User.reservedAppTokens, records the hold
and price snapshot on ChatTurn, and creates its user message in ONE transaction.
Available = appTokens - reservedAppTokens. No new model request is sent unless
the hold succeeds. Transfers atomically check available tokens too. Old accounts
without the new fields are treated as having zero held tokens; no backfill needed.

New requests/retries below -1000 return BALANCE_LIMIT_EXCEEDED. At exactly -1000,
or any other balance, the full estimate must fit available tokens or admission
returns INSUFFICIENT_BALANCE. Errors include details.balance, availableTokens and
estimatedTokens, all in TITI, matching frontend PR #198. Duplicate delivery of
an already accepted request returns its existing turn without another hold,
even if the account subsequently becomes negative.

A completed request charges the full usage exactly once and closes its own hold
in the same transaction as the answer and completed state. This can take the
balance below -1000; it never clips the cost and never releases other holds.
Other already accepted requests may finish and deepen the negative balance.
Top-ups continue to add to the total balance, naturally paying the debt first.
The accepted price snapshot allows settlement if a model is later disabled.
Provider usage is used when supplied; the existing estimated-usage fallback for
a cleanly completed stream without usage remains (it is not exact billing).

Failed calls known not to have run release the hold. Retry rechecks balance and
reserves again. Before the provider call, providerStartedAt is persisted. A
completed provider result is durably saved before billing so an expired worker
can finish billing without calling the provider twice. OpenAI SDK automatic
retries are disabled to avoid another billable call after an ambiguous failure.

An interrupted call whose usage is unknown becomes failed/nonretryable with
needsReconciliation=true and KEEPS its hold. It must not silently become free.
Inspect these turns operationally. After checking provider evidence, an operator
can run scripts/reconcileChatReservation.js with CHAT_RECONCILIATION_MONGO_URI
and a JSON file containing turnId, attempt, reason and exactly one of:
- noCharge: true, only when absence of a charge has been established;
- usage: {prompt_tokens, completion_tokens, total_tokens}, confirmed usage.
The script records the resolution, settles/releases once, and never regenerates.
No user-facing reconciliation endpoint is exposed. Confirmed charged failed
attempts require a new request; only a confirmed no-charge failure can be retried.

## Legacy routes

HTTP POST /chat/stream and the conversation regenerate route return 410
CHAT_V2_REQUIRED. The old Socket.IO listener is removed; V1 envelopes are
rejected by the V2 validator. Dormant legacy generation modules are retirement
stubs, preventing accidental re-registration. History, chat CRUD, preview and
V2 remain. Current frontend main uses V2 and has no HTTP stream/regenerate calls.

## Worker and rollout

Every launch now goes through one scheduler; Socket.IO only wakes it. Overlapping
wake-ups cannot exceed CHAT_V2_WORKERS (default 4) IN ONE PROCESS. Admission also
limits queued/processing turns per user via CHAT_V2_MAX_PENDING_PER_USER (default
4). The user limit is serialized by the account write in the reservation transaction.

Deploy with ONE backend process for now. This PR does not add cross-process chat
stream delivery or a cluster-wide worker semaphore. Do not increase PM2 instances
on the assumption that this PR solves those separate infrastructure concerns.

Before deployment, stop new admissions at the proxy, wait for active/queued turns
to drain, then replace/restart the backend and reopen traffic. Do not mix old and
new backend versions: old transfers and generators do not understand holds.
Existing queued turns without holds fail safely before a provider call and can
be retried under the new rules. Existing interrupted provider calls require review.
Keep the existing chat-v2 and token-ledger unique indexes installed. MongoDB must
support transactions (replica set/Atlas), as already required by the ledger.

## Validation

npm test runs local unit checks; integration suites require an isolated test
replica set via CHAT_V2_TEST_MONGO_URI (and TOKEN_TRANSFER_TEST_MONGO_URI). The
Billing reservations GitHub Actions workflow starts its own mongo:7 replica set,
uses dummy provider credentials and runs the suites without real AI requests.
New coverage includes simultaneous reservations, duplicate sends at zero
availability, transfers against holds, overdraft settlement, threshold boundaries,
failure/retry, ambiguous crash reconciliation, durable-result recovery and rollback.
