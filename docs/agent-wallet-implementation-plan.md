# Agent Wallet Implementation Plan

## Goal

Delegate should evolve from an early wallet-like control plane into a real
Wallet & Billing system:

1. A user buys a one-time service package for one specific Digital
   Representative.
2. Payment directly grants representative-scoped service credits; there is no
   second customer cash-wallet purchase.
3. The representative consumes those credits while serving the user.
4. The Creator earns the price-version revenue-share snapshot, first as pending
   earnings. The current provisional default is Creator 20% / platform gross
   80%.
5. Creator earnings become withdrawable only after credit usage releases them.

The authoritative V1 product rules are in
`docs/wallet-billing-product-contract.md`; the funds-flow decision is in
`docs/adr-wallet-billing-funds-flow.md`. References below to recharge or
`USER_CASH` describe legacy model names and same-transaction internal clearing,
not a customer-facing cash wallet.

Payment providers such as Stripe, WeChat Pay, and Alipay should only handle money movement, signatures, provider order state, webhooks, refunds, and payouts. Delegate remains the source of truth for wallet balances, Agent tokens, creator earnings, and product ledger state.

## Implementation Status (2026-07-29)

The transactional MVP described by this plan is implemented on
`codex/dashboard-optimization`:

- credits are owned by one `UserWallet × AgentWallet × currency` scope through
  `UserAgentWallet`; one visitor can never spend another visitor's purchase.
- every business operation has a `WalletTransaction` header and balanced,
  traceable `WalletLedgerEntry` movements.
- payment, purchase, reservation, settlement, release, full-unused refund, and
  withdrawal state transitions run at Serializable isolation with conflict
  retry and parameter-checked idempotency.
- service-credit lots are consumed FIFO through `AgentUsageAllocation`, and
  withdrawals freeze exact creator-earning lots through
  `WithdrawalAllocation`.
- public conversation acceptance atomically chooses a free slot or reserves a
  paid service credit in both `UserAgentWallet` and the canonical
  `ServiceEntitlement` account. Completion settles both; non-billable and
  terminal failure paths release both. Purchase grants and unused-credit
  reversal retracts both projections in the same transaction. Any parity
  mismatch fails closed before a balance-dependent mutation. Balance reads use
  one Serializable snapshot, and low-level wallet-only usage mutations are not
  exported from the package root.
- Compute ignores client-supplied paid-entitlement flags. The broker grants a
  run-scoped capability only after revalidating an active server-owned
  GenerationRun and one of three explicit authorities: a persisted free slot,
  a wallet reservation with a matching entitlement RESERVE, or an active plan
  entitlement reservation. Legacy unlock flags are not authorization.
  Blocked, failed, over-budget, and policy-rejected results are explicitly
  non-billable. MCP-only answers are explicitly no-charge: planning releases
  any provisional reservation, the no-charge marker transfers across MCP
  steps, and terminal completion increments neither purchased units nor free
  replies. Mixed MCP + non-MCP tasks retain the non-MCP billing context and
  settle or release it exactly once at the task terminal state.
- retryable generation failures continue to occupy their free-reply slot during
  backoff. Free-slot decisions share the conversation advisory lock across
  channels. Editing transfers an active paid reservation to the replacement
  run; redaction cancels and releases both active and retry-backoff runs.
  Claimed generation work uses a renewable five-minute outbox lease;
  every completion and failure write is fenced by the current lease attempt,
  stale work can be reclaimed atomically, and exhausting the retry budget
  dead-letters the run and releases any wallet reservation.
- newly created representatives receive an Agent wallet plus three active CNY
  service packages atomically; paid representatives cannot publish without a
  valid billing wallet and at least one active CNY product/price version.
- `BillingProduct` is the stable product identity and
  `BillingPriceVersion` freezes immutable price, included units, Creator/platform
  share, refund, and expiry terms. Public checkout submits only a price-version
  ID. `RechargeOrder` snapshots those terms before contacting the provider, and
  fulfillment does not reload mutable `AgentWallet` price/share fields.
