# OpenViking Integration

## Purpose

Delegate uses OpenViking as a rebuildable context projection for public
representatives on Web, Matrix, and Telegram.

It is used for:

- representative public resources
- representative-scoped audience memory
- representative-scoped agent patterns
- channel-local recall and projection provenance

It is not used for:

- owner private notes
- owner private workspace state
- secrets or credentials
- billing truth
- handoff truth

Postgres remains the transactional source of truth. OpenViking is the context layer.

## Official OpenViking guidance we follow

Delegate follows the current OpenViking server-first model from the official docs and source:

- standalone HTTP service
- `Create -> Interact -> Commit` session lifecycle
- context types: `Resource`, `Memory`, `Skill`
- context layers: `L0`, `L1`, `L2`
- default recall pattern: `L1` first, `L2` only when needed
- OpenClaw Plugin 2.0 used as an architectural reference, not as a code import path

Official references:

- OpenViking README
- OpenViking API overview
- OpenViking configuration guide
- OpenViking deployment guide
- OpenViking session concept docs
- OpenViking context-layer docs
- OpenViking context-type docs

## Delegate-specific implementation choices

### Representative-scoped isolation

Delegate scopes OpenViking state by representative, contact, and source channel.

- resources: `viking://resources/delegate/reps/{slug}/...`
- user memories: `viking://user/memories/.../delegate/{slug}/{contactId}/...`
- agent memories: `viking://agent/memories/.../delegate/{slug}/...`
- session key: a server-generated representative/contact/channel coordinate;
  clients cannot choose or edit it

This is stricter than a generic assistant integration because Delegate must never leak memory across representatives or audience members.

### Postgres provenance

Delegate records search, policy filtering, model injection, final citation, and
projection outcomes in Postgres. These records are operational evidence for
runtime enforcement, reconciliation, and audit.

The normal Owner product surface does not expose raw Recall Trace terminology,
URI, Layer, Score, session identifiers, or provider-internal target paths. Those
details remain restricted to advanced diagnostics and service logs.

### Safe memory filter

Before writing anything to OpenViking, Delegate applies public-safety filtering.

Blocked content includes:

- passwords
- API keys
- credentials
- owner-private notes
- hidden admin context

### Graceful fallback

If OpenViking is down, or if the environment has no real model credentials, Delegate continues using deterministic policy behavior instead of crashing or broadening trust boundaries.

## Deviations from official defaults

### 1. Representative-scoped user identity

OpenViking itself supports account / user / agent scoping. Delegate additionally embeds representative slug and contact identity into URI layout and session keys.

Why:

- prevent cross-representative recall
- prevent cross-contact recall
- keep public-agent trust boundaries obvious and auditable

### 2. Postgres-backed observability

Official OpenViking usage does not require an external provenance table. Delegate adds:

- `ConversationRecallTrace`
- `ConversationCommitTrace`
- `RepresentativeContextSync`
- `OpenVikingMemoryRecord`

Why:

- owner dashboard needs visibility
- debugging trust-boundary issues needs durable provenance

### 3. Local Docker startup without real model credentials

For local Docker ergonomics, the OpenViking container renders a placeholder model API key when no real provider key is present so the service can boot and expose health/docs endpoints.

Delegate does not treat that as a valid credential set:

- dashboard health shows the API is reachable but model credentials are missing
- representative sync is blocked
- capture / recall / commit flows safely no-op

Why:

- keep Docker reproducible
- avoid fake-success memory writes
- preserve safe behavior until the operator provides `OPENVIKING_MODEL_API_KEY`,
  `OPENAI_API_KEY`, or `ARK_API_KEY`

`OPENVIKING_MODEL_API_KEY` and `OPENVIKING_MODEL_API_BASE` are preferred for
knowledge indexing because they keep OpenViking provider credentials isolated
from Delegate's primary model runtime.

## Docker services

Local Compose services:

- `openviking` on `http://localhost:1933`
- `openviking-console` on `http://localhost:8020/docs`

The config template lives at:

- `deploy/openviking/ov.conf.example`

Apple Silicon development uses `deploy/openviking/Dockerfile`, a thin image
over OpenViking `v0.4.12` that pins `cryptography` to an ARM64-compatible wheel.
This avoids the upstream image's `SIGILL` startup failure under Docker Desktop.

The runtime renders that template into:

- `/etc/openviking/ov.conf`

The server runs in root-key-protected `trusted` mode. Delegate supplies explicit
account and user headers on every tenant-scoped request; the root key authenticates
the internal caller without granting ROOT access to tenant data APIs.

## Dashboard surface

OpenViking is a rebuildable projection, not an Owner-editable source of truth. The Dashboard exposes memory controls only through **Digital Representatives → Configuration → Memory**:

- governed Contact Memory and Representative Experience policy;
- independently configurable Web, Matrix, and Telegram channel-local recall/extraction capability;
- fail-closed private-channel disclosure, verified binding, first-message exclusion, edit/redaction, and deletion diagnostics;
- retention and expiry behavior;
- OpenViking projection status and synchronization policy as read-only diagnostics.

Owners cannot edit arbitrary Agent IDs or target URIs. Public knowledge import, editing, representative binding, draft work, and publishing stay in Knowledge Library. The former top-level Memory System, manual review, training, and `/openviking` management routes have been removed.

## Verification checklist

Expected local verification:

- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- `pnpm docker:up`
- `curl http://localhost:1933/health`
- `curl http://localhost:8020/health`

For real memory sync and recall, also set one of:

- `OPENVIKING_MODEL_API_KEY` with `OPENVIKING_MODEL_API_BASE`
- `OPENAI_API_KEY`
- `ARK_API_KEY`
