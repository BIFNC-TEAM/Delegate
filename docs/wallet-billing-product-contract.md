# Wallet & Billing Product Contract

Status: V1 implementation contract
Scope: CNY one-time service packages, WeChat Pay, representative-scoped
entitlements, Creator revenue, refunds, and manual payout accounting

## 1. Decision status

The following V1 rules are locked for implementation:

- A customer buys a one-time service package for one specific digital
  representative. The product is not an automatic subscription.
- Payment immediately grants representative-scoped service entitlement. The
  customer does not recharge a reusable cash wallet and then buy again.
- Entitlement does not expire in V1.
- A provider refund is a full refund and is allowed only while every unit from
  the purchase remains unused and unreserved. Partial-used and partial-amount
  refunds are outside V1.
- CNY is the only public checkout and Creator settlement currency in V1.
- `BillingProduct` is the stable product identity.
  `BillingPriceVersion` is an immutable commercial version.
- `RechargeOrder` freezes the product, price version, entitlement, revenue
  split, refund, and expiry terms used at checkout.

The following rules are provisional business assumptions and require explicit
business, finance, legal, and tax confirmation before production collection is
enabled:

- Delegate is the unified V1 collection party.
- Creator gross revenue share is 20% and platform gross share is 80%.
  `creatorRevenueShareBps = 2000` and
  `platformRevenueShareBps = 8000`.

These provisional defaults may be used to build and test the closed loop, but
the production collection switch must remain disabled until they are signed
off and a live payment/refund canary passes. If the intended rule is “platform
fee 20%,” the split must be changed by publishing new price versions before
production; historical orders and versions must never be rewritten.

## 2. Product language and actor boundaries

### Customer

The customer-facing action is “购买服务包” (buy service package). The customer
sees:

- representative and package name;
- CNY price;
- included service units;
- permanent-validity statement;
- full-refund-when-unused statement;
- order and refund status.

The customer does not see an internal `USER_CASH` clearing balance, cannot
transfer entitlement across representatives, and does not bind a bank card in
Delegate.

### Creator

The Creator sees pending, withdrawable, frozen, and paid earnings. A payout
destination belongs to the verified Owner or Organization payee, not to the
customer and not to an individual `RechargeOrder`.

Creator payout profiles belong to the verified Owner or Organization payee.
Delegate stores only an encrypted provider/vault recipient token plus masked
display data, never a raw card number, payment password, or complete identity
document. Local development may exercise mock review and activation; production
review and payout execution remain unavailable until an independent Operator
RBAC and maker/checker workflow is deployed. Production also requires a
versioned credential keyring, online key rotation and re-encryption, and a
retirement gate that prevents removing a key while any active destination still
depends on it.

### Platform

Delegate receives provider events, grants entitlement, keeps the balanced AMN
ledger, releases earnings on service use, processes eligible refunds, and
reconciles provider and internal records. Provider payment fees, tax, invoice
party, and refund-fee allocation remain explicit finance/legal decisions; the
80% value above is a gross platform share, not a promise of net revenue.

## 3. Sources of truth

| Concern | Authority | Rule |
| --- | --- | --- |
| Product identity | `BillingProduct` | Stable code per representative; archive, do not repurpose |
| Commercial terms | `BillingPriceVersion` | Create a new version for any price, units, split, refund, or expiry change |
| Checkout contract | `RechargeOrder` snapshots | Never reload mutable wallet/product configuration during fulfillment |
| Customer service units | `ServiceEntitlementAccount` and its ledger | Scoped to audience + representative + entitlement product code |
| Money and revenue | AMN wallet transactions and ledger | Every movement remains balanced and idempotent |
| Creator earning lots | `CreatorEarning` | Pending → withdrawable as purchased service is consumed |
| Provider outcome | verified provider events/query | Does not replace the internal ledger or reconciliation state |

Legacy `Wallet`, `Invoice`, and `LedgerEntry` models are not extended for this
flow. `PricingPlan` and `ServicePaymentOrder` remain in place for their current
Telegram Stars/channel use; this iteration does not add a third checkout order
model.

## 4. Product and price-version contract

`BillingProduct` owns:

- representative;
- stable product code;
- name and description;
- lifecycle: `DRAFT`, `ACTIVE`, `ARCHIVED`.

