# ADR: Unified Conversation Platform and Channel Boundaries

- **Status:** Accepted for implementation
- **Date:** 2026-07-23
- **Owners:** Delegate product and engineering
- **Supersedes:** Telegram-first channel assumptions in earlier architecture and roadmap documents

## Context

Delegate already has three different kinds of public entry:

- Web chat, where Delegate owns the session and delivery path;
- native Matrix rooms, where a Matrix Application Service can ingest and deliver events;
- Telegram, where the existing grammY runtime owns Telegram-specific commands, callbacks, deep links, and Stars payments.

Treating Matrix as a mandatory hub for Telegram would add Synapse and a Telegram bridge to every Telegram message path without removing Telegram-specific identity, Bot API, command, callback, payment, refund, and support responsibilities. It would also make Matrix availability a prerequisite for Telegram availability.

At the same time, allowing each adapter to own identity, conversation state, generation, billing, and handoff produces duplicated business behavior and inconsistent policy enforcement.

The architecture therefore needs one business runtime without pretending that all external protocols are the same.

## Decision

### 1. PostgreSQL and the Conversation Platform are business truth

All public channels use the same channel-neutral acceptance and processing path:

```text
Provider event
  -> provider proof and origin idempotency
  -> channel availability policy
  -> audience identity resolution
  -> Message + GenerationRun + Outbox transaction
  -> pinned-version worker
  -> provider adapter delivery, retry, and dead letter
```

PostgreSQL owns business messages, episodes, generation runs, policy decisions, handoffs, service entitlements, and audit. Provider timelines remain delivery evidence; neither Matrix nor Telegram becomes the business source of truth.

### 2. `transport` and `sourceProvider` are separate concepts

- `sourceProvider` identifies where the audience interaction originated and which provider semantics apply.
- `transport` identifies how Delegate received or delivered the event.

Examples:

| Audience interaction | `sourceProvider` | `transport` |
| --- | --- | --- |
| Delegate public web chat | `WEB` | `WEB` |
| Native Matrix room | `MATRIX` | `MATRIX` |
| Direct Telegram Bot API | `TELEGRAM` | `TELEGRAM` |
| Telegram portal carried through a Matrix bridge | `TELEGRAM` | `MATRIX` |

Changing the transport must not change the external source, user identity, payment rules, analytics attribution, retention obligations, or conversation ownership.

### 3. Matrix is an optional channel and transport, not a mandatory Telegram hub

Native Matrix remains a supported product channel. A Telegram-to-Matrix bridge may be evaluated behind a per-representative feature flag, but it is not required for Telegram and it must have a direct Telegram fallback during migration.

Matrix rooms, virtual users, ghosts, and puppets are delivery identities. They are not Delegate account identities and are never sufficient evidence for account linking.

### 4. External identities bind directly to `AudienceIdentity`

Verified provider subjects bind to one canonical `AudienceIdentity`:

```text
Web / Logto subject ──────┐
Matrix MXID ──────────────┼─> verified IdentityLink -> AudienceIdentity
Telegram numeric user id ┘
```

Binding requires provider-specific proof. Cross-channel identity is never inferred from display name, username, email-like text, room membership, Matrix ghost, or Telegram profile metadata.

Link grants must be short-lived, single-use, hashed at rest, audience- and provider-bound, and audited. An already-linked provider subject cannot be silently reassigned. Anonymous-to-authenticated consolidation may be automated after proof; registered-to-registered merges require an explicit conflict flow and financial reconciliation.

Raw conversations remain source-specific even when two source identities resolve to the same `AudienceIdentity`. Approved service entitlement and public-safe long-term memory may be shared according to policy.

### 5. Payment rails remain provider-specific; service entitlement is unified

Delegate separates:

- money and provider settlement;
- the service entitlement granted to an audience member for one representative.

Web checkout credits the entitlement through the Web payment rail. Telegram Stars credits the same entitlement model through the Telegram rail when paid digital service is offered inside Telegram. CNY, USD, and XTR are never converted into one fungible balance, and refunds return through the original rail.

The target entitlement key is at least:

```text
AudienceIdentity + Representative + Product/Service
```

It must not be a representative-wide token pool that one audience member can consume on behalf of another.

