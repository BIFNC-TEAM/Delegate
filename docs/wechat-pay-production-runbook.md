# WeChat Pay production runbook

This runbook is the release gate for Delegate Native WeChat Pay collection,
payment recovery, and full-refund recovery. It intentionally contains no
credential values, payer identifiers, or raw provider payloads.

## Verification boundary

The repository can prove schema validity, type safety, signature and callback
fixtures, idempotency, concurrency, recovery ordering, and ledger invariants.
Those checks do **not** prove that a real merchant is bound to the configured
AppID, that the deployed HTTPS callbacks are reachable from WeChat, that the
merchant has refund permission, or that a real payer can complete the flow.

The live ¥5 payment-and-full-refund canary in this runbook has not been
performed merely because the code and offline/PostgreSQL gates pass. Record it
as complete only after observing the real provider and ledger evidence listed
below in the deployed environment.

## Financial invariants

- New collection and existing-money processing are separate release controls.
- Collection must never be enabled while processing is disabled.
- Turning off collection must not stop payment callbacks, refund callbacks,
  signed order queries, signed refund queries, or local ledger reversals.
- Before the first Native order request leaves Delegate, one `CREATED` order,
  its exact replayable provider request facts, and one
  `wechat_pay.order.reconcile` Outbox item commit atomically. A crash or
  uncertain response is recovered by querying the original `out_trade_no`;
  only a signed not-found result permits an exact create replay.
- Browser QR expiry is a presentation boundary, not proof that the provider
  order failed. Delegate continues signed reconciliation and honors one late,
  verified `SUCCESS`. When a pending order has lost its `code_url`, Delegate
  waits at least five minutes and requires a successful signed provider close
  before marking it canceled and permitting a replacement.
- A refund intent is persisted and its service entitlement is frozen before
  any provider request leaves Delegate. The lifecycle moves from `QUEUED` to
  durable `UNKNOWN` before the first refund POST, so every crash or uncertain
  result restarts with a signed query of the original `out_refund_no`.
- A timeout, transport failure, or unverifiable response is an unknown outcome,
  never proof that a payment or refund failed.
- Refund retries always reuse the original `out_refund_no`, amount, transaction,
  reason, and callback URL.
- A documented deterministic refund rejection restores eligibility only after
  a later signed query proves that the original refund does not exist. Unknown
  provider rejection codes remain frozen and query-first.
- A successful refund-submission HTTP response means the provider accepted the
  request; only a verified callback or signed query supplies the final refund
  outcome.
- Provider responses and callbacks are signature-verified before their facts
  are merged. A late signed API `PROCESSING` fact cannot downgrade `SUCCESS`.
- Local reversal is idempotent and only automatic for one full, undiscounted,
  unused, unreserved purchase whose creator earnings remain pending.
- No operator action writes balances directly. Every correction must be an
  append-only compensating ledger operation and must pass funds reconciliation.

## Required runtime configuration

Prefer the base64 variants for multiline PEM values. Never expose any
credential through a `NEXT_PUBLIC_*` variable or browser response. Apply
least privilege per service:

- the representative service and workflow runner receive the complete merchant
  signing, API v3 decryption, response-verification, callback, and split-release
  configuration below;
- the owner Dashboard receives only both split-release flags and the
  credential-free callback URL/origin values needed to freeze an exact refund
  request; it must not receive the merchant private key, API v3 key, WeChat Pay
  public key, legacy platform certificate, or verification-key JSON; and
- no WeChat Pay configuration is injected into the bot, browser, conversation
  worker, or compute broker.