`BillingPriceVersion` owns:

- monotonically increasing version number within the product;
- lifecycle: `DRAFT`, `ACTIVE`, `RETIRED`;
- `currency = CNY`;
- positive integer `amountMinor`;
- `unitName = credit` and positive integer entitlement units;
- Creator and platform revenue shares in basis points;
- `FULL_WHEN_UNUSED` refund policy;
- `NEVER_EXPIRES` expiry policy and a null validity-days value;
- publication and retirement timestamps.

At most one price version may be active per product. Public checkout resolves
only an active product with an active price version. Commercial fields are
immutable after insert, and lifecycle only moves
`DRAFT → ACTIVE → RETIRED`. A price change creates a new version and retires
the old one in one transaction.

Owners manage these packages under the representative's Pricing/Billing
configuration. Draft creation, metadata edits, version publication, and
archival use optimistic revisions and idempotency keys. A published price is
never edited in place, and a package cannot be silently moved to another
representative. The Creator may choose package price and included units, but
the revenue-share policy is server-owned and read-only in the Creator
Dashboard. Until Operator policy management exists, publishing snapshots the
representative's existing platform-controlled policy; a Creator cannot raise
their own share through the product API.

The existing token ledger records an integer `tokenUnitPriceCents`. Therefore
V1 requires:

```text
amountMinor > 0
entitlementUnits > 0
amountMinor % entitlementUnits == 0
tokenUnitPriceCents = amountMinor / entitlementUnits
```

Discounts or package shapes that produce a fractional unit price are not
supported in V1. This restriction keeps usage allocation, full-unused refund,
and reversal ledger entries exact. Additional units such as sessions require a
different entitlement product code and are outside V1.

## 5. Checkout and fulfillment contract

The browser submits only `billingPriceVersionId` plus audience/session and
idempotency context. It must not submit an authoritative amount, entitlement
quantity, revenue split, refund policy, or expiry policy.

The server resolves the active price version for the requested representative
and creates a `RechargeOrder` with:

- `billingProductId` and `billingPriceVersionId`;
- existing `amountCents` and `currency`;
- product-name and unit-name snapshots;
- entitlement-units snapshot;
- Creator and platform revenue-share snapshots;
- refund-policy and expiry-policy snapshots;
- null entitlement-validity-days snapshot in V1.

All new product-bound order snapshots are all-or-nothing. Existing historical
orders remain compatible with null product/version/snapshot fields.

Payment completion must use only the order snapshot:

```text
select active price version on server
→ create snapshotted RechargeOrder
→ create WeChat checkout
→ verify callback or authoritative provider query
→ mark order paid idempotently
→ credit and immediately clear internal customer cash
→ grant representative-scoped service entitlement
→ create Creator pending earning and platform deferred revenue
→ write balanced ledger entries
```

The transient customer cash entries are internal settlement mechanics. They
are not a customer product, cannot be withdrawn or transferred, and must not
be presented as “站内余额”.

## 6. Revenue release

The provisional gross split is frozen on the order and purchase. Changing a
representative's current share cannot change an open or paid order.

```text
paid purchase
→ Creator share enters pending
→ service units are reserved
→ successful service use settles units FIFO
→ proportional Creator amount becomes withdrawable
→ failed/canceled service releases the reservation without revenue release
```

Rounding and final-lot remainder behavior stays in the existing earning-lot
allocation logic. The price-version precision rule prevents fractional token
values from entering that path.

## 7. Refund contract

An eligible V1 refund requires all of the following:

- order is paid and provider transaction identity is known;
- refund amount equals the original order amount;
- all entitlement units granted by the purchase are still available;
- none of those units is reserved or consumed;
- no Creator earning from the purchase has become withdrawable, frozen, or
  paid;
- request, provider submission, callback/query, and reversal are idempotent.

The provider refund outcome and local reversal remain separate states. A
provider-successful refund that cannot be reversed safely is routed to
reconciliation; it is never silently treated as a completed internal reversal.

## 8. State machines

