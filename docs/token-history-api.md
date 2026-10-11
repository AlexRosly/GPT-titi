# Token history API

Base path: `/gpt-titi/api`. All three new routes require the existing Bearer JWT auth middleware, read only the authenticated account's confirmed `TokenOperation` entries, and set `Cache-Control: no-store`. Query errors are HTTP 400 `{ code: "INVALID_HISTORY_QUERY", message }`; missing/invalid auth is 401; internal failures return a generic 500 without leaking database errors.

## Storage and compatibility

Apply the financial-context change first (`docs/token-history-storage.md`). No new dependency or balance migration is required. Install the new index using `npm run db:indexes:token-ledger` on the existing replica-set/Atlas MongoDB.

The journal is the only source for history amounts. A Payment and a topup are not two separate purchases. A copied/forked ChatMessage is not a new charge. Each debit is the already calculated and rounded TITI cost of input + output together. Do not add provider input/output counts or recalculate today's model prices.

Old ledger entries are resolved through stable v2 turn IDs, Stripe keys, and TokenTransfer.operation. Unknown legacy charge metadata is returned as `null` with `detailsAvailable: false`; its actual debit is retained in totals. No date-based matching, invented model names, or automatic import of pre-ledger activity is performed. Old purchases remain available through `/billing/payments`; a future historical import must reconcile and deduplicate them explicitly.

Existing `/users/usage/summary` and `/users/usage/history` now aggregate journal debits instead of mutable/copied chat messages. They retain their existing response shapes (the summary adds source/coverage fields). This intentionally excludes pre-ledger messages; unknown provider token/USD metadata contributes no inferred value, while exact TITI debits are still counted under a null model. `/usage/history?days=7` retains a rolling seven-day default and validates days 1..366; timeZone/from/to can also be supplied. Other payment, balance, claim, transfer, chat and realtime contracts remain unchanged.

## Shared filters

- `timeZone`: IANA zone; default `UTC`. The frontend must send `Intl.DateTimeFormat().resolvedOptions().timeZone` for the same local dates it displays. DST boundaries use the actual local day, including 23/25-hour days.
- `from`, `to`: optional inclusive `YYYY-MM-DD` dates, year >=1970. Each may be supplied independently. Inverted or impossible dates are rejected.
- `day`: optional single date that overrides from/to.
- `type`: `all` (default), `purchase`, `received`, `sent`, `bonus`, `usage`, `refund`, `adjustment`; `nonusage` is also supported for General day continuation.
- `mode`: `general` (default) or `detailed`.
- `cursor`: opaque keyset continuation; must be reused with the same account, mode, type, dates and zone. Invalid/mismatched cursors return 400. Cursors do not freeze new incoming operations; refresh from the first page after a committed operation.

Amounts are signed integers in TITI: positive incoming, negative outgoing. `balanceAfter` and `balanceVersion` are historical receipts and must NEVER replace Redux's current account balance.

## GET /users/token-history

Example: `/users/token-history?mode=general&timeZone=Europe%2FKyiv&from=2026-10-10&to=2026-10-11&limit=7`.

General mode paginates whole days (default 7, maximum 14), descending. Each day contains non-usage operations and a complete model-usage summary, without loading all model charge details:

```json
{
  "mode": "general",
  "timeZone": "Europe/Kyiv",
  "days": [{
    "day": "2026-10-11",
    "operationCount": 20,
    "activity": [],
    "nextActivityCursor": null,
    "activityQuery": { "mode": "detailed", "type": "nonusage", "from": "2026-10-11", "to": "2026-10-11", "timeZone": "Europe/Kyiv", "limit": "100" },
    "usage": { "amount": -12720, "chargeCount": 16, "modelCount": 7, "unknownModelCharges": 0 }
  }],
  "nextCursor": null
}
```

