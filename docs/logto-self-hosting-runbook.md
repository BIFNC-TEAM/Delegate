# Self-hosted Logto OSS Runbook

This runbook covers the Logto OSS infrastructure baseline. The identity and
Account migration order remains defined in
[`adr-self-hosted-logto-account-system.md`](./adr-self-hosted-logto-account-system.md)
and [`logto-account-migration-runbook.md`](./logto-account-migration-runbook.md).

## Local and CI baseline

[`compose.logto.yml`](../compose.logto.yml) is intentionally local-only and
must not be used as the production manifest. It binds core and Admin Console
ports to loopback, generates disposable local credentials, disables the first
admin's breached-password network check, and uses one Logto replica.

The stack pins the v1.41.0 release of Logto's documented Docker Hub image,
`svhd/logto:1.41.0`; it never uses `latest`.

```bash
# Generates .local/logto/logto.env without starting or pulling containers.
pnpm logto:local:bootstrap

# Offline schema/interpolation check; it does not pull images.
pnpm logto:local:config
pnpm logto:local:preflight

# First start only: starts PostgreSQL, proves the DB is empty, runs seed once,
# starts Logto, and runs OIDC/JWKS/Admin smoke checks.
pnpm logto:local:init

# Subsequent starts.
pnpm logto:local:up
pnpm logto:local:smoke
pnpm logto:local:ps
pnpm logto:local:logs
pnpm logto:local:down
```

Local URLs:

- Logto core: `http://127.0.0.1:3301`;
- Logto Admin Console: `http://127.0.0.1:3302`;
- Logto PostgreSQL: internal Docker network only.

The `logto-seed` and `logto-alteration` services are one-shot jobs. They are
not dependencies of the long-running service and never execute on an ordinary
restart. Local seed, backup, and alteration commands also take one atomic
`.local/logto/operation.lock`; a concurrent invocation fails before inspecting
or changing the database.

The named PostgreSQL volume is not a complete backup by itself. The generated
`.local/logto/logto.env` contains both the database credential and the Secret
Vault KEK; losing it can make the old volume unusable even when its database
files survive. Create a consistent local backup set with:

```bash
pnpm logto:local:backup
```

The command writes an ignored, mode-`0600` custom-format database dump,
the matching `logto.env`, and a checksum manifest below
`.local/logto/backups/`. It also proves that `pg_restore` can read the dump.
The backup contains live secrets: copy it to an encrypted, access-controlled
location and run a separate restore rehearsal before relying on it.

For a reviewed local version upgrade, pass that exact artifact:

```bash
pnpm run logto:local:alter -- --backup \
  /absolute/path/to/.local/logto/backups/<timestamp>
```

The alteration command verifies the dump checksums and requires the backed-up
database credential and KEK to exactly match the current generated
environment. It then stops Logto, runs the official non-interactive
single-run alteration, and starts Logto only after the job succeeds.

## Manual Console bootstrap

After the first `logto:local:init`, open the Admin Console and create the one
OSS administrator. Then create:

1. a Dashboard Traditional Web application;
2. a Public Representatives Traditional Web application;
3. a Management API machine-to-machine application.

For local Dashboard testing, register:

- redirect URI: `http://localhost:3001/auth/callback`;
- post-sign-out URI: `http://localhost:3001/auth/logout/callback`.

For local Public Representatives testing, register the one canonical callback:

- redirect URI: `http://localhost:3002/auth/callback`;
- post-sign-out URI:
  `http://localhost:3002/reps/lin-founder-rep`.

The Representative slug and the full anonymous public-chat binding are carried
inside short-lived signed state. Never add a slug query parameter or wildcard
redirect URI.

Copy both application credentials into the Delegate `.env`:

```dotenv
LOGTO_ENDPOINT=http://127.0.0.1:3301
LOGTO_BACKCHANNEL_ENDPOINT=http://host.docker.internal:3301
LOGTO_SCOPES=openid profile email phone
LOGTO_DASHBOARD_APP_ID=<dashboard-application-id>
LOGTO_DASHBOARD_APP_SECRET=<dashboard-application-secret>
LOGTO_REPS_APP_ID=<public-representatives-application-id>
LOGTO_REPS_APP_SECRET=<public-representatives-application-secret>
```

After the local Management M2M application has been created and assigned the
Management API access role, configure Delegate's lifecycle hook and ignored
local secret environment without printing credentials:

```bash
pnpm logto:local:configure-app-auth
```

The command is local-development-only, creates or updates the two-event Hook,
registers the Dashboard post-sign-out callback, and atomically writes
`.local/logto/delegate-auth.env` with mode `0600`.
`scripts/docker-compose-local.sh` loads that file after `.env`; production must
use its deployment secret manager instead.