- the development public flow refreshes representative-scoped credits
  immediately after purchase and lets the same audience reverse a wholly
  unused package. Internal cash clearing is omitted from public responses.
- the owner Dashboard has workspace Overview, Transactions, Settlements, and
  Ledger views with owner/billing authorization, single-currency metrics,
  filter-bound cursor pagination, trace details, creator withdrawal submission,
  and cancellation.
- each representative has an Owner-facing service-package manager under
  Pricing/Billing. Owners create stable products, edit display metadata,
  publish immutable CNY price versions with revision-safe compare-and-swap,
  and archive products without rewriting historical orders.
- verified Owners/Organizations have a payout profile and tokenized WeChat Pay
  destination model. Provider recipient tokens are encrypted with a dedicated
  key and never returned; withdrawal creation requires an active CNY
  destination and freezes a complete masked destination snapshot before
  earnings move to frozen.
- local development exposes payout-profile review and destination activation
  only to close the test loop. Production exposes neither creator self-review
  nor payout execution; a separate Operator RBAC and maker/checker workflow is
  still required.
- non-production environments expose a private mock operations action for
  withdrawal review and settlement so the full ledger lifecycle can be
  exercised without pretending that a real payout occurred. It returns 404 in
  production.
- the migration reconstructs historical scoped balances only when legacy
  purchase, usage, creator-income, and aggregate wallet projections reconcile
  exactly. It fails before schema changes when manual reconciliation is
  required.
- validated PostgreSQL checks reject negative cash and earning buckets,
  inconsistent usage terminal amounts, and incomplete paid-withdrawal facts.
  A disposable PostgreSQL 16 gate now exercises duplicate recharge, concurrent
  cash spending, last-credit reservation, settle-versus-release, and
  withdrawal-freeze races against the real schema. Creator balance summaries
  use an uncapped database aggregate rather than a limited relation sample.
- WeChat Pay API v3 Native collection is implemented behind two explicit,
  default-off server flags. `DELEGATE_WECHAT_PAY_COLLECTION_ENABLED` controls
  only new Native orders, while
  `DELEGATE_WECHAT_PAY_PROCESSING_ENABLED` keeps callbacks, queries, refund
  recovery, and ledger reversal running for existing money. Collection without
  processing is rejected at startup. Before its first provider POST, the server
  atomically persists a `CREATED` order, exact replayable Native request facts,
  and durable reconciliation Outbox work. Recovery queries the same
  `out_trade_no` first and replays the exact request only after a signed
  not-found response. A locally expired QR remains reconcilable; a pending
  provider order with a lost QR is canceled only after a minimum delay and a
  successful signed provider close. The server verifies every API response and
  callback before parsing, decrypts successful payment notifications, and
  recovers missed callbacks through a signed merchant-order query. Callback
  and query confirmations share one provider-transaction idempotency key and
  one atomic
  recharge-to-representative-credit transaction. A PostgreSQL operation gate
  prevents parallel checkout creation across web replicas without storing raw
  audience identifiers; the shared Outbox lease prevents parallel query
  fan-out. Public responses omit wallet identities and provider payloads.
- Every `CREATED` or pending WeChat order owns one durable
  `wechat_pay.order.reconcile` Outbox item. The workflow runner claims it with
  a fenced lease and bounded backoff; the principal-scoped browser status route
  shares the same item and cannot multiply upstream queries.
- The authenticated owner billing dashboard can submit one exact full refund
  for a paid WeChat purchase whose credits are wholly unused and unreserved and
  whose creator proceeds remain pending. Delegate persists an idempotent refund
  intent, freezes the entitlement, and enqueues lifecycle work before the first
  provider request. The first claimant durably changes `QUEUED` to `UNKNOWN`
  before sending the POST. Every crash, timeout, transport failure, non-success
  response, or unverifiable response therefore resumes by querying the
  original `out_refund_no`. After a verified `RESOURCE_NOT_EXISTS`, Delegate
  either replays the exact request or terminalizes only a retained, allowlisted
  deterministic rejection; unknown codes remain frozen. `PROCESSING` queries
  follow a bounded one-minute then 5/10/20/30-minute schedule.