```text
Product:       DRAFT → ACTIVE → ARCHIVED
Price version: DRAFT → ACTIVE → RETIRED
Order:         CREATED → REQUIRES_PAYMENT → PAID
                  ├→ FAILED
                  ├→ CANCELED
                  └→ REFUNDED
Earning:       PENDING → WITHDRAWABLE → FROZEN → PAID
                                └──────────────→ WITHDRAWABLE (failed payout)
Payout profile:
               PENDING_VERIFICATION → VERIFIED
                         ├→ REJECTED
                         └→ SUSPENDED
Payout destination:
               PENDING_VERIFICATION → VERIFIED → COOLING_OFF → ACTIVE
                         ├→ REJECTED                       ├→ DISABLED
                         └─────────────────────────────────└→ REPLACED
Production payout attempt:
               APPROVED → ATTEMPT_CREATED → PROCESSING → PAID
                                                   ├────→ FAILED
                                                   └────→ RECONCILIATION_REQUIRED
```

Existing provider refund and reconciliation sub-states remain authoritative
for retry, abnormal, and reversal-required handling. `COOLING_OFF` and the
production payout-attempt states are production requirements, not capabilities
of the current local-only payout mock. A payout attempt is persisted before
the first provider request. Once that request is submitted, or its outcome is
unknown, Creator cancellation and a second provider attempt are prohibited
until reconciliation establishes a terminal result.

## 9. Deployment and production gate

The schema migration may create active default ¥5, ¥20, and ¥100 service
packages for each existing CNY `AgentWallet` only when:

- token unit price is positive;
- package amount divides exactly by the token unit price;
- revenue-share basis points are valid.

No historical order is rewritten. If a wallet cannot produce an exact package,
that tier is skipped and must be configured explicitly later.

Production collection remains off until all of the following are complete:

1. Delegate collection-party and 20/80 split assumptions are signed off.
2. Public HTTPS payment and refund notification URLs are deployed.
3. WeChat keys/public-key or platform-certificate verification is ready.
4. A real ¥5 payment grants exactly one entitlement lot and one earning lot.
5. Replayed callback/query paths remain idempotent.
6. The wholly unused order completes a full provider refund and local reversal.
7. Provider, order, entitlement, earnings, and ledger records reconcile.

Production payout remains off until all of the following are complete:

1. A provider-attempt record and the `PROCESSING` /
   `RECONCILIATION_REQUIRED` state machine prevent duplicate payout after
   timeout or an unknown response.
2. Creator cancellation closes before the first provider submission and cannot
   be reopened by a client request.
3. A versioned credential keyring supports rotation, re-encryption, retirement
   checks, and alerts for unreadable credentials.
4. Every newly verified destination passes a server-enforced cooling-off
   period before activation; client state cannot bypass it.
5. Organization-scoped Operator RBAC enforces distinct maker and checker
   principals and writes append-only audit events.
6. Every completed payout retains a masked destination snapshot, immutable
   provider reference, proof, and reconciliation result.

## 10. Scope

### P0 in this iteration

- stable products and immutable price versions;
- Owner service-package editor with revision-safe version publication;
- complete CNY commercial snapshot on `RechargeOrder`;
- server-authoritative package selection;
- snapshot-based fulfillment;
- customer language changed from recharge/cash balance to service packages;
- fake wallet amounts removed or clearly marked as samples;
- Owner/Organization payout profile and encrypted tokenized WeChat destination;
- verified active destination gate and immutable masked snapshot on withdrawal;
- local-only payout profile review/activation for closed-loop testing;
- automated schema, route, fulfillment, refund, and idempotency tests.

### P1 production operations

- production operator RBAC and maker/checker approval;
- production WeChat recipient-token acquisition and verification integration;
- provider-attempt persistence, uncertain-result reconciliation, and
  post-submission cancellation lock;
- credential keyring rotation, re-encryption, and retirement controls;
- server-enforced destination cooling-off;
- organization-scoped append-only payout audit;
- CNY manual payout proof, external reference, and reconciliation;
- provider fee and settlement-bill ingestion.

### Not V1

- customer bank-card binding;
- cross-representative cash balance or entitlement transfer;
- partial-used or partial-amount refunds;
- automatic payout;
- automatic subscription renewal;
- expiry/rollover;
- discounts with fractional unit price;
- multi-currency or foreign exchange;
- Stripe integration.