`NEXT_PUBLIC_DASHBOARD_URL` and `NEXT_PUBLIC_REPRESENTATIVE_URL` must each be
an origin without a path, query, or fragment. Delegate derives both exact
`/auth/callback` redirect URIs from those origins. It does not read a
`LOGTO_REDIRECT_URI`.

`LOGTO_ENDPOINT` is the browser-reachable permanent public endpoint and defines
the expected OIDC issuer. Authorization and issuer validation always use
`LOGTO_ENDPOINT`. `LOGTO_BACKCHANNEL_ENDPOINT` is an optional trusted
server-only route used solely for token exchange and JWKS retrieval; it never
becomes the issuer. The local application containers default that backchannel
to `http://host.docker.internal:3301` because
`http://127.0.0.1:3301` inside a container would address the container itself.
Both endpoint variables accept HTTP(S) only.

Inject the Dashboard secret only into the Dashboard service. Inject the Reps
secret only into the Reps service. Migration, Bot, worker, workflow, and other
containers must receive neither application secret. The M2M credentials are
reserved for the later webhook and reconciliation phase; do not place any
credential in browser-readable variables.

### Dynamic Reps callback drain

Deploy the fixed callback before changing the Logto Public Representatives
application registration. New logins then use `/auth/callback`. To finish
authorization responses already issued against
`/reps/{slug}/auth/callback`, inject the following only into the Reps service:

```dotenv
LOGTO_REPS_LEGACY_ENDPOINT=http://127.0.0.1:3301
LOGTO_REPS_LEGACY_BACKCHANNEL_ENDPOINT=http://host.docker.internal:3301
LOGTO_REPS_LEGACY_APP_ID=<previous-reps-application-id>
LOGTO_REPS_LEGACY_APP_SECRET=<previous-reps-application-secret>
DELEGATE_REPS_LEGACY_CALLBACK_UNTIL=2026-07-29T18:00:00Z
```

Choose a deadline no longer than the operational drain window. The signed
state itself remains limited to ten minutes and rejects future-issued values.
The old endpoint exchanges the code against its original dynamic redirect URI;
it never redirects the authorization response to the new callback. An absent,
invalid, or expired deadline, an invalid signed v1/v2 state, or an incomplete
legacy tuple returns `410` before any token call. After the deadline, remove
all legacy variables and remove the old dynamic redirect registrations.

The legacy backchannel is optional and non-secret. If it is set, remove it with
the legacy tuple after the drain.

### Creator admission

Dashboard admission remains closed by default:

```dotenv
DELEGATE_CREATOR_ADMISSION_MODE=invite_only
```

In invitation mode, create or sign in the intended user in Logto's default
tenant, obtain that user's exact OIDC `sub`, and add the exact principal to
Delegate:

```dotenv
DELEGATE_CREATOR_ADMISSION_PRINCIPALS=http://127.0.0.1:3301/oidc|<sub>
```

The issuer portion must exactly match the public `LOGTO_ENDPOINT` issuer; never
use the backchannel URL, an email address, a subject-only value, or a wildcard.
Without this entry (or another explicit admission record), the first new Owner
login is intentionally rejected.

For a reviewed self-service rollout, set:

```dotenv
DELEGATE_CREATOR_ADMISSION_MODE=self_service
```

Self-service creation still requires an authorization request whose signed
state explicitly records `flow=register`. A user who only chose sign-in is
redirected to the Creator registration recovery page and never receives an
Owner persona as a login side effect. Keep the website registration CTA gated
until Account/AppSession shadow parity and the real Logto registration contract
tests pass.

### Identity lifecycle webhook

Create a Logto webhook for the canonical Dashboard endpoint:

```text
https://<dashboard-origin>/api/auth/logto/webhook
```

Subscribe it to `User.SuspensionStatus.Updated` and `User.Deleted`, then copy
the Console signing key into `LOGTO_WEBHOOK_SIGNING_KEY`. Delegate verifies the
exact raw request body against the `logto-signature-sha-256` HMAC header,
deduplicates the payload hash, ignores out-of-order suspension changes, and
stores no raw provider payload. Suspension moves only an active AuthIdentity to
`SUSPENDED`; reactivation restores only that state. Deletion moves the exact
identity to `REVOKED`, marks its Account `DELETION_PENDING`, and revokes every
local application session without deleting financial or audit history.

### Management API reconciliation

Create a dedicated Logto Machine-to-Machine application and assign the
preconfigured Management API access role with the `all` permission. Inject its
credentials only into workflow-runner:

```dotenv
LOGTO_MANAGEMENT_APP_ID=<m2m-app-id>
LOGTO_MANAGEMENT_APP_SECRET=<m2m-app-secret>
LOGTO_MANAGEMENT_API_RESOURCE=https://default.logto.app/api
LOGTO_RECONCILIATION_POLL_MS=900000
```