- Signed refund submission/query responses persist `PROCESSING`, `SUCCESS`,
  `CLOSED`, and `ABNORMAL` provider facts. Terminal `SUCCESS`, `CLOSED`, and
  `ABNORMAL` callbacks are accepted at
  `/api/payments/wechat/refund-notify`; the callback persists an immutable
  external fact before responding. If no local order can yet be matched, it
  returns a retryable failure after the fact is durable so provider delivery
  can resolve the binding later; matching facts for the same refund also bind
  earlier unmatched events. A closed refund restores eligibility only when the
  signed provider lifecycle makes that safe; abnormal, unmatched, overdue, and
  unsafe work remains frozen as a persistent reconciliation exception. A
  successful refund enqueues `wechat_pay.refund.apply`; its local reversal is
  append-only and idempotent.
- The workflow runner executes order reconciliation, refund lifecycle, and
  refund reversal as three independently tracked lanes with durable heartbeat,
  success, stable failure-code, and redacted scalar-summary checkpoints.
  `Promise.allSettled` isolation lets healthy lanes continue when another lane
  fails. `/health` remains liveness, `/ready` covers startup/runtime
  dependencies, and `/operations/wechat-pay/health` always returns a redacted
  operational `healthy`, `degraded`, or `critical` snapshot. Idle backoff ticks
  do not clear failures; readiness rehydrates persistent checkpoint and
  per-lane `FAILED` backlog state so restarts, replicas, and unrelated
  successful items cannot hide unresolved work.
- The owner Dashboard exposes one private Owner-scoped exception queue across
  every representative owned by that Owner. The `rep` query selects a
  billing-authorized workspace anchor; it does not filter the queue to that
  representative. Only cases whose recharge/refund chain proves Owner
  ownership are included. Claim, exact bound-Outbox retry, and acknowledge are
  version-checked, idempotent, and audit-recorded; these actions never edit
  wallet balances. Claim is allowed only from `OPEN`; retry and acknowledge
  require the case to be `CLAIMED` by the current Owner, and acknowledge
  requires a note. Unmatched provider facts remain platform-only alerts.

Still intentionally excluded from this MVP: enabling a live WeChat merchant
before its canary passes, partial provider refunds, chargeback automation, real
Stripe/Alipay collection, automated payout submission, FX conversion, and a
generic public Wallet API. Mock recharge and mock payment completion return 404
in production. WeChat collection must remain disabled until the database gates
and the live merchant smoke test pass. Stripe remains deferred; no Stripe test
account is required for this phase.

## Current Delegate Baseline

- `Owner.wallet` retains only historical Stars balance; the coarse Compute-credit balances have been retired.
- `Invoice` records Telegram Stars style paid plans and provider charge identifiers.
- `LedgerEntry` records representative-scoped compute/model/storage cost signals in `costCents`.
- `apps/compute-broker/src/billing.ts` records internal execution cost without exposing or debiting Compute credits.
- Dashboard views already surface wallet-like signals and compute ledger entries.

These pieces should be reused, but they are not enough for AMN because they do not separate user cash, Agent token balances, creator pending earnings, creator withdrawable earnings, provider costs, platform revenue, refunds, and payout state.

## Target Account Model

The MVP should introduce explicit wallet account types:

- `USER_CASH`: spendable cash balance owned by a user.
- `SERVICE_CREDIT_DEFERRED`: purchased service credits scoped to one user and
  one Agent, with available and reserved projections.
