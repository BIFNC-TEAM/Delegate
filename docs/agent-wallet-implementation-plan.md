# Agent Wallet Implementation Plan

## Goal

Delegate should evolve from an early wallet-like control plane into a real Agent Wallet system:

1. Users recharge their own cash wallet.
2. Users spend that cash balance to buy tokens for a specific Agent.
3. The Agent spends tokens while serving the user.
4. The Agent creator earns 20% of token value, first as pending earnings.
5. Creator earnings become withdrawable only after token usage or a release policy allows it.

Payment providers such as Stripe, WeChat Pay, and Alipay should only handle money movement, signatures, provider order state, webhooks, refunds, and payouts. Delegate remains the source of truth for wallet balances, Agent tokens, creator earnings, and product ledger state.

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
- `AGENT_TOKEN`: token balance scoped to one Agent or Digital Representative.
- `CREATOR_PENDING`: creator revenue share that is not withdrawable yet.
- `CREATOR_WITHDRAWABLE`: creator revenue share eligible for a withdrawal request.
- `PLATFORM_REVENUE`: platform service fee and retained margin.
- `PROVIDER_COST`: model, compute, payment channel, and infrastructure costs.

Amounts must be stored as integers:

- fiat money in the smallest unit, such as cents or fen.
- tokens in integer units.
- percentages as basis points, where 20% is `2000`.

No wallet logic should use floating point money.

## Required Data Model

New AMN wallet models should be added alongside existing models first, then old wallet paths can be migrated gradually:

- `UserWallet`: cash balance projection/cache for one user identity.
- `AgentWallet`: token balance projection/cache for one representative.
- `WalletLedgerEntry`: append-only AMN ledger entries with account type, amount, token amount, currency, idempotency key, and event grouping.
- `RechargeOrder`: one user recharge attempt created before payment.
- `PaymentProviderEvent`: raw normalized webhook/provider event with a unique provider event id.
- `AgentTokenPurchase`: user cash converted into tokens for one Agent.
- `AgentUsageCharge`: token consumption event for model, compute, browser, MCP, or fixed task usage.
- `CreatorEarning`: pending and withdrawable creator revenue for an Agent.
- `WithdrawRequest`: manual-review payout request for creator earnings.

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
AgentWallet AGENT_TOKEN increases
AgentTokenPurchase records price and token quantity
CreatorEarning pending increases by purchase amount * revenue share
WalletLedgerEntry records all movements atomically
```

Default creator revenue share is 20%, represented as `2000` basis points. The percentage should be configurable per Agent later.

### Agent Token Consumption

```text
Agent service runs
Billing calculates token charge
AgentWallet AGENT_TOKEN decreases
Provider/platform costs are recorded
Creator pending earnings are released proportionally
Creator withdrawable earnings increase
```

This should later replace the current owner-credit debit path for public Agent usage, while compute owner-budget behavior remains compatible during migration.

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

1. Add this implementation plan and keep it aligned with the schema work.
2. Add wallet domain models and migrations without changing runtime behavior.
3. Implement the append-only wallet ledger engine and balance projection.
4. Add mock recharge order and mock payment success flow.
5. Add payment provider adapter boundaries.
6. Add user cash to Agent token purchase flow.
7. Add Agent token usage charge flow.
8. Extract creator revenue policy with default 20% share.
9. Add refund and reversal handling.
10. Add creator withdrawal request state machine.
11. Add owner dashboard wallet and creator revenue view.
12. Add representative page token purchase entry.
13. Add Stripe provider implementation.
14. Add WeChat Pay and Alipay provider skeletons.
15. Add end-to-end AMN Wallet acceptance tests and run final validation.

## Migration Strategy

The old `Wallet` and `LedgerEntry` paths should remain live while AMN Wallet is introduced. New AMN logic should use the new wallet ledger engine. Existing compute billing can keep writing old `LedgerEntry` rows until Agent token billing is explicitly wired into compute/model usage paths.

The bridge should be one-way at first:

- old dashboard keeps reading old owner wallet fields.
- new AMN dashboard reads new wallet projections.
- seed data can populate both worlds for demo continuity.

## Acceptance Criteria

- User cash recharge is recorded through provider events and ledger entries.
- User cash can be converted into tokens for one Agent only.
- Agent token balances are isolated per Agent.
- Creator pending earnings are exactly 20% by default.
- Pending earnings are not withdrawable.
- Token usage releases earnings into withdrawable state.
- Refunds create reversal entries and do not delete old ledger rows.
- Withdrawals require claimed/verified creator state.
- Provider adapters never mutate wallet balances directly.
- Tests cover idempotency, insufficient funds, cross-Agent isolation, refund reversal, and withdrawal guards.
