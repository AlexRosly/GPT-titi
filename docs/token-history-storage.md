# Token history: financial operation context

Each new confirmed `TokenOperation` can carry an immutable, typed `context` snapshot. Token amounts continue to come exclusively from the current user's `entries[].delta`; the balance and `balanceVersion` in that entry describe the historical receipt, not today's balance.

- Chat charges: model ID, conversation ID and title, message ID (legacy) or turn ID (v2), input/output/total provider tokens, and actual USD cost. The TITI debit remains one combined input + output charge. Provider token counts are not TITI amounts.
- Card purchases and refunds: payment ID, paid amount in the currency's minor unit and the original currency. Stripe IDs and raw webhook events are not display data.
- Transfers: server-read sender/recipient email snapshots. A history response must choose only the current user's receipt and the relevant counterparty email, never return all entries or the other participant's balance.
- Weekly and registration bonuses keep their existing distinct operation kinds.

`context` is additive and optional for existing documents. Stable financial keys and existing transaction/idempotency behavior remain intact. No balances are recalculated or migrated.

Legacy `/chat/stream` and conversation regeneration now pass the assistant message ID and conversation to billing. `chat-message:<messageId>` is the stable charge key. The token mutation, operation/outbox creation, and message billing metadata update commit in the same Mongo transaction; a metadata write failure rolls back the debit. The assistant's text is still created before billing, as in the existing flow. API routes always supply the message ID; direct old internal callers without an ID remain supported.

Chat v2 already commits its message and ledger atomically. Its charge now also snapshots the conversation/model context in that existing transaction. No second debit is introduced.

The index `{ "entries.user": 1, status: 1, createdAt: -1, _id: -1 }` supports confirmed account history and stable chronological ordering. Create it using the existing `npm run db:indexes:token-ledger` command after applying this change. This requires the existing MongoDB replica set/Atlas transaction setup.

Historical coverage: this change cannot reconstruct operations before Token Ledger was deployed. It does not invent old weekly bonuses or infer old charges from dates. Existing old v2/Stripe/transfer ledger entries can be enriched by unambiguous references when read; unlinked old charges retain their exact TITI debit but may have an unknown model/chat. Old payments still exist in `/billing/payments`, but must not be silently mixed into journal totals without a separately audited historical import.
