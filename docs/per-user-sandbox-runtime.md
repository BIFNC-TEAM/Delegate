# Per-User Sandbox Runtime

## Product Semantics

Delegate now models computer use as **per-user sandbox identity + on-demand runtime**.

This is not "one always-on VM per audience user." The stable unit is `SandboxIdentity`, keyed by `representativeId + contactId + scopeKey`. A runtime lease starts only when that user needs compute or browser work, then idle cleanup stops the runtime while preserving the identity and provider sandbox handle for the next task.

`SandboxIdentity.audienceIdentityId` is copied from `Contact.audienceIdentityId` when the compute broker creates or reuses a lease. If an anonymous web identity is later merged into a registered Logto identity, later public-cookie reuse resolves to the merge target before compute starts, so the sandbox identity remains attached to the registered audience identity instead of drifting back to the anonymous source.

In plain terms:

- `SandboxIdentity` is the user's long-lived locker.
- `audienceIdentityId` is the cross-channel identity pointer attached to that locker when available.
- `SandboxLease` is the currently running or recently stopped machine lease.
- `ComputeSession` remains the per-request execution record.
- `BrowserSession` still keeps `computeSessionId`, and now also carries optional `sandboxIdentityId` and `sandboxLeaseId` for cross-session browser continuity.

## Runtime Flow

```mermaid
flowchart TD
    Bot["Bot or public runtime requests computer use"] --> CS["Create ComputeSession"]
    CS --> EUS["ensureUserSandboxLease"]
    EUS --> SI["Reserve SandboxIdentity by representativeId + contactId + scopeKey"]
    SI --> SL["Reuse stopped/running SandboxLease or create a new lease"]
    SL --> SP["SandboxProvider adapter"]
    SP -->|"overseas/manual"| Daytona["Daytona code or browser runtime"]
    SP -->|"China/manual"| Tencent["Tencent AGSX code runtime"]
    Daytona --> EX
    Tencent --> EX
    EX --> BS["Record BrowserSession with sandbox identity"]
    BS --> IDLE["Idle cleanup stops runtime after timeout"]
```

## Providers

### Docker compatibility only

Docker is not admissible for new sandbox identities. The persisted `DOCKER` enum value and adapter remain temporarily so already-pinned identities can be stopped, deleted, or drained without corrupting historical rows. Production legacy routing and contactless Docker acquisition fail closed.

### Daytona

Daytona is behind the `SandboxProvider` adapter. Delegate owns policy, approvals, billing, audit, and lifecycle state. Daytona owns sandbox runtime creation, recovery, stop/delete, command execution, browser-image execution, resources, TTL, lifecycle intervals, and runner-enforced network policy.

The adapter intentionally keeps Daytona calls inside `apps/compute-broker/src/sandbox-provider.ts`. Bot, policy, execution, and browser code should not call provider SDKs directly.

### Tencent AGSX

Tencent AGSX is available only in `manual_poc` mode for server-marked test representatives. Phase 1 uses one Code Interpreter Tool through Tencent's E2B-compatible endpoint. Browser, customer workspace hydration, production billing, and automatic regional routing are not enabled by this phase.

Every existing `SandboxIdentity.provider` remains authoritative. Changing the routing document affects only identities that do not exist yet; provider outages never trigger a Docker or cross-cloud fallback.

## Configuration

```bash
# Non-production compatibility only; production rejects legacy mode.
SANDBOX_ROUTING_MODE=legacy
SANDBOX_PROVIDER=tencent

# Enable Daytona when the SDK/config are available
SANDBOX_PROVIDER=daytona
DAYTONA_API_KEY=...
DAYTONA_API_URL=...
DAYTONA_TARGET=...
# Browser/custom-image only. CODE uses Daytona's managed snapshot because
# snapshot creation rejects explicit resource overrides.
DAYTONA_SANDBOX_CPU=2
DAYTONA_SANDBOX_MEMORY_GIB=4
DAYTONA_SANDBOX_DISK_GIB=10
DAYTONA_SANDBOX_TTL_MINUTES=1440

# Side-by-side code PoC. The JSON must contain only sandboxTestEligible
# representatives. Docker must be false and cannot be a default or override.
SANDBOX_ROUTING_MODE=manual_poc
SANDBOX_PROVIDER_ROUTING_JSON='{"version":1,"default":"tencent","newIdentityEnabled":{"docker":false,"daytona":true,"tencent":true},"phase1AllowedRepresentativeIds":["rep_tencent","rep_daytona"],"representatives":{"rep_daytona":"daytona"}}'
TENCENT_AGS_API_KEY=...
TENCENT_AGS_REGION=ap-guangzhou
TENCENT_AGS_CODE_TOOL=delegate-code-v1

# Cost controls
SANDBOX_IDLE_STOP_MINUTES=15
SANDBOX_CLEANUP_INTERVAL_MS=60000
SANDBOX_AUTO_ARCHIVE_MINUTES=10080
SANDBOX_AUTO_DELETE_MINUTES=-1
```

