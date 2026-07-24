# Agent Wallet Implementation Plan

## Goal

Delegate should evolve from an early wallet-like control plane into a real Agent Wallet system:

1. Users recharge their own cash wallet.
2. Users spend that cash balance to buy tokens for a specific Agent.
3. The Agent spends tokens while serving the user.
4. The Agent creator earns 20% of token value, first as pending earnings.
5. Creator earnings become withdrawable only after token usage or a release policy allows it.

Payment providers such as Stripe, WeChat Pay, and Alipay should only handle money movement, signatures, provider order state, webhooks, refunds, and payouts. Delegate remains the source of truth for wallet balances, Agent tokens, creator earnings, and product ledger state.

## Implementation Status (2026-07-24)

The transactional MVP described by this plan is implemented on
`codex/dashboard-optimization`:

- credits are owned by one `UserWallet × AgentWallet × currency` scope through
  `UserAgentWallet`; one visitor can never spend another visitor's purchase.
- every business operation has a `WalletTransaction` header and balanced,
  traceable `WalletLedgerEntry` movements.
- recharge, purchase, reservation, settlement, release, partial refund, and
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
  non-billable. Multi-step Compute/MCP tasks transfer that single billing
  context between runs and settle or release it exactly once at the task
  terminal state.
- retryable generation failures continue to occupy their free-reply slot during
  backoff. Free-slot decisions share the conversation advisory lock across
  channels. Editing transfers an active paid reservation to the replacement
  run; redaction cancels and releases both active and retry-backoff runs.
  Claimed generation work uses a renewable five-minute outbox lease;
  every completion and failure write is fenced by the current lease attempt,
  stale work can be reclaimed atomically, and exhausting the retry budget
  dead-letters the run and releases any wallet reservation.
- newly created representatives receive an Agent wallet atomically; paid
  representatives cannot publish with an invalid billing wallet.
- the development public flow refreshes chat balances immediately after
  purchase and lets the same audience return unreserved, unconsumed credits to
  wallet cash.
- the owner Dashboard has workspace Overview, Transactions, Settlements, and
  Ledger views with owner/billing authorization, single-currency metrics,
  filter-bound cursor pagination, trace details, creator withdrawal submission,
  and cancellation.
- non-production environments expose a private mock operations action for
  withdrawal review and settlement so the full ledger lifecycle can be
  exercised without pretending that a real payout occurred. It returns 404 in
  production.
- the migration reconstructs historical scoped balances only when legacy
  purchase, usage, creator-income, and aggregate wallet projections reconcile
  exactly. It fails before schema changes when manual reconciliation is
  required.

Still intentionally excluded from this MVP: real Stripe/WeChat/Alipay
collection, signed live webhooks, automated payout submission, chargeback
automation, FX conversion, and a generic public Wallet API. Mock recharge and
mock payment completion return 404 in production.

## Current Delegate Baseline

- `Owner.wallet` currently stores coarse credits through `Wallet.balanceCredits`, `Wallet.sponsorPoolCredit`, and `Wallet.starsBalance`.
- `Invoice` records Telegram Stars style paid plans and provider charge identifiers.
- `LedgerEntry` records representative-scoped compute/model/storage cost signals with `costCents` and `creditDelta`.
- `apps/compute-broker/src/billing.ts` already debits conversation budgets, owner credits, and sponsor pool credits when compute runs.
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
Approved withdrawal freezes or debits withdrawable earnings
External payout provider is called later
PAID/FAILED state is recorded with provider reference
```

The first version should not automatically pay out. It should create auditable manual-review withdrawal requests only.

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

The first implementation should ship `mock` provider support, then add Stripe, then add WeChat Pay and Alipay skeletons.

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
4. [x] Add mock recharge and atomic recharge-to-purchase flow.
5. [x] Keep payment providers behind adapter boundaries.
6. [x] Add user cash to representative-scoped service-credit purchase.
7. [x] Add reserve, settle, release, and FIFO usage allocation.
8. [x] Apply the configurable creator revenue policy (20% default).
9. [x] Add unconsumed-credit partial refund and reversal handling.
10. [x] Add creator withdrawal allocation and lifecycle state machine.
11. [x] Add workspace owner Dashboard wallet and billing views.
12. [x] Add public representative demo purchase and paid continuation.
13. [x] Add concurrency, idempotency, authorization, and acceptance tests.
14. [x] Close the development business loop through paid continuation,
    unused-credit return, creator withdrawal submission/cancel, and private
    mock review/settlement.
15. [ ] Reconcile production legacy data and deploy the migration.
16. [ ] Implement a real payment provider and signed webhook flow.
17. [ ] Implement reviewed payout submission and reconciliation.

## Migration Strategy

The old `Wallet` and `LedgerEntry` paths should remain live while AMN Wallet is introduced. New AMN logic should use the new wallet ledger engine. Public-conversation Compute/MCP usage is now wired to the scoped reservation flow; remaining runtime lanes can keep writing old `LedgerEntry` rows until they adopt the same reserve/settle contract.

The public service-credit bridge is now atomic:

- existing compute billing can continue reading the old owner-credit models.
- public representative purchases, usage, and reversals update the scoped
  wallet and canonical entitlement ledgers together.
- Compute authorization reads active run-scoped entitlement evidence and never
  treats legacy contact unlock fields or a client boolean as paid authority.
- production deployment must run the migration preflight against a backup and
  reconcile any rejected legacy rows before retrying.

## Acceptance Criteria

- User cash recharge is recorded through provider events and ledger entries.
- User cash can be converted into tokens for one Agent only.
- Service-credit balances are isolated per user and per Agent.
- Creator pending earnings are exactly 20% by default.
- Pending earnings are not withdrawable.
- Token usage releases earnings into withdrawable state.
- Refunds create reversal entries and do not delete old ledger rows.
- Withdrawals require claimed/verified creator state.
- Provider adapters never mutate wallet balances directly.
- Tests cover idempotency, insufficient funds, cross-user and cross-Agent
  isolation, reservation rollback, concurrent writes, partial refund,
  withdrawal guards, authorization, and cursor stability.
