# Channel, Identity, and Entitlement Migration Runbook

This runbook applies to:

- `20260723230000_channel_identity_entitlements`
- `20260723231000_channel_identity_safe_backfill`
- `20260723232000_identity_binding_connection_scope`
- `20260723233000_matrix_virtual_user_active_uniqueness`

The migrations are expand-only. They retain the legacy Telegram identifiers,
wallets, invoices, unlock timestamps, and channel kind fields so the application
can roll back without a destructive database downgrade.

## Safety contract

The automated backfill copies only facts already proven by:

- a numeric Telegram user ID observed on a legacy `Contact`;
- an existing unique `IdentityLink`;
- an existing foreign-key relationship;
- an unambiguous conversation/channel coordinate.

It never:

- merges two different `AudienceIdentity` records;
- reassigns a non-null identity or wallet owner;
- picks one member of a duplicate channel-binding group;
- converts XTR/Stars into CNY, USD, cash, or agent tokens;
- invents a provider account ID for a legacy Telegram payment;
- grants counted entitlement units from legacy unlock flags.

Rows that cannot be proven are returned by the conflict report.

## Required artifacts

Before touching a shared database, record:

- target environment and database fingerprint;
- a recent snapshot identifier;
- successful restore-test timestamp;
- current application commit;
- current Prisma migration status;
- output of all three SQL reports below.

Never include the database password in an archived command transcript.

## 1. Pre-deployment gate

Run against the database before applying the expansion migration:

```bash
psql "$DATABASE_URL" \
  -X \
  --set ON_ERROR_STOP=1 \
  --csv \
  --pset footer=off \
  --file prisma/preflight/channel-identity-entitlements-deploy-blockers.sql
```

The result must contain zero rows.

Blocking rows mean:

- one Telegram subject already claims multiple Delegate identities;
- one Telegram payment charge is attached to multiple invoices;
- multiple conversations claim the same representative/channel coordinate.

Do not resolve these by “keeping the newest” or “keeping the first.” Identity
conflicts require provider re-authentication. Payment charge conflicts require
comparison with Telegram provider evidence. Channel-coordinate conflicts require
an operator to determine the actual owner and preserve the other timeline under
a new, truthful coordinate.

## 2. Validate and deploy

Validate the checked-in Prisma model:

```bash
pnpm db:validate
```

Before deploying, run all real PostgreSQL 16 gates:

```bash
pnpm test:postgres:channel-platform
pnpm test:postgres:channel-migration
pnpm test:postgres:entitlements
```

The channel-platform gate proves that temporary Telegram and Matrix identities
can bind to the same registered Web audience, keep separate native
conversations, share one Web-funded entitlement, deduplicate generation, and
obey pause/resume on a disposable database. The migration gate replays the
expand/backfill migrations and all reports. The entitlement gate exercises
real row locks and unique constraints for last-unit reservation,
consume/refund/release races, identity merge guards, and run-attempt reuse.

For a production or shared staging database, first deploy the same migration set
to a restored disposable copy and run the post-deployment reports there.

Then use the repository's normal reviewed deployment path:

```bash
pnpm db:deploy
```

Do not edit an already-applied migration. If
`20260723230000_channel_identity_entitlements` has already been applied in any
shared environment, preserve its checksum and move corrective SQL into a new
additive migration.

## 3. Post-deployment dry run and reconciliation

Run the detailed report:

```bash
psql "$DATABASE_URL" \
  -X \
  --set ON_ERROR_STOP=1 \
  --csv \
  --pset footer=off \
  --file prisma/preflight/channel-identity-entitlements-conflicts.sql
```

Run parity counters and financial totals:

```bash
psql "$DATABASE_URL" \
  -X \
  --set ON_ERROR_STOP=1 \
  --csv \
  --pset footer=off \
  --file prisma/preflight/channel-identity-entitlements-reconciliation.sql
```

Archive both outputs. A `reconciled=false` counter is not permission to rerun a
blind update; find its detailed conflict row first.

`ACTIVE_CHANNEL_CONNECTION_ID_REQUIRED` also requires an operator decision.
Legacy rows do not reliably identify the Telegram bot account, Matrix
homeserver connection, or Application Service connection. Configure the real
connection ID before enabling that binding. Do not copy `externalUserId` into
`connectionId`; they represent different objects.

For Matrix identity links, the safe backfill derives `issuer` only from a valid
full MXID and lowercases the homeserver part. Invalid MXIDs and normalization
collisions remain in the report. Telegram uses the stable
`delegate-managed-bot` authentication realm; the concrete numeric bot ID
belongs in `connectionId` and is not guessed by migration.

`ORPHANED_CONVERSATION_CHANNEL_BINDING` is also a cutover blocker. It means a
conversation route has no matching representative-level channel binding after
the safe backfill. Do not treat it as implicitly active. Either attach the
verified route to the correct representative binding or isolate the
conversation while its ownership is reconciled.

### Expected non-zero report during the compatibility window

`LEGACY_INVOICE_ENTITLEMENT_DECISION_REQUIRED` is expected for a historical,
paid, non-sponsor Telegram invoice that predates `ServicePaymentOrder`.

