# ADR: Wallet & Billing Funds Flow

- Status: Accepted for V1 implementation; production collection remains gated
- Date: 2026-07-29
- Related contract: `docs/wallet-billing-product-contract.md`

## Context

Delegate currently has a mature CNY/WeChat money flow (`RechargeOrder`) and a
separate Telegram Stars entitlement flow (`ServicePaymentOrder`). The public
CNY flow previously accepted a browser-supplied amount and reloaded mutable
`AgentWallet` price and revenue-share settings after payment. An open checkout
could therefore be fulfilled under terms different from those shown when the
QR code was created.

The UI also exposed the internal `USER_CASH` clearing account as if it were a
customer wallet. That suggested customers could recharge general cash, buy a
second time, or move value between representatives, none of which is the V1
product.

## Decision

1. Keep `RechargeOrder` as the CNY/WeChat order. Do not add a third checkout
   order model.
2. Add `BillingProduct` as the stable representative-owned service-package
   identity and `BillingPriceVersion` as its immutable commercial version.
3. A customer selects an active price-version ID. The server, not the browser,
   supplies price, units, revenue share, refund policy, and expiry policy.
4. Freeze those terms on `RechargeOrder` before contacting WeChat Pay.
5. Fulfillment reads only the order snapshot. Mutable `AgentWallet` price/share
   fields remain a legacy fallback for historical orders without a billing
   price version.
6. The customer buys representative-scoped service entitlement in one action.
   `USER_CASH` remains a balanced, same-transaction clearing account and is not
   returned by the public wallet API.
7. V1 supports CNY, one-time packages, no expiry, and a full provider refund
   only while the purchase is wholly unused and unreserved.
8. Creator 20% / platform gross 80% is the current implementation default.
   It is a provisional business decision: production collection stays off
   until the split and Delegate collection-party role are explicitly approved.
9. Owners manage representative-scoped packages through stable product
   metadata and immutable price-version publication. Optimistic revision
   checks prevent concurrent operators from silently overwriting each other.
   Price and included units are Creator-managed, while revenue share is a
   server-owned policy snapshot and cannot be supplied by a Creator request.
10. A withdrawal requires one verified Owner/Organization payout profile and
    one active CNY WeChat Pay destination. The request freezes the destination
    identity, subject, masked label, and credential version as immutable
    snapshots. Provider recipient tokens are encrypted separately from channel
    credentials and never returned by an API.
11. Production payout persists an idempotent provider attempt before the first
    provider request. Its lifecycle is
    `ATTEMPT_CREATED → PROCESSING → PAID | FAILED |
    RECONCILIATION_REQUIRED`. After submission, or when the response is
    uncertain, Creator cancellation and a second attempt are prohibited until
    reconciliation establishes a terminal result.
12. Payout credentials use a versioned keyring. Rotation introduces a new
    active key, re-encrypts stored credentials in the background, verifies the
    result, and retires an old key only when no active destination depends on
    it.
13. Every newly verified payout destination, including the first one, passes a
    server-enforced cooling-off period before activation. Client input cannot
    shorten or bypass that period.
14. Production approval and execution require organization-scoped Operator
    authorization, distinct maker/checker principals, immutable provider proof,
    and append-only audit events containing actor, scope, before/after state,
    attempt ID, and provider reference.

## Funds and entitlement flow

```text
active BillingPriceVersion
  -> snapshotted RechargeOrder
  -> verified WeChat payment
  -> internal USER_CASH credit and immediate debit
  -> representative-scoped entitlement grant
  -> Creator pending earning + platform deferred revenue
  -> balanced AMN ledger entries

successful service use
  -> entitlement reserve
  -> entitlement settle
  -> proportional Creator pending amount becomes withdrawable

wholly unused refund
  -> freeze refund intent
  -> provider refund
  -> reverse entitlement, earning, and balanced money entries
```

## Invariants

- One active price version per product.
- Price-version commercial fields are immutable.
- V1 price versions use the canonical `credit` entitlement unit.
- Product-bound order snapshots are all-or-nothing.
- Creator and platform basis points total 10,000.
- `amountMinor % entitlementUnits == 0` in V1 so the existing integer unit-price
  ledger and full-unused refund stay exact.
- Entitlement is scoped by canonical audience identity and representative.
- Provider retries and callback/query races remain idempotent.
- Historical orders with no new snapshot fields remain readable and use the
  explicitly isolated legacy fulfillment path.
- Every new withdrawal has a complete payout-destination snapshot or fails
  before any earning is frozen.
- Payout destination replacement preserves the prior active destination until
  the replacement is verified and its cooling-off period has elapsed.
- No newly verified payout destination becomes active before its server-owned
  cooling-off deadline.
- The first provider submission permanently closes Creator cancellation for
  that withdrawal; an unknown result requires reconciliation, not a blind
  retry.
- An active destination's credential key remains available until verified
  re-encryption has moved it to a newer key version.

## Consequences

- Changing a price, entitlement quantity, split, refund rule, or expiry rule
  requires a new price version. Existing/open orders do not change.
- Bulk discounts that imply a fractional per-unit price are deferred.
- The package editor retires the active version and publishes the new version
  atomically; it never updates a published version.
- `PricingPlan` remains for its current representative/Telegram Stars contract.
  A later migration may align both payment rails to the shared product identity
  without causing one payment to create both order models.
- Production payout approval/execution is deliberately not exposed to a
  Creator. It requires a separate Operator principal, maker/checker policy,
  provider execution record, proof, organization-scoped immutable audit, and
  reconciliation.
- Automatic subscriptions remain a separate follow-up decision.