Daytona CODE identities use the provider-managed Python snapshot. The adapter creates `/home/daytona/workspace` through the Toolbox file API, returns it as the provider lease root, and maps the cross-provider virtual `/workspace` path to that directory. Existing Daytona identities are repaired idempotently when their lease is restored. Explicit resource overrides remain available for browser/custom-image sandboxes only.

Strict Delegate network policies require a Daytona Tier 3/4 organization (or another account configuration that permits sandbox-level network overrides). Tier 1/2 organization restrictions keep essential services reachable and reject sandbox-level overrides, so the adapter fails closed before command execution and deletes a newly created sandbox. The smoke test verifies blocked fixed-IP TCP egress rather than relying on DNS failure.

Manual PoC mode fails closed when an enabled cloud provider is missing credentials or Tool configuration. Production also fails closed when routing remains `legacy` or `SANDBOX_PROVIDER=docker`.

Do not log `DAYTONA_API_KEY`, `TENCENT_AGS_API_KEY`, cookies, session tokens, browser credentials, or provider secrets.

## Lifecycle And Cost Controls

The default lifecycle is:

- Create or reuse `SandboxIdentity` on first computer-use request for a contact.
- Start or restore a `SandboxLease` only when compute/browser work is needed.
- Mark the lease `RUNNING` while active.
- Stop the runtime after `SANDBOX_IDLE_STOP_MINUTES`.
- Keep the identity and provider sandbox handle for future reuse.
- Mark provider failures as `ERROR` so cleanup can retry safely.

Stopping a lease must not delete the identity or user data. Archive/delete policy is separate and should only be enabled intentionally.

## Observability

The broker records audit events:

- `SANDBOX_LEASE_STARTED`
- `SANDBOX_LEASE_STOPPED`
- `SANDBOX_LEASE_ERRORED`

The internal metrics endpoint is:

```bash
curl -H "Authorization: Bearer $COMPUTE_BROKER_INTERNAL_TOKEN" \
  http://localhost:4010/internal/compute/sandbox/metrics
```

Provider/configuration readiness is exposed separately from liveness:

```bash
curl http://localhost:4010/ready
```

`/health` remains process liveness. `/ready` returns a degraded response when a pinned provider adapter is missing or the manual PoC representative allowlist is invalid; it never returns credentials.

Current counters:

- `sandbox_identity_upserts_total`
- `sandbox_leases_created_total`
- `sandbox_leases_started_total`
- `sandbox_leases_stopped_total`
- `sandbox_leases_idle_stopped_total`
- `sandbox_leases_errors_total`

## Rollback

Fast rollback:

```bash
SANDBOX_ROUTING_MODE=manual_poc
SANDBOX_PROVIDER_ROUTING_JSON='{"version":1,"default":"tencent","newIdentityEnabled":{"docker":false,"daytona":false,"tencent":true},"phase1AllowedRepresentativeIds":["rep_tencent"],"representatives":{}}'
```

This disables Daytona admission for new identities without changing existing provider pins. There is no Docker rollback path for new production identities.

Full feature rollback should avoid dropping `SandboxIdentity` or `SandboxLease` immediately. Keep the migration data until any provider sandbox cleanup and billing reconciliation are complete.

## Smoke Test

Run focused checks:

```bash
DATABASE_URL=postgresql://delegate:delegate@localhost:5432/delegate \
  ./node_modules/.bin/prisma validate --schema prisma/schema.prisma

apps/compute-broker/node_modules/.bin/vitest run \
  apps/compute-broker/tests/sandbox-schema.test.ts \
  apps/compute-broker/tests/sandbox-provider.test.ts \
  apps/compute-broker/tests/sandbox-leases.test.ts \
  apps/compute-broker/tests/compute-session-sandbox-path.test.ts \
  apps/compute-broker/tests/browser-sandbox-session.test.ts \
  apps/compute-broker/tests/sandbox-cleanup.test.ts \
  apps/compute-broker/tests/sandbox-metrics.test.ts

./node_modules/.bin/tsc --noEmit -p apps/compute-broker/tsconfig.json
```

With a dedicated Tencent test Tool and credentials configured:

```bash
pnpm --filter @delegate/compute-broker smoke:tencent-agsx
```

With Daytona credentials configured:

```bash
pnpm --filter @delegate/compute-broker smoke:daytona
```

The smoke test creates a temporary code sandbox, verifies command output and blocked public egress, reports sanitized timing data, and deletes the sandbox. It never prints the API key.

Manual behavior check:

- A normal chat message should not create a compute session or sandbox lease.
- First computer-use request from a contact should create one `SandboxIdentity` and one `SandboxLease`.
- A second computer-use request from the same contact should reuse the same `SandboxIdentity`.
- A different contact should get a different `SandboxIdentity`.
- Idle cleanup should stop the runtime and leave the identity intact.