- `CREATOR_PENDING`: creator revenue share that is not withdrawable yet.
- `CREATOR_WITHDRAWABLE`: creator revenue share eligible for a withdrawal request.
- `CREATOR_FROZEN`: creator earnings reserved by an active withdrawal.
- `PLATFORM_DEFERRED_REVENUE`: the platform share before service fulfillment.
- `PLATFORM_EARNED_REVENUE`: the platform share recognized after fulfillment.
- `PROVIDER_COST`: model, compute, payment channel, and infrastructure costs.
- `EXTERNAL_SETTLEMENT` and `PAYOUT_CLEARING`: provider cash and payout
  clearing counterparts used to keep fiat movements balanced.

Amounts must be stored as integers:

- fiat money in the smallest unit, such as cents or fen.
- tokens in integer units.
- percentages as basis points, where 20% is `2000`.

No wallet logic should use floating point money.

## Required Data Model

New AMN wallet models should be added alongside existing models first, then old wallet paths can be migrated gradually:

- `UserWallet`: cash balance projection/cache for one user identity.
- `AgentWallet`: aggregate service-credit projection and pricing policy for one
  representative.
- `UserAgentWallet`: spendable and reserved service-credit projection for one
  user, one representative, and one currency.
- `WalletTransaction`: immutable business-event header with source,
  idempotency, status, owner, representative, user, and event time.
- `WalletLedgerEntry`: append-only AMN ledger entries with account type, amount, token amount, currency, idempotency key, and event grouping.
- `RechargeOrder`: one user recharge attempt created before payment.
- `PaymentProviderEvent`: raw normalized webhook/provider event with a unique provider event id.
- `AgentTokenPurchase`: user cash converted into tokens for one Agent.
- `AgentUsageCharge`: token consumption event for model, compute, browser, MCP, or fixed task usage.
- `AgentUsageAllocation`: FIFO link from one usage settlement to the purchase
  lots it consumed.
- `CreatorEarning`: pending and withdrawable creator revenue for an Agent.
- `WithdrawRequest`: manual-review payout request for creator earnings.
- `WithdrawalAllocation`: exact creator-earning lots frozen, released, or paid
  by a withdrawal request.

Existing `Wallet`, `Invoice`, and `LedgerEntry` should remain until old dashboard and compute paths are explicitly migrated. The first implementation should avoid breaking current owner dashboard and compute billing behavior.

## Ledger Rules

Wallet state must be append-only:

- business actions create one or more `WalletLedgerEntry` rows inside one database transaction.
- balance fields are projections/caches, not the only truth.
- every externally triggered action must have an idempotency key.
- repeated provider webhooks must not create duplicate ledger movement.
- reversals must be new ledger entries, never deletion or mutation of old entries.
- a transfer must either complete all entries or no entries.

The engine should reject:

- negative purchase amounts.
- negative token purchase quantities.
- unsupported currencies.
- spending from an account without enough projected balance.
- creator withdrawals above withdrawable balance.

## Main Money And Token Flows

### User Recharge

```text
User creates RechargeOrder
Payment adapter creates provider payment
Provider confirms through webhook
PaymentProviderEvent is stored
WalletLedgerEntry credits USER_CASH
UserWallet projection increases
```

Provider adapters must normalize provider-specific events into internal events such as `RechargePaid`, `RechargeFailed`, and `Refunded`.

### Buy Agent Tokens

```text
UserWallet USER_CASH decreases
UserAgentWallet available service credits increase
AgentWallet aggregate service credits increase
AgentTokenPurchase records price and token quantity
CreatorEarning pending increases by purchase amount * revenue share
WalletLedgerEntry records all movements atomically
```

Default creator revenue share is 20%, represented as `2000` basis points. The percentage should be configurable per Agent later.

### Agent Token Consumption

```text
Request acceptance reserves UserAgentWallet service credits
The same transaction reserves canonical ServiceEntitlement units
Agent service runs
Completion settles only the actual reserved amount
UserAgentWallet, AgentWallet, and ServiceEntitlement projections decrease
Provider/platform costs are recorded
Creator pending earnings are released proportionally
Creator withdrawable earnings increase
```

