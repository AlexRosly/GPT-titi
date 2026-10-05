# Token ledger and immediate balance updates

All application token writes now use `src/services/tokenLedger`: account creation's initial bonus, transfers, legacy and v2 chat charges, weekly bonus, Stripe purchases and full refunds. MongoDB remains the authority in this release. The frontend talks to authenticated REST endpoints and the existing Socket.IO connection; it never talks to MongoDB, Redis or a ledger implementation directly.

Socket.IO already carries the chat protocol and authenticates sockets into a user room. Adding SSE would introduce a second connection and an additional authentication/reconnection path. This implementation reuses Socket.IO and adds a dedicated Redis Pub/Sub channel for balance invalidations only. It does not change chat event routing or install a global Socket.IO adapter.

## Contract

`TokenLedger` exposes `getBalance`, `getOperation`, `transfer`, `credit`, `debit`, `claimBonus`, `refund`, and `createAccount`. Token amounts are integer application units; `credit` and `debit` take `amount`, `userId`, `kind` and a stable `key` when the caller can be retried. Mongo callers may pass their existing `session` so payment/transfer/chat records commit atomically with the token journal. Call `notifyCommitted()` after an externally owned transaction commits; independently owned ledger transactions do this themselves. An outbox poll also recovers writes if the process stops before that call.

`GET /gpt-titi/api/users/balance` (frontend suffix `/users/balance`) returns only the authenticated account:

```json
{ "userId": "account-id", "appTokens": 10000, "balanceVersion": 1, "nextClaimDate": null }
```

Responses use `Cache-Control: no-store`. Older accounts without `balanceVersion` read as version 0; their first ledger mutation creates version 1. No balance backfill is needed. Transfers additionally return an operation `{ id, kind, status, source, transactionHash }` and the sender's versioned receipt. A replay receipt describes the original operation and can be older than the current balance. Always use control GET to recover current state; never assign a historical receipt over a newer version.

`GET /users/token-operations/:operationId` returns an operation only to a participant, including that participant's historical balance. It does not expose the other participant's balance. Operation status accepts `pending`, `confirmed`, `failed`. Mongo operations commit as `confirmed`; an unsuccessful Mongo transaction leaves neither a debit nor a confirmed operation. This release does not submit blockchain transactions or persist blockchain pending/failed operations.

`balance.updated` is an invalidation:

```json
{ "userId": "account-id", "balanceVersion": 2, "operationId": "operation-id", "reason": "transfer" }
```

The event tells the frontend to reread GET; it does not carry an amount to add/subtract. Redux stores an account ID and monotonic version and discards stale or foreign snapshots. One GET queue combines simultaneous notifications and performs a trailing read when a new notification arrives during a GET. Chat history and chat completion receipts trigger GET rather than replacing today's balance with a historical balance. The send modal uses this same Redux balance.

