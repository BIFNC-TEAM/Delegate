# Per-User Sandbox Runtime

## Product Semantics

Delegate now models computer use as **per-user sandbox identity + on-demand runtime**.

This is not "one always-on VM per audience user." The stable unit is `SandboxIdentity`, keyed by `representativeId + contactId`. A runtime lease starts only when that user needs compute or browser work, then idle cleanup stops the runtime while preserving the identity and provider sandbox handle for the next task.

In plain terms:

- `SandboxIdentity` is the user's long-lived locker.
- `SandboxLease` is the currently running or recently stopped machine lease.
- `ComputeSession` remains the per-request execution record.
- `BrowserSession` still keeps `computeSessionId`, and now also carries optional `sandboxIdentityId` and `sandboxLeaseId` for cross-session browser continuity.

## Runtime Flow

```mermaid
flowchart TD
    Bot["Bot or public runtime requests computer use"] --> CS["Create ComputeSession"]
    CS --> EUS["ensureUserSandboxLease"]
    EUS --> SI["Upsert SandboxIdentity by representativeId + contactId"]
    SI --> SL["Reuse stopped/running SandboxLease or create a new lease"]
    SL --> SP["SandboxProvider adapter"]
    SP -->|"default/fallback"| Docker["Docker runtime keyed by sandbox identity"]
    SP -->|"configured"| Daytona["Daytona runtime"]
    Docker --> EX["Execute command/browser action"]
    Daytona --> EX
    EX --> BS["Record BrowserSession with sandbox identity"]
    BS --> IDLE["Idle cleanup stops runtime after timeout"]
```

## Providers

### Docker fallback

Docker remains the default provider. It now uses the stable sandbox identity key when running through the sandbox path, so local development does not require Daytona.

### Daytona

Daytona is behind the `SandboxProvider` adapter. Delegate owns policy, approvals, billing, audit, and lifecycle state. Daytona owns sandbox runtime creation, restore, stop, and command execution.

The adapter intentionally keeps Daytona calls inside `apps/compute-broker/src/sandbox-provider.ts`. Bot, policy, execution, and browser code should not call provider SDKs directly.

## Configuration

```bash
# Default: docker
SANDBOX_PROVIDER=docker

# Enable Daytona when the SDK/config are available
SANDBOX_PROVIDER=daytona
DAYTONA_API_KEY=...
DAYTONA_API_URL=...
DAYTONA_TARGET=...

# Cost controls
SANDBOX_IDLE_STOP_MINUTES=15
SANDBOX_CLEANUP_INTERVAL_MS=60000
SANDBOX_AUTO_ARCHIVE_MINUTES=10080
SANDBOX_AUTO_DELETE_MINUTES=-1
```

If `SANDBOX_PROVIDER=daytona` is set without `DAYTONA_API_KEY`, compute-broker falls back to Docker instead of breaking local development.

Do not log `DAYTONA_API_KEY`, cookies, session tokens, browser credentials, or provider secrets.

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
SANDBOX_PROVIDER=docker
```

This keeps the schema and sandbox identity data but routes new runtime work through Docker fallback. Existing `ComputeSession` records remain compatible because `sandboxLeaseId` is optional.

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

Manual behavior check:

- A normal chat message should not create a compute session or sandbox lease.
- First computer-use request from a contact should create one `SandboxIdentity` and one `SandboxLease`.
- A second computer-use request from the same contact should reuse the same `SandboxIdentity`.
- A different contact should get a different `SandboxIdentity`.
- Idle cleanup should stop the runtime and leave the identity intact.