```dotenv
DELEGATE_WECHAT_PAY_PROCESSING_ENABLED=true
DELEGATE_WECHAT_PAY_COLLECTION_ENABLED=false

WECHAT_PAY_APP_ID=
WECHAT_PAY_MERCHANT_ID=
WECHAT_PAY_MERCHANT_CERTIFICATE_SERIAL_NUMBER=
WECHAT_PAY_MERCHANT_PRIVATE_KEY_BASE64=
WECHAT_PAY_API_V3_KEY=

WECHAT_PAY_PUBLIC_KEY_ID=
WECHAT_PAY_PUBLIC_KEY_BASE64=

# Keep this legacy pair until callback migration is confirmed at 100%.
WECHAT_PAY_PLATFORM_CERTIFICATE_SERIAL_NUMBER=
WECHAT_PAY_PLATFORM_CERTIFICATE_BASE64=

NEXT_PUBLIC_REPRESENTATIVE_URL=https://representative.example.com
WECHAT_PAY_NOTIFY_URL=https://representative.example.com/api/payments/wechat/notify
WECHAT_PAY_REFUND_NOTIFY_URL=https://representative.example.com/api/payments/wechat/refund-notify
```

Both split flags must be configured together and must be exactly lowercase
`true` or `false`; a partial pair or spelling such as `TRUE` fails readiness.
`DELEGATE_WECHAT_PAY_ENABLED` is a temporary compatibility fallback only when
both split flags are absent. New deployments must set both explicit flags.

The two callback URLs must be public HTTPS URLs with no credentials, query
string, fragment, private hostname, or IP literal. The application can derive
both callback paths from a public `NEXT_PUBLIC_REPRESENTATIVE_URL` origin, but
explicit values are preferred in production. Each callback URL is limited to
256 UTF-8 bytes. An optional refund reason is limited to 80 UTF-8 bytes; the
Dashboard and provider boundary both enforce the byte limit.

During the WeChat Pay public-key migration, configure both the new public key
and the legacy platform certificate. Remove the legacy certificate only after
the merchant console reports 100% callback and response migration and a
post-migration canary has succeeded. Local startup/readiness preflight cannot
read the merchant console's gray-migration percentage, so a green `/ready`
response does not waive this manual release gate.

The live canary additionally requires:

- a Native Pay-enabled merchant bound to the configured AppID;
- a deployed representative origin whose two callback paths are reachable over
  public HTTPS;
- merchant-console or API permission to submit a full refund;
- access to redacted application, worker, database, and merchant-console
  evidence; and
- a dedicated Delegate audience account plus a real payer WeChat account.

No Stripe account or Stripe credential is needed for this release gate.

## Public-key response probe

Before enabling collection, run one mutation-free request against WeChat Pay's
official `/v3/security/echo` endpoint:

```bash
pnpm wechat:public-key:probe
```

The command loads `.env` when present, but it also works with environment
variables supplied by the deployment runtime. It requires only the merchant
ID, merchant API certificate serial/private key, and the WeChat Pay public key
ID/key. It does not require an AppID, API v3 decryption key, callback URL,
database, or enabled collection flag because it creates no order, callback, or
ledger write.

A successful result is one redacted JSON line whose request and response modes
are both `public_key`. Failure output contains only a stable reason code. The
command never prints the merchant ID, public-key ID, key material,
Authorization header, echo payload, or raw provider response.

This probe proves that WeChat accepts the merchant signature and that the
configured public key verifies a real response signed under the requested
public-key ID. The merchant-console response percentage remains an external
rolling metric; after a successful probe, observe its next hourly refresh and
still complete the live payment/refund canary below.

## Local real-payment callback testing

A local real-payment test still requires public HTTPS payment and refund
callback URLs. Do not expose the full representative application through a
temporary tunnel. Start the callback-only proxy instead:

```bash
pnpm wechat:callback-proxy
cloudflared tunnel --url http://127.0.0.1:4302 --no-autoupdate
```

The proxy binds only to loopback, forwards the exact request body and WeChat
signature headers to `http://127.0.0.1:3002`, and permits only these two exact
targets:

- `POST /api/payments/wechat/notify`
- `POST /api/payments/wechat/refund-notify`

