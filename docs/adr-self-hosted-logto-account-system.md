# ADR: Self-hosted Logto and Delegate account boundary

## Status

Accepted on 2026-07-29.

This ADR defines the target boundary and rollout contract. It does not claim
that the complete Account, AppSession, or Workspace migration already exists.
Every database change described here must use an expand, shadow, enforce, and
contract sequence.

## Decision

Delegate will run Logto OSS as the credential and OpenID Connect provider.
Delegate remains the source of truth for product accounts, creator admission,
application sessions, workspace membership, business permissions, channel
identity, wallet ownership, and audit.

Each environment has one independent logical Logto instance and issuer:

- development;
- staging;
- production.

Production uses two or more Logto application replicas behind one permanent
issuer domain. The production issuer must not be a temporary deployment URL.

The Logto instance contains three first-party applications:

1. Dashboard Traditional Web application;
2. Public Representatives Traditional Web application;
3. Management API machine-to-machine application.

The Dashboard and Public Representatives applications share Logto users but
have independent client credentials, redirect URIs, and application sessions.
Both confidential applications use a fixed `/auth/callback` under their own
canonical public origin. Public Representatives carries the verified
Representative slug and complete anonymous chat binding inside signed,
ten-minute state; callback routing never trusts Host or unsigned slug/audience
query values. The previous dynamic Reps callback is a deadline-gated,
in-place-only compatibility endpoint for already-issued v1/v2 state.

## Why this boundary

Logto is responsible for:

- credentials and password recovery;
- email, phone, social, passkey, and MFA authenticators;
- OIDC authorization and central sign-in session;
- Account Center credential and authenticator management;
- identity lifecycle events exposed through signed webhooks and the Management
  API.

Delegate is responsible for:

- a stable, provider-independent Account ID;
- deciding whether an authenticated person may enter the Dashboard;
- Creator and Audience product personas;
- local browser/device sessions and immediate product revocation;
- Workspace membership and fine-grained business permissions;
- Representative, channel, contact, wallet, payout, and audit ownership;
- account suspension, deletion workflow, export, and financial retention.

Delegate never queries or writes Logto internal tables. Integration is limited
to OIDC, the documented Management API, signed webhooks, and Account Center.

## Target model

```text
Logto (issuer, subject)
          |
          v
     AuthIdentity ------> Account
                            |
             +--------------+----------------+
             |              |                |
             v              v                v
       Owner / Creator  AudienceIdentity  WorkspaceMembership
       KYC and payee    anonymous/channel          |
                                                  v
                                      Organization (Workspace)
                                                  |
                                                  v
                                           Representative
```

### Account

`Account` is the canonical Delegate person and uses an internal UUID/CUID. It
does not use email or phone as its primary key.

Initial lifecycle states are:

- `ACTIVE`;
- `SUSPENDED`;
- `DELETION_PENDING`;
- `DELETED`.

### AuthIdentity

`AuthIdentity` maps an external principal to one Account. OIDC resolution uses
the exact verified issuer and subject. The storage key includes provider,
issuer, and subject; no path may resolve a Logto identity using subject alone.

Email, phone, and display name are mutable profile claims, not identity keys.
Two principals with the same email or phone are never merged automatically.

### Existing product identities

`Owner` remains during the compatibility window and becomes the
Creator/Payee profile. Its financial relationships, KYC, earnings, and
withdrawal ownership are not moved to Workspace by this migration.

`AudienceIdentity` remains the canonical anonymous and cross-channel identity.
Only a registered canonical AudienceIdentity may receive an optional
`accountId`. Anonymous visitors do not require Account rows.

Telegram, Matrix, payment, and other channel proofs remain `IdentityLink`
records. Only identities that can authenticate a Delegate platform session
belong in `AuthIdentity`.

### Workspace

The existing `Organization` table is the physical Workspace aggregate. Do not
create a parallel Workspace master table. A new Account-based membership model
will replace `OrganizationMember.ownerId` for authorization after a shadow
period.

`Representative.ownerId` remains as a compatibility and creator/payee
reference while `Representative.workspaceId` becomes the tenant authorization
boundary.

## Authentication and admission

Successful Logto authentication does not grant Dashboard access.

Dashboard admission is closed by default:

- an existing Owner identity remains admitted;
- a new Creator requires an explicit invitation, approval, or deployment
  allowlist entry;
- a Public Audience account never becomes a Creator as a side effect of login.

Development bypasses must require both `NODE_ENV=development` and an explicit
development opt-in. Production must fail closed.

The current standards-based OIDC adapter is retained for the first migration.
It must add PKCE S256, exact issuer-aware identity resolution, branded callback
errors, and explicit local/global logout semantics. Replacing it with a Logto
SDK is a separate compatibility decision.

## Public Audience account switching

Public authentication resolves the verified Logto principal first.