Non-billable completion, cancellation, rejection, and terminal failure release
the reservation. Editing transfers it to the replacement run. Redaction also
terminates a retryable failed run and releases its reservation; other retryable
failures retain it. Existing owner compute-budget behavior remains compatible
during migration.

Time-limited generic grants are not part of this MVP. Before adding them, persist
the original expiry in the entitlement ledger and include it in idempotent
replay validation.

### Refund And Reversal

```text
Provider refund/chargeback arrives
PaymentProviderEvent is stored idempotently
Unspent Agent tokens are reversed when possible
Consumed tokens become platform loss or creator earning freeze
Creator pending/withdrawable entries are reversed or frozen
Reversal ledger entries preserve the full audit trail
```

The system must never delete historical ledger rows.

### Creator Withdrawal

```text
Creator requests withdrawal
System verifies creator identity and Agent claim state
WithdrawRequest enters PENDING_REVIEW
Approval freezes withdrawable earnings

Current local-only mock:
PENDING_REVIEW → PAID | FAILED

Required production execution:
APPROVED → persist idempotent ATTEMPT_CREATED
         → submit provider request
         → PROCESSING
         → PAID | FAILED | RECONCILIATION_REQUIRED
```

The current version does not automatically pay out. It creates auditable
manual-review requests and permits settlement only through a non-production
mock. Production must persist the attempt before provider I/O. Creator
cancellation is allowed only before the first provider submission; after
submission or an uncertain response it stays closed, and reconciliation must
resolve the existing attempt before any retry.

## Payment Provider Boundary

Payment adapters should expose a common interface:

- `createPayment`
- `verifyWebhook`
- `normalizeWebhook`

They must not write wallet balances directly.

Recommended provider reuse:

- Stripe: official `stripe` SDK for PaymentIntents or Checkout Sessions, webhook signature verification, and later Connect payouts.
- WeChat Pay: official API v3 SDK/signature tooling for order creation, notification verification, certificate handling, and merchant transfer support later.
- Alipay: official OpenAPI SDK for order creation, async notify verification, refund notifications, and transfer support later.

The first implementation ships `mock` provider support. WeChat Pay API v3
Native collection is now the first real adapter: it signs exact request bytes,
verifies exact response/callback bytes, supports public-key rotation, renders
the provider `code_url` locally as a QR code, and uses signed order queries as
a callback recovery path. The same signed boundary submits eligible full
refunds and queries unknown or processing refund outcomes by their original
merchant refund number. Stripe is intentionally deferred, and Alipay remains a
fail-closed skeleton.

One underlying provider transaction creates exactly one financial event and
one set of ledger movements. If callback and order-query evidence both arrive,
the first verified evidence is retained as the canonical financial fact; the
later confirmation is treated as an idempotent replay. This minimizes retained
provider data and deliberately does not promise offline re-verification of
every later confirmation.

## Product Surfaces

### Public Representative Page

The Agent page should show:

- which Agent receives token purchases.
- token package options.
- service description and pricing.
- balance-insufficient prompt.
- recharge or buy-token entry.

The page must not imply that a user balance is generic platform credit if it is being converted into Agent-specific tokens.

### Owner Dashboard

The creator dashboard should show:

- Agent token balance.
- total token purchases.
- total token consumption.
- pending creator earnings.
- withdrawable creator earnings.
- provider costs.
- platform revenue.
- recent wallet ledger activity.
- withdrawal request state.

All values should come from ledger projection rather than static mock data.

## Implementation Steps

1. [x] Add this implementation plan and keep it aligned with the schema work.
2. [x] Add wallet transaction, scoped balance, allocation, and migration models.
3. [x] Implement the append-only wallet ledger engine and projections.
4. [x] Add mock payment and atomic service-package fulfillment.
5. [x] Keep payment providers behind adapter boundaries.
6. [x] Keep cash as same-transaction internal clearing while granting
   representative-scoped service credits directly.
