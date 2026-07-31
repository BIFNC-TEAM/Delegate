# Logto Account Migration Runbook

This runbook governs the move from subject-only legacy Logto links to the
self-hosted, issuer-aware Account model defined in
[`adr-self-hosted-logto-account-system.md`](./adr-self-hosted-logto-account-system.md).

The current preflight is deliberately read-only. It does not update an issuer,
merge identities, create Accounts, or modify Workspace ownership.

## Required deployment record

Before running an identity or Account migration against shared staging or
production, record:

- target environment and masked database fingerprint;
- current Delegate commit;
- current and target Logto issuer;
- current Prisma migration status;
- snapshot identifier and creation time;
- most recent isolated restore verification time;
- the complete preflight CSV;
- the reviewed mapping artifact for every `REVIEW` row.

Never archive database passwords, Logto client secrets, authorization codes, or
tokens with these artifacts.

## Run the current-schema preflight

```bash
DATABASE_URL="postgresql://..." pnpm auth:identity:preflight
```

Generate a non-overwriting, mode-`0600` approval template for the current
REVIEW rows:

```bash
mkdir -p .local/logto
DATABASE_URL="postgresql://..." pnpm auth:identity:preflight -- \
  --write-approval-template ./.local/logto/identity-approvals.json
```

An authorized reviewer must fill each row's `decision`, `approvedBy`, and
`approvedAt`. The generated `detailsSha256` binds the approval to the exact
current report details.

For a cutover gate, require all review rows to have an exact, non-stale
approval:

```bash
DATABASE_URL="postgresql://..." pnpm auth:identity:preflight -- \
  --strict --approvals ./.local/logto/identity-approvals.json
```

Approval artifacts can contain identity keys and must stay in the ignored
`.local/logto/` directory or an access-controlled release-evidence store; do
not commit them.

The command runs
[`logto-account-identity-conflicts.sql`](../prisma/preflight/logto-account-identity-conflicts.sql)
inside a read-only transaction.

Exit codes:

- `0`: no blocking issue; non-strict mode may still show review rows;
- `2`: a blocking identity issue exists;
- `3`: the approval artifact is missing, incomplete, stale, or invalid;
- other non-zero values: the query or database connection failed.

## Issue handling

### `OWNER_LOGTO_ISSUER_REQUIRED`

The legacy Owner link has no verified issuer in metadata or contains a
non-HTTP(S) value.

Resolve only from a verified historical ID token/configuration record or from a
single issuer that can be proven to have served all affected production
subjects. Do not copy the new self-hosted issuer onto an old identity merely
because its subject string happens to exist there.

### `OWNER_LOGTO_ISSUER_BACKFILL_REQUIRED`

The expand migration has added `OwnerIdentityLink.issuer`, but this row still
depends on legacy metadata evidence. Run the bounded evidence-only backfill;
strict readiness must not pass until the physical issuer column is populated.

### `OWNER_LOGTO_ISSUER_EVIDENCE_MISMATCH`

The stored issuer column disagrees with the historical verified-token metadata.
Quarantine the row and resolve it from the deployment/authentication record.
Do not let either value win automatically.

### `AUDIENCE_LOGTO_ISSUER_REQUIRED`

The Audience Logto link uses the legacy `delegate` placeholder, is blank, or is
not an HTTP(S) issuer.

Resolve using the same evidence rules as Owner identities. A channel issuer
such as Matrix or Telegram is outside this report and must not be rewritten.

### `PRINCIPAL_MULTIPLE_OWNER_IDENTITIES`

One exact `(issuer, subject)` maps to multiple Owners. Quarantine the principal
and require operator review. Never pick the newest or oldest row.

### `PRINCIPAL_MULTIPLE_AUDIENCE_IDENTITIES`

One exact `(issuer, subject)` maps to multiple canonical Audience identities.
Disable login for that principal until the identity and financial history are
reviewed. Never merge automatically.

### `CROSS_PERSONA_ACCOUNT_MAPPING_REQUIRED`

The same exact principal currently appears as both Owner and Audience. This is
normally a candidate for one Account with two personas. The mapping must be
explicit and must not merge contacts, conversations, wallets, KYC, or payout
records.

### `SAME_EMAIL_DIFFERENT_PRINCIPAL_REVIEW`

Multiple Owner principals currently share a normalized email. Treat them as
different Accounts unless separate strong evidence and an explicit account
linking operation prove otherwise.

### `SAME_SUBJECT_DIFFERENT_ISSUER_REVIEW`

The same subject string exists under different issuers. These are distinct
principals by default.

### `OWNER_WITHOUT_LOGTO_IDENTITY_REVIEW`

Create a provider-independent Account for the legacy Owner, but do not invent
an AuthIdentity and do not grant login.

### `NON_ACTIVE_AUDIENCE_IDENTITY_REVIEW`