- If the principal is already linked, that Account/AudienceIdentity wins.
- The current chat identity may merge into it only when the current canonical
  identity is `ANONYMOUS`.
- A new principal may link to the current identity only when the current
  canonical identity is `ANONYMOUS`.
- A `REGISTERED` identity never silently receives another principal.
- "Sign in", "switch account", and "link another identity" are distinct
  operations. Identity linking requires explicit intent and reauthentication.

Anonymous chat cookies remain Representative-scoped. The authenticated
Audience application session becomes platform-scoped during AppSession v2.

## Application session

Logto central sessions and Delegate application sessions are separate.

`AppSession` uses an opaque random browser token. Delegate stores only a
cryptographic hash and records:

- Account and application kind;
- optional active Workspace;
- Logto session identifier when available;
- issued, last-seen, idle-expiry, and absolute-expiry times;
- revoked time and reason;
- bounded device and user-agent metadata.

Low-risk requests may continue on a valid local session during a temporary
Logto outage. New login, step-up, payout, role changes, security changes, and
other high-risk operations fail closed when their authentication dependency is
unavailable.

The user interface distinguishes:

- sign out of this Delegate session;
- revoke all Delegate sessions;
- end the Logto central browser session.

## Webhook and Management API rules

Webhook ingress verifies the HMAC over the raw body, stores an idempotent
receipt, returns success quickly, and processes asynchronously. Duplicate,
delayed, and out-of-order events are expected.

Periodic reconciliation through the Management API repairs missed events.
Management API calls never sit on the per-request authorization hot path.

The initial revocation propagation objective is p99 within 60 seconds for:

- Logto user suspension or deletion;
- local Account suspension;
- Workspace membership removal;
- explicit AppSession revocation.

## Self-hosting requirements

Production requires:

- a permanent public `ENDPOINT` and a separately protected
  `ADMIN_ENDPOINT`;
- a dedicated Logto PostgreSQL database and least-privilege role;
- version and image digest pinning, never `latest`;
- a production email connector and isolated staging sender;
- runtime secret injection for database URL, application secrets, webhook
  secret, SMTP credentials, session keys, and optional Secret Vault KEK;
- PostgreSQL point-in-time recovery, daily encrypted backup, and restore
  rehearsal;
- health probes for discovery, JWKS, token exchange, email, webhook lag, and
  reconciliation drift;
- a reviewed single-run database alteration job for upgrades.

The initial recovery objectives are RPO at most five minutes and RTO at most
sixty minutes. Redis is not part of the first release; it may be added only
after measurements justify the extra infrastructure.

The Admin Console must not be exposed directly to the public internet. Access
must pass through VPN, mTLS, or an independently MFA-protected access proxy.

## Rollout state machines

Each migration dimension uses a finite state instead of interacting booleans:

```text
legacy -> shadow/compare -> enforce -> contract
```

Required independent modes:

- `identityResolutionMode`;
- `accountSessionMode`;
- `logtoIssuerMode`;
- `workspaceMembershipMode`;
- `representativeAuthorizationMode`;
- one scope mode per directly Workspace-owned aggregate.

Rollout cohorts are sticky by Account or an explicit allowlist. After the
self-hosted issuer creates production users, rollback may redirect the login
entry point, but Delegate must continue accepting and resolving both known
issuers until those accounts are migrated or retired.

## Migration dependency order

```text
current P0 guards
  -> issuer-safe legacy identity
  -> Account/AuthIdentity shadow
  -> AppSession v2
  -> self-hosted issuer traffic
  -> Account-based Workspace membership
  -> Representative workspace authorization
  -> remaining Workspace aggregates
  -> team UI and lifecycle
  -> contract cleanup
```

Infrastructure for the self-hosted instance may be built in parallel, but it
receives no production traffic until issuer-safe identity and the first
Account/AppSession path are ready.

## Non-goals

This migration does not:

- rename the `Owner` or `Organization` physical tables;
- move Creator earnings, KYC, withdrawals, or historical ledgers to Workspace;
- merge accounts using email or phone;
- adopt Logto Organizations, SCIM, or Enterprise SSO in the first release;
- build custom password, MFA, passkey, or recovery implementations;
- rewrite existing object-storage or OpenViking namespaces;
- place the Logto Management API on a request hot path;
- delete compatibility fields before two stable releases and zero observed
  parity drift.

## References

- <https://docs.logto.io/logto-oss/deployment-and-configuration>
- <https://docs.logto.io/logto-oss/upgrading-oss-version>
- <https://docs.logto.io/sessions>
- <https://docs.logto.io/end-user-flows/sign-out>
- <https://docs.logto.io/developers/webhooks>
- <https://docs.logto.io/integrate-logto/interact-with-management-api>
- <https://docs.logto.io/end-user-flows/account-settings/by-account-center-ui>