7. [x] Add reserve, settle, release, and FIFO usage allocation.
8. [x] Apply the configurable creator revenue policy (20% default).
9. [x] Add V1 full-unused refund and reversal handling; keep legacy partial
   reversal outside the public V1 contract.
10. [x] Add creator withdrawal allocation and lifecycle state machine.
11. [x] Add workspace owner Dashboard wallet and billing views.
12. [x] Add public representative demo purchase and paid continuation.
13. [x] Add concurrency, idempotency, authorization, and acceptance tests.
14. [x] Close the development business loop through paid continuation,
    unused-credit return, creator withdrawal submission/cancel, and private
    mock review/settlement. The public service-package panel now restores the
    current representative-scoped credit state after a reload, and withdrawal writes
    fail closed when reconciliation reports real balance errors.
15. [ ] Reconcile production legacy data and deploy the migration.
16. [x] Implement default-off WeChat Pay API v3 Native order creation, response
    and callback verification, AES-GCM notification decryption, local QR
    rendering, principal-scoped status polling, signed active query recovery,
    provider-transaction idempotency, and atomic service-credit purchase.
17. [x] Add the production-shaped WeChat operations safety boundary:
    PostgreSQL-backed distributed create/query throttling, durable
    `wechat_pay.order.reconcile` queries, persisted full-refund intent and
    entitlement freeze, `wechat_pay.refund.reconcile` submission/query
    recovery, `/api/payments/wechat/refund-notify`, and durable
    `wechat_pay.refund.apply` reversal processing. Every uncertain refund POST
    becomes `UNKNOWN` and queries the original `out_refund_no` before an exact
    request replay. Success, closed, processing, and abnormal provider outcomes
    are retained as immutable facts; unmatched facts remain a platform
    operations alert. Exact full refunds of wholly unused credits reverse
    automatically; every unsafe or ambiguous successful refund stays frozen
    for reconciliation. Run order reconciliation, refund lifecycle, and refund
    reversal as three `Promise.allSettled` lanes with durable checkpoints,
    redacted operations health, and an owner-scoped, audited exception queue.
18. [ ] Pass the live WeChat merchant smoke test and release checklist. This
    requires a Native Pay-enabled merchant account bound to the AppID, merchant
    API certificate serial and private key, API v3 key, WeChat Pay public key
    ID/key, the prior platform certificate while gray migration is active,
    public HTTPS payment and refund notification URLs, a real payer WeChat
    account, and merchant-console/API permission to issue a refundable test
    order. Verify payment callback and missed-callback query recovery, then
    issue one full unused refund and confirm its Outbox reversal. First enable
    processing with collection off and verify readiness/recovery, then enable
    collection only for the ¥5 canary. Do not open general traffic until these
    checks and `pnpm test:postgres:wallet` pass.
19. [x] Add Owner service-package management with immutable version publication,
    optimistic revision checks, idempotency, audit records, and archival.
20. [x] Add Owner/Organization payout profiles, encrypted tokenized WeChat Pay
    destinations, local-only review/activation, withdrawal gating, and
    immutable destination snapshots.
21. [ ] Add production Operator RBAC, maker/checker payout approval, real
    provider submission, proof, and payout reconciliation. Creator accounts
    must never be allowed to approve their own payout. Acceptance for this item
    also requires:
    - an idempotent provider-attempt record created before provider I/O;
    - `PROCESSING` and `RECONCILIATION_REQUIRED` handling that prohibits
      Creator cancellation and duplicate submission after provider contact;
    - a versioned credential keyring, background re-encryption, verification,
      and an old-key retirement gate;
    - a server-enforced cooling-off deadline for every newly verified
      destination, including the first;
    - distinct maker/checker Operators within the target organization;
    - immutable proof plus append-only organization audit containing actor,
      before/after state, attempt ID, and provider reference.