A Logto link points to a merged or disabled Audience identity. Resolve to the
canonical active target or retain the disabled state before Account backfill.

### `MULTI_OWNER_ORGANIZATION_MAPPING_REQUIRED`

The current Organization contains multiple Owners. Before treating it as a
shared Workspace, explicitly choose whether it remains shared or is split.
Migration must not silently grant each Owner access to all Representatives.

The report derives this set from both `Owner.organizationId` and
`OrganizationMember.organizationId`; neither legacy path is treated as the
sole authority.

### `OWNER_ORGANIZATION_MEMBERSHIP_MISMATCH`

`Owner.organizationId` and the Owner's unique `OrganizationMember` row disagree,
or only one of the two legacy paths is populated. This is a blocker because an
Account-based Workspace backfill cannot safely infer which Organization should
win. Reconcile the two records explicitly and rerun the preflight.

## Expand and shadow deployment

The first schema migration is additive:

1. add issuer to the legacy Owner link;
2. add Account and AuthIdentity;
3. add nullable `Owner.accountId`;
4. add nullable `AudienceIdentity.accountId`;
5. add supporting non-unique indexes;
6. deploy dual-write code;
7. run a resumable backfill outside the migration transaction;
8. compare legacy and shadow reads;
9. add validated uniqueness only after conflict reports are empty.

After the nullable column expansion, run the evidence-only backfill in bounded
batches:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v batch_size=500 \
  -f prisma/backfill/logto-issuer-safe-legacy.sql
```

Repeat until both reported update counts are zero, then rerun the preflight.
Each concurrent index is a separate, single-statement Prisma migration,
matching the repository's existing PostgreSQL pattern. Do not combine multiple
`CREATE INDEX CONCURRENTLY` statements in one migration: Prisma will wrap that
multi-statement migration and PostgreSQL will reject it. Never place the batch
updates inside `prisma migrate deploy`.

Exercise the expand, bounded backfill, preflight, concurrent indexes, and
INVALID-index recovery path against a disposable PostgreSQL 16 instance:

```bash
pnpm test:postgres:logto-issuer-safe
```

### Recover an interrupted concurrent index build

A failed or interrupted `CREATE INDEX CONCURRENTLY` can leave a same-name
catalog entry with `indisvalid = false` or `indisready = false`. Do not change
the migration to `CREATE INDEX CONCURRENTLY IF NOT EXISTS`: name existence does
not prove that the index is usable, so that form can silently preserve the
INVALID index.

Stop the deploy at the failed migration and repair only that index:

```bash
DATABASE_URL="postgresql://..." \
  bash scripts/logto-issuer-safe-index-operation.sh owner-lookup

DATABASE_URL="postgresql://..." \
  bash scripts/logto-issuer-safe-index-operation.sh owner-unique

DATABASE_URL="postgresql://..." \
  bash scripts/logto-issuer-safe-index-operation.sh audience-unique

DATABASE_URL="postgresql://..." \
  bash scripts/logto-issuer-safe-index-operation.sh owner-account-unique

DATABASE_URL="postgresql://..." \
  bash scripts/logto-issuer-safe-index-operation.sh audience-account-unique
```

The operation checks the table, key order, uniqueness, predicate, and
`indisvalid`/`indisready`/`indislive` state. It reuses an exact healthy index,
drops only the expected unusable index with `DROP INDEX CONCURRENTLY`, and then
rebuilds it. A healthy same-name index with a different definition or an index
on another table is a hard failure requiring manual review. The two Account
targets are intentionally stricter: a same-name VALID index is also a hard
stop, because the operator must reconcile the already-built object with Prisma
migration history rather than silently treating a recovery command as the
original migration.

The exact target-to-migration mapping is:

| Recovery target | Prisma migration |
| --- | --- |
| `owner-lookup` | `20260729143100_owner_logto_issuer_lookup_index` |
| `owner-unique` | `20260729143200_owner_logto_issuer_unique_index` |
| `audience-unique` | `20260729143300_audience_logto_issuer_unique_index` |
| `owner-account-unique` | `20260729143500_owner_account_unique_index` |
| `audience-account-unique` | `20260729143600_audience_account_unique_index` |

For 1435/1436, resolve duplicate non-null `accountId` data from the approved
Account reconciliation record before retrying. The recovery command will drop
and rebuild only a same-name INVALID index with the exact expected table,
single-column shape, uniqueness, opclass, and no predicate. A wrong-shape
INVALID index, a constraint-backed index, or a VALID index is preserved and
rejected for DBA review.

During Prisma recovery, run only the target corresponding to the failed
migration; using `all` would pre-create later indexes whose migrations have not
run. After the operation reports the target as valid, preserve its output in
the deployment record, verify the failed migration name, and mark that one
migration applied:

```bash
DATABASE_URL="postgresql://..." pnpm exec prisma migrate resolve \
  --applied 20260729143100_owner_logto_issuer_lookup_index