The old runtime used `Contact.isPaid`, `passUnlockedAt`, and
`deepHelpUnlockedAt` as effectively unmetered access. It did not record how many
paid replies remained. The new entitlement model grants counted units.
`PricingPlan.includedReplies` alone therefore cannot prove the remaining
balance.

Before migrating such an invoice, product and finance must choose and record one
of these policies:

1. grandfather it as a separate, non-consumable legacy-access product;
2. grant an explicitly reviewed remaining-unit amount based on complete usage
   evidence;
3. leave the legacy unlock reader active until the entitlement expires or is
   manually replaced.

The review must also identify the actual Telegram bot/provider account. Do not
use a guessed account ID. Once approved, create the `ServicePaymentOrder`,
provider event, entitlement account, GRANT ledger entry, and any REFUND entry in
one serializable transaction using the production entitlement service. Re-run
both reports afterward.

`SPONSOR` invoices are intentionally not converted to audience service
entitlements. They remain creator/sponsor-pool financial records.

`LEGACY_PENDING_INVOICE_REISSUE_REQUIRED` must be resolved before accepting
payments. A legacy pending invoice does not prove the Telegram provider account
needed by `ServicePaymentOrder`; cancel it and issue a new invoice through the
currently configured Telegram connection. Do not attach an old payload to a
guessed provider account.

## 4. Cutover gate

Do not enable the new reader or adapter owner until:

- there are no identity conflicts;
- every active provider link points to a canonical, non-disabled identity;
- every active conversation binding has an unambiguous `bindingKey`;
- every active conversation binding references the matching representative
  channel binding;
- every paid/refunded service order has a GRANT ledger entry;
- no applied usage charge is attributed to the wrong audience;
- totals have been compared per currency/rail, never across currencies;
- a rollback application build has been tested against the expanded schema.

During shadow operation, the new path may persist comparison data but must not
generate, charge, fulfill, or send.

Telegram production cutover additionally requires
`TELEGRAM_CONVERSATION_PLATFORM_MODE=worker`; production startup rejects
`legacy` and `shadow`. Group and direct-Compute Telegram paths remain disabled
in worker mode until they use the same durable generation and entitlement
pipeline. The checked-in Compose release path sets `NODE_ENV=production` by
default so these startup and payment gates cannot be bypassed by an omitted
runtime environment.

Live Stars is a separate NO-GO gate in the current release.
`TELEGRAM_STARS_LIVE_ENABLED` defaults to false, and production rejects invoice
creation and pre-checkout even if it is changed. Long polling can advance past
an already charged update when the database is unavailable before the raw
inbox write. Implement and test a webhook/raw-ingress boundary that returns
non-2xx until persistence succeeds, plus settlement reconciliation, before
removing this gate. Continue to accept and reconcile `successful_payment`
events for previously charged invoices. Once one of those events is durable,
fulfillment failures remain retryable with capped backoff instead of entering a
terminal automatic dead letter. Historical payment dead letters are reclaimed,
and a resolvable invoice attaches the inbox row to its conversation so the
owner-facing channel status can surface the failure.

## 5. Application rollback

The normal rollback is application-only:

1. disable the new adapter owner/feature flag;
2. stop new generation claims and drain or freeze its outbox;
3. record inbox/outbox high-water marks;
4. restore the previous application build;
5. resume the legacy adapter from the recorded provider cursor;
6. replay only durable events that have no completed business-message key;
7. run payment and entitlement reconciliation again.

The previous build remains compatible because the migration does not remove or
make legacy columns unusable.

Do not drop the new tables, enums, columns, or indexes during an incident.
PostgreSQL enum removal and populated-column removal are destructive and are not
part of operational rollback.

## 6. Data rollback

There is intentionally no automatic destructive down migration.

The safe backfill only fills previously-null foreign keys/route fields and adds
deterministic provisional Telegram identities. Clearing those values later
could erase legitimate writes made after cutover.

If a backfilled mapping is proven wrong:

1. stop writers for the affected provider subject;
2. preserve all linked row IDs and ledger entries in an incident artifact;
3. re-authenticate the provider subject;
4. use the explicit identity-reconciliation workflow;
5. append compensating entitlement/payment ledger entries where required;
6. revoke the wrong `IdentityLink` instead of deleting provider evidence;
7. rerun the conflict and parity reports.

Deterministic IDs beginning with `backfill_tg_identity_` and
`backfill_tg_link_` identify migration-created rows, but that prefix alone is
never sufficient reason to delete them.

## 7. Completion and later cleanup

Keep legacy readers and fields through the full parity and rollback window.
Cleanup is a separate contract migration and requires:

- zero unresolved report rows, except explicitly waived archived legacy access;
- payment-provider and entitlement-ledger reconciliation;
- no reads of `Contact.isPaid`, `passUnlockedAt`, or `deepHelpUnlockedAt` for
  authorization;
- no runtime dependence on required Telegram-shaped IDs;
- a tested backup and restore plan for the contract migration.