The disposable PostgreSQL 16 gate (`pnpm test:postgres:wallet`) covers both
contention safety and linear business scenarios: mock recharge,
service-credit purchase, reserve, settle, creator-income release, withdrawal
approval, mock payout, callback/query concurrency for one WeChat transaction,
payment-confirmation rollback and retry, idempotent replay, and a final healthy
reconciliation report. It also validates the provider-operation gate and the
refund split between automatic full-unused reversal and frozen manual
reconciliation, same-key concurrent refund creation, callback-before-submit
convergence, `UNKNOWN` query-first recovery, abnormal-state transitions, and
terminal replay quarantine. This database gate is required before enabling
collection.

### WeChat runtime configuration boundary

`.env.example` documents the split release controls, payment credentials,
separate payment/refund callbacks, and reconciliation worker timings. Compose
injects WeChat server configuration according to least privilege:

- `reps`, which creates Native orders, handles
  `/api/payments/wechat/notify` and
  `/api/payments/wechat/refund-notify`, and serves principal-scoped order
  status;
- `dashboard`, which receives only the two release flags and
  credential-free callback URL/origin values needed to authorize and freeze
  owner-initiated eligible full refunds; and
- `workflow-runner`, which performs durable order query, refund lifecycle, and
  refund reversal work.

The merchant private key, API v3 key, response-verification keys, and legacy
platform certificate are restricted to `reps` and `workflow-runner`; they are
absent from `dashboard`, bot, compute broker, conversation worker, and browser.
Both split flags must be configured together with exact lowercase `true` or
`false`. `DELEGATE_WECHAT_PAY_ENABLED` is a compatibility fallback only when
both split flags are absent. Processing may be enabled while collection is off,
but collection without processing fails closed.

The reconciliation worker defaults are a 5-second poll, batch size 10,
75-second fenced lease, 10-second pending backoff, 5-second error backoff, and
10-minute maximum backoff. `WECHAT_PAY_RECONCILIATION_LEASE_MS` must remain at
least 75 seconds so one lease always exceeds the maximum 60-second provider
request timeout plus a database-write margin. The workflow-runner `/health` endpoint is liveness only;
`/ready` checks database access, redacted local WeChat preflight, and loop
freshness. `/operations/wechat-pay/health` always returns HTTP 200 and carries
the operational result in a redacted `healthy`, `degraded`, or `critical`
body. It aggregates safe codes/counts and the three lane checkpoints; none of
these endpoints returns credentials, order/user identifiers, raw provider
payloads, provider descriptions, or exception messages.

The private owner queue is read through
`/api/dashboard/wallet/exceptions?rep=...`; claim, retry, and acknowledge write
through `/api/dashboard/wallet/exceptions/[caseId]/actions?rep=...`. The `rep`
value is a billing-authorization anchor, while reads and actions cover all
cases owned by that Owner. Every mutation uses an expected case version and an
owner-scoped idempotency key. Retry can only reset the case's exact bound
`FAILED`/`DEAD_LETTER` payment Outbox item after the current Owner has claimed
the case. Acknowledge has the same claim precondition, requires a non-sensitive
note, and does not resolve the underlying financial state. Cases resolve only
after the source operation or verified refund lifecycle recovers.

`WECHAT_PAY_NOTIFY_URL` is an optional public HTTPS payment-notification
override. When it is blank, the server derives
`/api/payments/wechat/notify` from the production
`NEXT_PUBLIC_REPRESENTATIVE_URL`; that base URL must be a credential-free
public HTTPS origin. Every outbound WeChat API request sends
`Wechatpay-Serial`, preferring `WECHAT_PAY_PUBLIC_KEY_ID`, while the
`Authorization.serial_no` field continues to use the merchant API certificate
serial number. During WeChat's public-key gray migration, configure both the
new `WECHAT_PAY_PUBLIC_KEY_ID`/`WECHAT_PAY_PUBLIC_KEY_BASE64` pair and the old
`WECHAT_PAY_PLATFORM_CERTIFICATE_SERIAL_NUMBER`/
`WECHAT_PAY_PLATFORM_CERTIFICATE_BASE64` pair. Responses and callbacks signed
by either key are accepted, but ambiguous multi-key JSON configuration fails
closed unless one outbound key is selected explicitly.

