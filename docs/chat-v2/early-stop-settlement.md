# Early Stop settlement

An initial Chat Completions request cancelled before XLSX execution previously became
`PROCESS_INTERRUPTED` and held its reservation until an operator supplied provider
usage. An interrupted stream may never deliver the final usage chunk.

This change keeps persisted user cancellation as `USER_CANCELLED`, including when
another worker observes the persisted flag without a local abort reason. It saves
valid final usage from the initial Chat Completions stream before the next flush or
tool boundary. Cancellation/recovery settles that confirmed usage transactionally
using the saved price, once, and releases the reservation. A saved final result
still takes precedence. It does not restart the model or the cancelled job.

## Explicit policy for missing usage

`CHAT_EARLY_CANCEL_UNKNOWN_USAGE_POLICY` defaults to `manual`.

- `manual`: unconfirmed costs remain held for operator review. The error honestly
  says settlement needs review. This mode alone does not fix an indefinite hold.
- `platform_covers_unknown`: for an initial Chat Completions call cancelled before
  any assistant text was delivered or tool execution started, release the hold
  with zero user charge. GPTiti absorbs the unknown provider cost. An audit record
  explicitly says `providerUsageKnown: false` and `platformCoversUnknown: true`;
  it does not assert that the provider charged zero and does not schedule a later
  debit for this waived call.

Enabling this policy is a financial decision. It is suitable for the current test
phase if GPTiti accepts that cost. No production setting is changed by this patch.
The policy does not cover already delivered output, computation/browser/Responses
continuations, malformed usage, or unrelated provider failures. Existing document
job cancellation and its known-usage accounting remain in place. The policy does
not impose a per-user quota on covered early cancellations; assess that before a
public production rollout.

## Historical attempt repair

`CHAT_RECONCILIATION_MONGO_URI` must explicitly identify the operator database.
There is no HTTP endpoint or broad balance reset.

```
node scripts/reconcileEarlyCancellation.js --plan TURN_UUID ATTEMPT > plan.json
node scripts/reconcileEarlyCancellation.js --apply plan.json --platform-covers-unknown
```

The first command is read only. The second acknowledges the platform-cost policy.
It rechecks the user, attempt, terminal cancellation, absence of output/results/jobs,
ledger hold receipts, existing charges and the plan fingerprint in a transaction.
Concurrent/repeated application cannot release twice. Other holds are preserved.
Changed evidence or a failed outbox write causes refusal/rollback. Apply only a
reviewed plan for the intended attempt. There is no automatic refund of charges.

Releasing a hold changes available/reserved tokens; it does not credit the total
balance. The balance outbox commits in the same transaction. A failed attempt stays
cancelled and is not made retryable automatically.

## Verification

- `npm run test:early-stop`
- `npm run test:early-stop:integration` with `CHAT_V2_TEST_MONGO_URI` pointing at a
  disposable Mongo replica set (the suite creates and drops its own test database).
- Existing Responses, reservation, document-job and DOCX suites.

`diagnoseDocumentTurn.js` and `scripts/diagnoseDocumentTurn.js` now report version 4,
with initial usage, resolution and the worker policy. A newly processed turn has
runtime revision `early-stop-settlement-v1`. Historical runtime evidence remains
historical; operator repair does not rewrite it.