All other methods, paths, and query-bearing targets return 404. Configure the
temporary tunnel origin as the two explicit callback URLs while leaving the
representative application's canonical origin on localhost. The tunnel must
remain alive until payment and refund reconciliation finish. Never put a
credential or query parameter in either callback URL.

When an existing HTTPS server is available instead of Cloudflare Tunnel, keep
the same callback-only boundary:

1. Run `pnpm wechat:callback-proxy` on the development machine.
2. Create a reverse SSH tunnel from server loopback port `4302` to local
   loopback port `4302`.
3. If the HTTPS gateway runs in a container that cannot reach host loopback,
   run `scripts/wechat-pay-private-bridge.mjs` on an RFC 1918 host address and
   point it only at server loopback port `4302`.
4. Configure the HTTPS gateway from
   `deploy/wechat/pay.bonary.xyz.subdomain.conf`, or an equivalent
   environment-specific file, so only the two exact POST callback paths reach
   that private bridge.

The callback proxy, reverse SSH tunnel, and private bridge must all remain
alive for the canary. The private bridge rejects public bind addresses and
non-loopback targets. Keep collection disabled until public TLS, callback
rejection behavior, service readiness, operations health, and the public-key
probe all pass.

## Repository gates

Before deploying, require all of these to pass against the release commit:

```bash
pnpm verify
pnpm test:postgres:wallet
docker compose config --quiet
```

The PostgreSQL wallet suite must run only against its isolated disposable test
database. Passing these commands is still code/database evidence, not the live
merchant canary.

## Deployment sequence

1. Deploy the compatible code and the
   `20260728090000_wechat_refund_submission_recovery` and
   `20260728110000_wechat_operations_readiness` migrations with both explicit
   flags set to `false`.
2. Enable processing only:

   ```dotenv
   DELEGATE_WECHAT_PAY_PROCESSING_ENABLED=true
   DELEGATE_WECHAT_PAY_COLLECTION_ENABLED=false
   ```

3. Confirm the representative service `/ready` and workflow runner `/ready`
   endpoints return HTTP 200.
4. Fetch `/operations/wechat-pay/health`; require a `healthy` body and confirm
   the order-reconciliation, refund-lifecycle, and refund-reversal workers have
   fresh heartbeats with no dead-letter, reconciliation-required,
   abnormal-refund, or unmatched-refund alert.
5. Exercise signed order and refund query test doubles in the deployed build;
   no provider request is made by startup preflight.
6. Enable collection for the ¥5 canary:

   ```dotenv
   DELEGATE_WECHAT_PAY_COLLECTION_ENABLED=true
   ```

7. Do not raise the canary amount or open traffic until the payment and refund
   acceptance checklist below is complete.

## ¥5 payment and refund canary

Use a dedicated test audience account and a real WeChat payer. Record only
Delegate order/refund IDs in the internal test ticket; never copy payer data or
raw decrypted provider payloads.

### Payment

1. Create one ¥5 Native order and verify that a QR code and explicit expiry are
   shown.
   Confirm the local order, frozen request facts, and reconciliation Outbox
   item existed before the first provider POST.
2. Verify a second order cannot be created while the first QR code is valid.
3. Scan and pay once.
4. Verify either the callback or signed query completes the order.
5. Verify exactly one provider payment event, one token purchase, one wallet
   transaction group, and one set of balanced ledger entries exists.
6. Replay the callback and status query. Balances and row counts must not
   change.
7. Confirm the public page shows “payment confirmed” before its wallet refresh,
   and that a failed refresh can be retried without another payment.
8. In a non-paid canary, suppress the first create response and verify recovery
   queries the same `out_trade_no` before any exact replay. Suppress a returned
   `code_url`, wait at least five minutes, and verify a replacement is blocked
   until WeChat acknowledges the signed close request.

### Full refund

1. Confirm all purchased service credits remain unused and unreserved and all
   related creator earnings remain pending.
2. Submit one full refund from the authenticated billing dashboard using one
   idempotency key.