`WECHAT_PAY_REFUND_NOTIFY_URL` is independently configurable and must target
`/api/payments/wechat/refund-notify`; when omitted, it is derived from the
payment callback origin or the canonical representative origin. It is
intentionally a separate callback path rather than a second payment URL. The
owner refund API stores that exact callback URL with the frozen refund request,
so a query-first retry can replay the original request without changing any
provider parameter.

## Migration Strategy

The old `Wallet` and `LedgerEntry` paths should remain live while AMN Wallet is introduced. New AMN logic should use the new wallet ledger engine. Public-conversation Compute/MCP usage is now wired to the scoped reservation flow; remaining runtime lanes can keep writing old `LedgerEntry` rows until they adopt the same reserve/settle contract.

The public service-credit bridge is now atomic:

- Compute execution records internal cents-based costs and no longer reads the retired owner-credit model.
- public representative purchases, usage, and reversals update the scoped
  wallet and canonical entitlement ledgers together.
- Compute authorization reads active run-scoped entitlement evidence and never
  treats legacy contact unlock fields or a client boolean as paid authority.
- production deployment must run the migration preflight against a backup and
  reconcile any rejected legacy rows before retrying.
- the ownership migration rejects legacy transfer audits that used one
  `usage_entitlement_transfer:<usageId>` key for every hop. This rollout has no
  production wallet data; non-production fixtures with that format should be
  recreated rather than carried forward.
- the invariant migration must run with legacy wallet writers stopped. For a
  future rolling release, first deploy writer code that only emits
  constraint-compatible states to every instance, then run the migration, and
  only then remove transitional compatibility. Never apply the migration while
  old and new wallet writers are mixed. The migration itself holds table locks
  from preflight through validation, but those locks do not replace the
  application rollout order.

## Acceptance Criteria

- User cash recharge is recorded through provider events and ledger entries.
- User cash can be converted into tokens for one Agent only.
- Service-credit balances are isolated per user and per Agent.
- Creator pending earnings are exactly 20% by default.
- Pending earnings are not withdrawable.
- Token usage releases earnings into withdrawable state.
- Refunds create reversal entries and do not delete old ledger rows.
- Withdrawals require claimed/verified creator state.
- Before production payout, provider submission is represented by a durable
  idempotent attempt; timeout/unknown outcomes enter
  `RECONCILIATION_REQUIRED`, prohibit Creator cancellation, and cannot create a
  second provider payout.
- Before production payout, every new destination observes a server-owned
  cooling-off deadline even if a client requests `ACTIVE`.
- Before production payout, credential key rotation and re-encryption preserve
  decryptability until the old key passes its retirement gate.
- Before production payout, organization-scoped maker/checker authorization,
  immutable proof, and append-only audit are covered by integration tests.
- Provider adapters never mutate wallet balances directly.
- Tests cover idempotency, insufficient funds, cross-user and cross-Agent
  isolation, reservation rollback, concurrent writes, partial refund,
  withdrawal guards, authorization, and cursor stability.
- Public wallet reads are principal-scoped, representative-scoped,
  currency-scoped, `private, no-store`, and exclude provider payloads and
  internal identifiers.
- A blocked reconciliation report prevents new withdrawals and every payout
  lifecycle transition; warning-only legacy evidence remains operable.
- Owner exception reads and actions require billing authorization through the
  active representative, return the Owner's cross-representative queue, never
  infer ownership for unmatched provider facts, and cannot write wallet
  balances directly.