The frontend subscribes before initial GET and refreshes on socket connect/reconnect, browser focus, visibility and online recovery. It performs repair GET once a minute while visible/online, or every 15 seconds while the socket is unavailable. Socket.IO retries are no longer exhausted after three failures. Redis subscriber recovery sends `balance.sync` to locally connected browsers. Pub/Sub is at-most-once ([Redis documentation](https://redis.io/docs/latest/develop/pubsub/)); reconnect and repair GET recover missed events.

## Deployment

1. Use a MongoDB replica set/Atlas cluster, as existing transfers and chat v2 already require. The ledger extends this requirement to every token writer. Run `npm ci` in the backend checkout and `npm run db:indexes:token-ledger` with that application's `MONGO_URI` loaded. The command creates indexes without changing balances or dropping other indexes.
2. For the observed dev deployment with **one backend process**, set `BALANCE_EVENTS_TRANSPORT=local`. No Redis setup or global PM2/nginx change is needed. Other applications on the shared dev server are outside this change.
3. For multiple backend processes/hosts, set all GPTiti processes to:

   ```dotenv
   BALANCE_EVENTS_TRANSPORT=redis
   REDIS_URL=redis://127.0.0.1:6379
   BALANCE_EVENTS_NAMESPACE=gptiti:prod
   ```

   Use the actual private Redis URL/credentials in deployment secrets. Every process of this application/environment must share the MongoDB and namespace. Dev must use a different namespace, e.g. `gptiti:dev`. Redis Pub/Sub namespaces are channel names and are **not** isolated by Redis database numbers. Startup fails on invalid mode or missing/unreachable required Redis rather than silently running a multi-process deployment in local mode.
4. Deploy/restart **only this backend application** using its actual PM2/service name. Do not restart all PM2 applications on the shared host. Backend must be deployed before the frontend: the frontend requires the new balance endpoint. Existing frontend remains compatible with the extended transfer response, but does not gain recipient updates until it is replaced.
5. Build/deploy the matching frontend, preserving the real `NEXT_PUBLIC_BACKEND_API_URL`, `NEXT_PUBLIC_GOOGLE_CLIENT_ID`, `NEXT_PUBLIC_SOCKET_URL` and `NEXT_PUBLIC_SOCKET_PATH`. This change adds no frontend environment variables. No automated merge or server deployment is part of this patch.

Production load balancer configuration has not been inspected. Redis distribution does not remove Socket.IO's sticky-session requirement when HTTP long-polling is enabled. Either keep socket polling requests on the same backend, or configure both client and server for WebSocket-only transport after verifying production proxies support it. Preserve websocket Upgrade forwarding and proxy idle timeouts above the heartbeat window. This release leaves existing transports and nginx configuration unchanged.

Each server runs an outbox worker. A leased MongoDB row can be picked by one worker, with retries after publication failure. It is marked delivered only after local emit/Redis publication succeeds. Crashes can cause duplicate invalidations; GET and versions make that safe. Monitor the oldest undelivered `balanceOutbox` row, retry counts and Redis connectivity. Choose a retention policy for delivered outbox records; keep the operation journal according to accounting requirements. GET remains available if Redis fails after startup; sender/recipient repair reads recover while outbox retries continue. In local mode, only one backend process may claim messages.

## Validation

Use an explicit **test** replica-set URI and an isolated Redis instance. Tests create/drop only randomly named test databases; they never fall back to the application's `MONGO_URI`.

```bash
TOKEN_TRANSFER_TEST_MONGO_URI="$TEST_REPLICA_SET_URI" \
CHAT_V2_TEST_MONGO_URI="$TEST_REPLICA_SET_URI" \
BALANCE_SYNC_TEST_REDIS_URL="$ISOLATED_TEST_REDIS_URL" \
JWT_SECRET=test-secret OPENAI_API_KEY=test-unused STRIPE_SECRET_KEY=test-unused npm test
```

Without explicit test URIs the integration cases skip. The Redis test reconnects only subscriber clients whose randomly generated test namespace matches; it never kills unrelated Redis clients. It verifies sender and recipient tabs, separate backend instances, namespace isolation, unauthorized sockets, transaction rollback, concurrent bonus/topup retries, concurrent chat/transfer and outbox retry after transport failure. HTTP tests check balance ownership, operation privacy and `no-store`.

On dev, sign in as A and B in separate browser profiles; keep a second B tab open. Send A → B, confirm A's and both B tabs' balances update without reload, and leave B's send modal open during another incoming transfer. Repeat after a disconnected tab reconnects; reload/login must reread balance. Verify a lost response/retry keeps the same transfer ID, and simultaneous chat completion cannot revert a new balance. These browser checks still need to run on the actual deployment.

## Blockchain migration boundary

The facade and public event/GET names are the seam; changing only a `require()` will not implement blockchain accounting. A future adapter must enqueue a durable submission intent in the local transaction, return a `pending` operation and current confirmed balances, then submit using an idempotent worker. Never submit an external blockchain transaction inside a MongoDB callback that may be retried. The frontend already renders pending settlement separately and polls the authenticated operation endpoint while the receipt is open.

Define the network, custody/account-to-wallet mapping, nonce management, gas payer, token units and confirmation policy before adding the adapter. Existing application balances can be negative for chat, and full refunds are clipped at -1000; these semantics cannot be assumed to match a token contract. Blockchain base-unit integers may exceed JavaScript's safe integer range: use `bigint`/decimal strings internally and an explicit conversion at this API boundary, or version the amount representation.

The chain watcher must apply confirmed/finalized state and operation transitions to the local read projection and enqueue balance invalidations atomically. It must persist a scan cursor, deduplicate chain logs, handle reorganizations and rebuild the projection from chain state. A correction/reorg still increments the local `balanceVersion`; do not reuse an older version or use block height as the frontend version. `pending`, `latest` and `finalized` RPC block tags are distinct from these three application operation statuses ([Ethereum JSON-RPC documentation](https://ethereum.org/en/developers/docs/apis/json-rpc/)). The chosen policy decides when an operation becomes `confirmed`.

The current Mongo journal covers writes introduced by this release. It is not a complete history of balances that existed before deployment. Migrating existing balances requires an audited opening checkpoint and reconciliation with the initial on-chain allocation. Once the chain is authoritative, MongoDB is a rebuildable projection; its balance must never be updated independently of confirmed chain state.