3. Confirm the refund intent and lifecycle Outbox item commit before the first
   provider call, the linked entitlement is immediately frozen, and the first
   worker changes `QUEUED` to durable `UNKNOWN` before sending the POST.
4. Replay the same request. It must return the same refund intent without
   another logical refund.
5. Confirm a signed submit/query response records `PROCESSING`, `SUCCESS`,
   `CLOSED`, or `ABNORMAL`, or that a verified terminal callback records
   `SUCCESS`, `CLOSED`, or `ABNORMAL`; no payer account field is retained.
6. For `PROCESSING`, confirm the first query is delayed for about one minute and
   later queries back off to 5, 10, 20, and 30 minute intervals.
7. For `SUCCESS`, confirm exactly one reversal transaction restores the user
   cash projection, removes the unused service credits, reverses pending creator
   earnings, and moves the recharge order to refunded.
8. Replay callback, submit response, and query in different orders. No balance
   or ledger row may be duplicated, and `SUCCESS` must remain terminal.
9. Run the read-only funds reconciliation and require a healthy result.
10. Require the Owner-wide exception queue to contain no case for this canary
    order/refund and `/operations/wechat-pay/health` to return a `healthy`
    body.

## Readiness and operations health

- `/health` is liveness only. HTTP 200 means the process is running.
- `/ready` is for container readiness. It checks the release-flag invariant,
  local credential parsing, database access, and worker freshness where
  applicable.
- Financial exceptions do not fail container readiness; restarting a healthy
  process cannot repair a ledger exception.
- A lane/checkpoint/exception-sync execution failure does fail workflow-runner
  readiness. An idle tick during Outbox backoff only refreshes heartbeat state;
  it does not clear the durable failure. Readiness also reads persisted worker
  checkpoints and outstanding `FAILED` backlog, so a restart, another replica,
  or an unrelated successful item cannot turn an unresolved lane green. A
  durable dead letter, abnormal refund, or
  reconciliation-required business case is reported through operations health
  instead.
- `/operations/wechat-pay/health` is the internal financial-operations
  snapshot. It deliberately returns HTTP 200 even when its body is `degraded`
  or `critical`; alert on the body, not HTTP status. Keep the workflow-runner
  port on the private service/observability network rather than publishing it
  as a customer endpoint. If the snapshot query itself fails, the endpoint
  still returns a `critical` body with the stable
  `wechat_operations_health_query_failed` code.
- Order reconciliation, refund lifecycle, and refund reversal run as three
  `Promise.allSettled` lanes. Each lane writes its own durable heartbeat,
  success time, consecutive-failure count, stable failure code, and redacted
  scalar summary, so one failed lane cannot hide or stop the others.
- Operations health exposes only per-lane counts for retryable `FAILED`
  backlog; it never exposes the affected order or refund identity.
- The operations snapshot aggregates only redacted alert codes and counts. It
  must never include merchant credentials, order IDs, refund IDs, user IDs,
  decrypted notifications, provider descriptions, or raw exception messages.

Treat these classes as paging alerts:

- missing or stale worker heartbeat;
- repeated worker tick failure;
- order-reconciliation, refund-lifecycle, or refund-reversal dead letter;
- refund requiring manual reconciliation;
- unmatched or abnormal verified refund.

Owner-facing exception queues may only contain cases that can be proven through
the recharge order and representative to belong to that owner. Unmatched
platform-wide refund events require a separate platform-operator channel and
must never be guessed into an owner workspace.

The Dashboard presents one Owner-wide queue across all representatives that
Owner owns. Its `rep` query parameter is only the active workspace's billing
authorization anchor; it must not narrow the result set or action scope to that
representative.

In the owner Dashboard, an `OPEN` case must first be claimed by the current
Owner. Only that Owner may retry it when its exact bound Outbox item reports
retryable, or acknowledge it with a required non-sensitive note. Every action
is owner-authorized, idempotent, version-checked, and audited. Acknowledge is
not financial resolution, does not unfreeze an entitlement, and does not edit
balances. The queue moves to `RESOLVED` only after its underlying Outbox or
verified refund state recovers.