If a release chooses Web-only payment, Telegram must remain free/discovery/notification-only for paid features and move the paid interaction to Web. Web payment must not be used to bypass Telegram's in-platform rules for digital goods and services.

### 6. The first channel migration is private-chat, plain-text only

The first production migration covers:

- Web chat;
- native, unencrypted Matrix direct rooms;
- direct Telegram private chat through a thin Telegram adapter;
- optionally, a private-chat/plain-text Telegram bridge canary after the direct adapter is stable.

The first migration does not promise group semantics, media parity, reactions, typing state, read receipts, encrypted bridge rooms, history import, full puppeting, multiple owner bots, or multiple homeservers.

The compatibility identity index remains globally unique by provider subject.
Issuer and connection mismatches fail closed, but the first release therefore
supports one configured Telegram bot realm and one configured Matrix
Application Service realm. Multi-bot or multi-realm identity is a later
contract migration, not a metadata-only configuration change.

### 7. Every channel uses one availability and human-control contract

Inbound acceptance, generation, and outbound delivery all enforce the same current-state checks:

- representative lifecycle and published version;
- channel desired state and observed health;
- active runtime policy overlays;
- human takeover state;
- service entitlement where required.

Pausing a channel or representative must stop new generation across every adapter without requiring a new representative version.

## Migration and rollback

The migration is incremental:

1. Record this decision and align product documentation.
2. Add typed source/transport, channel-state, identity, entitlement, and idempotency invariants.
3. Move Telegram business behavior onto the shared Conversation Platform while keeping grammY as a provider edge.
4. Complete native Matrix provisioning, asynchronous inbox processing, retry, and dead-letter behavior.
5. Run any Telegram-to-Matrix bridge as a private, plain-text, per-representative canary.
6. Replace channel dashboard mock data with observed health and control APIs.
7. Remove legacy Telegram-shaped required fields only after parity and rollback windows close.

During migration:

- only one adapter may own ingestion, generation, and delivery for a provider conversation;
- direct Telegram remains the fallback until a bridge canary proves delivery, identity, and loop safety;
- dual-write/backfill jobs are restartable and idempotent;
- provider origin IDs and migration high-water marks are retained;
- legacy readers remain usable until reconciliation passes.

A failed canary rolls back by disabling its feature flag, restoring the last active adapter owner, and replaying durable pending events from the recorded high-water mark. Rollback must not regenerate already-completed replies.

## Required invariants

- One provider event can create at most one accepted business message.
- One accepted audience message can create at most one active generation result.
- One outbound business message can be delivered multiple times only as retries of the same provider operation.
- Bridge echo and history backfill cannot create new audience messages or model runs.
- A provider subject cannot authenticate a different `AudienceIdentity` without explicit, verified relinking.
- Service balance and usage are audience-scoped, atomic, append-only, and auditable.
- Edits and redactions require proof that the provider actor may modify the original message.
- Unknown room or portal mappings are quarantined/retried, not permanently ignored.
- Paused, unpublished, or human-controlled conversations cannot start an AI generation.

## Consequences

### Positive

- Web, Matrix, and Telegram share business behavior without coupling all availability to Matrix.
- Telegram-specific commands, callbacks, deep links, Stars, and provider support stay at the correct edge.
- A future bridge can be tested without changing identity, entitlement, analytics, or policy semantics.
- Channel migration remains reversible.

### Costs

- Delegate must maintain provider adapters and a source/transport mapping contract.
- Identity proof, entitlement accounting, reconciliation, and channel health become explicit domain work.
- A bridge does not remove the need for a Telegram sidecar when Telegram-native features are used.

## Alternatives rejected

### Matrix as the mandatory hub for Telegram

Rejected because it adds an availability and operations dependency while preserving most Telegram-specific responsibilities. It may still be useful as an optional operator projection or transport canary.

### Independent business runtime per channel

Rejected because it duplicates generation, billing, policy, handoff, and audit behavior and makes cross-channel identity unsafe.

### Matrix ghosts as Delegate users

Rejected because a transport identity is not evidence of account ownership.

### One fungible Web/Stars wallet

Rejected because provider currencies, settlement, refund, and platform-policy obligations differ. The unified product abstraction is service entitlement, not provider money.

## References

- [Telegram Stars payments](https://core.telegram.org/bots/payments-stars)
- [Matrix Application Service API](https://spec.matrix.org/latest/application-service-api/)