For Logto OSS, the default Management API resource indicator is
`https://default.logto.app/api`; API traffic itself uses the configured trusted
Logto endpoint/backchannel. The runner requests `scope=all` through client
credentials, fetches `/api/users` using bounded `page` / `page_size`
pagination, and applies lifecycle repair only after a complete listing. The
`logto-identity-reconciliation` OperationalWorkerCheckpoint participates in
runner readiness. A failed or incomplete listing must be repaired before an
`enforce` rollout.

While `DELEGATE_ACCOUNT_SESSION_MODE=shadow`, collect structured
`account_session_shadow_parity` events from Dashboard and Reps. All mismatches
are logged, match events are deterministically sampled, and no token or
principal material enters the log. Require zero mismatches for the reviewed
observation window before changing to `enforce`.

### PostgreSQL version boundary

Delegate's business database remains PostgreSQL 16. The isolated Logto local
stack uses the reviewed official-example-compatible `postgres:17-alpine`
database image. That is an approved service-specific exception, not a claim
that the entire Delegate stack runs PostgreSQL 17 or that the Logto database
may share the business database.

Before relying on email verification or password recovery, configure and test
an official SMTP or HTTP email connector. Local password-only smoke testing
does not prove email delivery.

## Production deployment contract

Build the production manifest in the deployment repository/platform; do not
promote the local Compose file.

Production requires:

- one permanent HTTPS `ENDPOINT` from the first user, because it determines
  the OIDC issuer;
- a separate HTTPS `ADMIN_ENDPOINT` behind VPN, mTLS, or an independently
  MFA-protected access proxy;
- at least two Logto replicas behind the core load balancer;
- a dedicated PostgreSQL database and least-privilege role;
- PostgreSQL point-in-time recovery, encrypted backups, and restore rehearsal;
- a recovery set that versions the database credential and Secret Vault KEK
  with the matching database snapshot in the secret manager; a database volume
  or dump without that key material is not a recoverable backup;
- the reviewed Logto version pinned by immutable image digest as well as
  release number;
- independently injected `DB_URL`, `SECRET_VAULT_KEK`, application secrets,
  webhook signing secret, and connector credentials;
- `TRUST_PROXY_HEADER=1` only behind a correctly configured HTTPS proxy that
  overwrites forwarded headers;
- an official production email connector and an isolated staging sender;
- immutable connector packages deployed by a single initialization job, plus
  a shared or identically mounted `packages/core/connectors` directory across
  every Logto replica;
- discovery, JWKS, token, callback, email, webhook-lag, and reconciliation
  monitoring.

Initial recovery objectives are RPO at most five minutes and RTO at most sixty
minutes. Record the measured restore time instead of treating backup creation
as restore proof.

Do not expose PostgreSQL or the Admin Console directly to the internet. Do not
share the Delegate application database role with Logto, and never query Logto
internal tables from Delegate.

## Initial production seed

1. Provision the empty database and least-privilege role.
2. Record the database fingerprint and create the first backup/restore proof.
3. Run `npm run cli db seed -- --swe` as a one-shot job using the exact Logto
   application image. Enforce a platform-level singleton/concurrency policy in
   addition to the job's own database or orchestration fence.
4. Start one Logto replica and verify discovery, issuer, JWKS, and Admin access.
5. Deploy connector files through one initialization job, verify that all
   replicas see the same connector directory, create the applications and
   connectors, and store their credentials in the deployment secret manager.
6. Disable direct Admin ingress, start the remaining replicas, and verify
   health through the load balancer.

Do not use `--disable-admin-pwned-password-check` in an internet-connected
production environment. For a deliberately air-gapped environment, document
the exception and compensate with an independently enforced administrator
password policy.

## Upgrade and rollback

Every Logto upgrade is a maintenance event:

1. review release notes and alteration compatibility;
2. test the exact image in staging with restored production-shaped data;
3. record a fresh backup and successful restore proof;
4. stop or drain Logto writers;
5. run `CI=true npm run alteration deploy latest` as exactly one job, fenced by
   the deployment platform's `Forbid`/singleton concurrency policy so two
   replicas cannot alter the schema together;
6. deploy the new image by immutable digest;
7. verify discovery, issuer, JWKS, login, token exchange, logout, Account
   Center, email, and webhooks before restoring full traffic.

An application image rollback does not undo a database alteration. Use the
version's documented forward-compatible rollback when available. Restore the
database only for confirmed corruption, not for an ordinary application
release failure.

Never allow two replicas to run seed or alteration concurrently. A process-local
lock is not a production fence: the deployment platform must serialize the Job
across hosts, and the runbook for that platform must prove the policy before an
upgrade.