`activity` contains up to 100 non-usage records per day (the empty array above only abbreviates the example). If a busy day has more, `nextActivityCursor` is non-null: fetch `/users/token-history` using that day's exact `activityQuery` plus the cursor, then append `items` into the existing day. Do not replace the day/list or drop other operations. `operationCount` and `usage` always describe the complete filtered day, regardless of these limits. The page-level `nextCursor` fetches older days. With type=usage, activity is empty and usage remains the full matching daily summary; with a non-usage type, usage is null.

Detailed mode paginates individual operations (default 50, maximum 100), descending by `(createdAt, _id)` so equal timestamps neither duplicate nor skip rows:

```json
{
  "mode": "detailed",
  "timeZone": "Europe/Kyiv",
  "items": [{
    "id": "507f1f77bcf86cd799439011",
    "type": "purchase",
    "kind": "topup",
    "at": "2026-10-11T10:42:00.000Z",
    "day": "2026-10-11",
    "amount": 250000,
    "balanceAfter": 506161,
    "balanceVersion": 12,
    "status": "confirmed",
    "model": null,
    "conversationId": null,
    "chat": null,
    "peer": null,
    "payment": { "id": "507f191e810c19729de860ea", "amountMinor": 200, "currency": "usd" },
    "bonusReason": null,
    "detailsAvailable": true
  }],
  "nextCursor": null
}
```

Values above are illustrative. Payment currency is the original actual currency; amountMinor is its Stripe minor-unit amount. Do not assume all currencies divide by 100. Unknown currency/amount is null, never `$0.00`. Never expose raw Stripe events or payment credentials. A sent/received row returns the relevant peer email, not the other user's balance. Registration and weekly bonuses use bonusReason `registration` / `weekly`. Refunds are explicit signed journal effects; their token delta is not inferred from the original purchase amount. Unknown future financial kinds map to adjustment and still contribute to period totals.

## GET /users/token-history/summary

Example: `/users/token-history/summary?timeZone=Europe%2FKyiv&from=2026-10-10&to=2026-10-11`.

```json
{
  "incoming": 556000,
  "outgoing": -68384,
  "netChange": 487616,
  "operationCount": 40,
  "from": "2026-10-10",
  "to": "2026-10-11",
  "timeZone": "Europe/Kyiv",
  "coverage": { "source": "token-ledger", "firstRecordedAt": "2026-10-01T10:00:00.000Z", "includesPreLedgerHistory": false }
}
```

These are full-period totals, independent of activity-type filtering or page limits. An empty period returns zeros. `coverage.firstRecordedAt` is the first journal operation for this account, not a guarantee of complete activity before that date; it is null if the account has no journal records. Current balance and bonus eligibility remain `/users/balance`, independent of historical totals and coverage.

## GET /users/token-history/days/:day/charges

Example: `/users/token-history/days/2026-10-11/charges?timeZone=Europe%2FKyiv&limit=50`.

Returns the Detailed response shape with only usage for that local day; limit defaults to 50, maximum 100. Reuse nextCursor on the same route/zone until null. Load and append these rows beneath that day's Model usage summary. Close details is a frontend collapse action and makes no financial mutation or change to global filters. Multiple expanded days retain independent cursors/state.

## Frontend handoff

Replace fixtures with these reads and remove Switch preview. Preserve the main account balance synchronization. Use General day responses for the initial list and the day charges route for inline expansion. Fetch summary separately with the date range/time zone; changing activity type must not replace period totals. Implement loading, retry, empty and partial-metadata states; reset pagination when filters change and ignore stale responses. Refresh history/summary after existing committed claim, transfer or topup/balance updates. Use the existing real claim/transfer APIs; read eligibility from the server. Add refund/adjustment row labels and styles. Only provide a chat link for a real accessible conversation; missing/archived/deleted conversations must not remove their financial history.

## Verification

`npm run test:token-history` runs query validation plus integration tests. Integration requires an explicit isolated replica-set URI in `TOKEN_HISTORY_TEST_MONGO_URI`; it creates/drops only a randomly named `token_history_test_*` database. Without that variable, integration is skipped. Never supply the production database URI for tests. Existing billing/transfer/v2 regression suites must also pass. No real OpenAI, Stripe, Google, email or payment action is performed by the history tests.