## Incident playbooks

### Stop new collection

Set only:

```dotenv
DELEGATE_WECHAT_PAY_COLLECTION_ENABLED=false
DELEGATE_WECHAT_PAY_PROCESSING_ENABLED=true
```

Existing QR codes, callbacks, queries, refunds, and ledger recovery continue.

### Callback verification failure

Keep processing enabled. Restore the correct public key and, during migration,
the matching legacy platform certificate. WeChat retries failed callbacks, and
the signed query workers recover outcomes that were not delivered.

### Payment create outcome unknown or QR payload lost

Do not create a new merchant order number and do not cancel from local time
alone. Let the reconciliation worker query the original `out_trade_no`. It may
replay the exact frozen Native create request only after a signed not-found
result. If WeChat reports the order pending but Delegate has no `code_url`,
wait at least five minutes and use the signed close API; allow a replacement
only after the close response succeeds. A late verified payment still credits
exactly once.

### Native create returns `403 NO_AUTH`

Keep new collection disabled and processing enabled. Do not switch to the
service-provider endpoint unless the merchant platform identifies the account
as a service provider; the ordinary-merchant Native endpoint is correct for an
account whose merchant type is `普通商户`.

Confirm all of the following before escalating:

- the configured merchant ID matches `账户中心 -> 商户信息`;
- `产品中心 -> Native支付` shows the product as enabled;
- the configured AppID appears as associated under AppID account management;
- the provider returned `NO_AUTH`, rather than `APPID_MCHID_NOT_MATCH` or
  `SIGN_ERROR`.

If all checks pass, treat the incident as a provider entitlement mismatch.
Capture the response `Request-ID`, request time, merchant ID, AppID, method,
path, and redacted request facts, then ask WeChat Pay support to verify the
Native API entitlement for that merchant. Never include the merchant private
key, API v3 key, Authorization header, or decrypted callback payload. Keep the
same-order reconciliation item recoverable while the frozen request remains
unexpired; do not create repeated user-facing orders to probe the permission.

### Refund outcome unknown

Do not create a new refund number and do not unfreeze the entitlement. Let the
lifecycle worker query the original `out_refund_no`; if WeChat returns
`RESOURCE_NOT_EXISTS`, either resubmit the exact original request or, for the
small allowlist of documented deterministic rejection codes retained from the
original attempt, mark it rejected and restore eligibility. Unknown rejection
codes remain frozen. A processing or unknown refund remains recoverable for at
least eight days before it is routed to manual reconciliation.

### Refund abnormal or unsafe to reverse

Do not change balances manually. Keep the entitlement frozen, claim the
operations case, acknowledge it with a non-sensitive note, resolve the
provider-side abnormal refund through the merchant platform, and apply any
local correction as an idempotent compensating ledger transaction. Require a
healthy read-only reconciliation before closing the incident.

### Dead-letter Outbox case

Claim the owner-visible case, inspect only redacted logs and signed provider
state, then use Retry only if the case still reports `retryable`. Retry resets
the exact bound order-query, refund-lifecycle, or refund-reversal Outbox item;
it does not mint a new merchant order/refund number and does not write a
balance. If the case version changed, refresh rather than forcing the action.

### Roll back application code

Database migrations are forward-only. Roll back application containers only to
a version that understands the migrated schema, and keep processing enabled
throughout the rollback. Never roll back by disabling callback or recovery
workers.

## Evidence to retain

Retain deployment version, migration result, readiness snapshots, redacted
operations-health snapshots, canary order/refund IDs, callback/query source,
idempotency replay results, and final reconciliation summary. Do not retain
credentials, payer account fields, raw decrypted callbacks, or provider error
descriptions in tickets or application logs.