```

Use the exact matching migration from the table, including `1435` or `1436`
for the Account persona indexes. Never resolve a migration before the exact
index is valid, ready, live, and its catalog evidence has been attached to the
deployment record. Resume `pnpm db:deploy` only after the resolve succeeds.

The Account/AppSession PostgreSQL gate deliberately creates duplicate rows,
observes the failed CCI remnant, exercises exact recovery, and proves that
wrong-shape and constraint-backed remnants are not dropped:

```bash
pnpm test:postgres:account-appsession-shadow
```

The issuer-safe legacy expansion keeps both old
`(provider, providerSubject)` unique keys. Consequently, the expand release
still rejects the same subject string under two issuers; this is intentional
until the preflight is clean. It also leaves Owner links without verified
issuer metadata as `NULL`. Runtime login must not adopt those rows merely
because a freshly verified principal has the same subject. Reconcile them from
operator-approved evidence before rollout.

`DELEGATE_AUTH_IDENTITY_ISSUER_MODE=shadow` provides two finite expand-phase
fallbacks:

- already-signed Audience v1 sessions without an issuer may use the retained
  legacy unique lookup;
- a new verified callback or exact-issuer Audience session may read an Owner or
  Audience legacy row only when its persisted `metadata.issuer` exactly equals
  the verified issuer.

The second fallback never rewrites the identity key during the request.
Issuer mutation belongs to the bounded operator backfill. New rows and signed
sessions are issuer-exact, and mismatched or missing metadata fails closed.
Set the mode to `enforce` only after the backfill reports zero updates, the
strict preflight has zero blockers, shadow compatibility metrics are zero, and
the maximum issuer-less session TTL has elapsed. Only then may a later contract
migration remove the legacy keys.

Large backfills must be resumable, bounded by primary-key checkpoints, and safe
to rerun. Do not place an unbounded table update in `prisma migrate deploy`.

## OIDC application and Reps callback cutover

Dashboard and Public Representatives are separate Logto Traditional Web
applications. Configure only the matching namespaced client ID and secret in
each service; no service may fall back to the other application or to the
retired shared `LOGTO_APP_*` variables. Callback URIs are derived only from the
canonical `NEXT_PUBLIC_DASHBOARD_URL` and
`NEXT_PUBLIC_REPRESENTATIVE_URL` origins and are both `/auth/callback`.
An optional trusted `LOGTO_BACKCHANNEL_ENDPOINT` is used only for token and
JWKS traffic; the public `LOGTO_ENDPOINT` remains the authorization endpoint
and expected issuer.

During the Reps callback drain, keep the complete
`LOGTO_REPS_LEGACY_ENDPOINT` / `APP_ID` / `APP_SECRET` tuple and an explicit
future RFC3339 `DELEGATE_REPS_LEGACY_CALLBACK_UNTIL` only in the Reps service.
The legacy route may finish valid signed v1/v2 state only at its original
dynamic redirect URI. It returns `410` without a token request for expired or
invalid state/configuration and must never redirect an authorization response
to the fixed callback. Remove the tuple and old Logto redirect registrations
after the deadline.

## Cutover gates

Before `identityResolutionMode=enforce`:

- all `BLOCKER` rows are zero;
- every `REVIEW` row has an approved mapping artifact;
- the old and new issuer are both represented explicitly;
- `(provider, issuer, subject)` shadow mismatches are zero;
- callback concurrency creates exactly one Account/AuthIdentity;
- changed email or phone does not create a new Account;
- same email under a different principal does not merge;
- existing Owner and Audience logins pass real Logto contract tests.

Before `logtoIssuerMode=self_hosted`:

- Account and AppSession v2 are active for the rollout cohort;
- Dashboard admission rejects an ordinary Audience user;
- local and central logout behaviors are verified;
- suspend/delete webhook propagation is within the agreed SLA;
- webhook loss reconciliation is verified;
- the Logto database and required secrets have passed restore rehearsal.

## Rollback

All migrations remain expand-only until contract cleanup.

- Application rollback switches the relevant finite-state mode to the previous
  reader.
- New columns, Accounts, and AuthIdentities remain in place.
- Dual issuer resolution remains enabled after the self-hosted issuer has
  created any production user.
- A Logto application rollback does not automatically roll back a database
  alteration.
- Database point-in-time restore is reserved for data corruption, not ordinary
  application release failure.

Contract cleanup is permitted only after:

- two stable production releases;
- the longest legacy session has expired or been revoked;
- no new legacy-only writes remain;
- parity and reconciliation drift remain zero throughout the observation
  window;
- both application and Logto rollback rehearsals pass.
