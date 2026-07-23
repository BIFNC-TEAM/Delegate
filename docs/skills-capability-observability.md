# Skills, MCP, and approval observability

The owner dashboard exposes a read-only workspace capability health snapshot:

```text
GET /api/dashboard/representatives/:slug/capability-health
```

The endpoint requires the same owner-to-representative access check as the rest
of the dashboard. Its response is `private, no-store`; it never includes MCP
URLs, credentials, request payloads, commands, or raw transport errors.

The HTTP status remains `200` for `healthy`, `degraded`, and `critical`
snapshots. Monitoring should inspect the JSON `status` and `alerts` fields.
Authentication, missing workspace, and unexpected server failures continue to
use their normal non-2xx status codes.

## Signals and sources

| Signal | Source | Scope |
| --- | --- | --- |
| Active installs, stale candidates, rejected releases, missing installed release | PostgreSQL skill lifecycle rows | Workspace |
| Runtime trust blocks and unexpectedly enabled bindings | Installed release trust evidence plus representative bindings | Workspace |
| Pending, stale, expired, skill, and action approvals | PostgreSQL approval rows | Workspace |
| MCP consecutive failures and last success/failure time | PostgreSQL MCP binding rows | Workspace |
| Recent MCP executions and failed executions | PostgreSQL tool execution rows | Workspace |
| Registry sync and release-review API failures | Dashboard process-local counters | Owner, with a representative fallback in local demo mode |

The database-backed signals are durable and replica-independent. The technical
skill-operation counters deliberately follow the existing Compute sandbox
metric pattern and do not require a new schema or dependency. They reset on
dashboard process restart and are not aggregated across replicas. Production
alerts should therefore combine this endpoint with centralized structured
application logs until durable metric export is added.

Raw MCP failure messages are never returned. The snapshot exposes only a
normalized prefix such as `mcp_timeout` or `mcp_server_unavailable`.
Skill-operation failures likewise emit a redacted structured log with only the
operation, tenant scope, representative slug, timestamp, and a stable category
such as `network_error`, `trust_validation_failed`, or `state_conflict`. Raw
exception messages are neither stored in the process counter nor returned by
the health endpoint.

## Default thresholds

| Threshold | Default | Result |
| --- | ---: | --- |
| Observation window | 24 hours | Applies to operation failures, release rejection, and MCP executions |
| Skill operation failures | 3 | Critical; 1–2 are degraded |
| Candidate awaiting review | 24 hours | Degraded |
| Approval age | 30 minutes | Degraded |
| Pending approvals | 10 / 20 | Degraded / critical |
| Enabled MCP binding without a success | 15 minutes | Degraded after the grace period |
| MCP consecutive failures | 3 | Critical circuit-open candidate; 1–2 are degraded |
| Runtime-untrusted release with an enabled binding | 1 | Critical |
| Expired approval still pending | 1 | Critical |
| Active install without an installed release | 1 | Critical |

`mcp.consecutive_failures_critical` is an alerting threshold, not an automatic
runtime circuit breaker. It intentionally does not change calls or bindings.
Operators should disable the affected binding while investigating. A real
half-open/closed circuit state requires a separate runtime policy and
multi-replica state design.

## Alert handling

1. Treat `runtime_trust.enabled_binding_blocked`,
   `approvals.expired_pending`, and `skills.installed_release_missing` as
   immediate governance incidents.
2. For `mcp.consecutive_failures_critical`, disable or pause the binding, then
   check endpoint availability, credential status, and network allowlist
   policy. Do not repeatedly retry a state-changing tool.
3. For approval backlog alerts, drain the oldest and highest-risk decisions
   first and verify the expiration workflow.
4. For skill operation failures, correlate the timestamp with structured
   dashboard errors. Re-run Registry discovery only after the exact-version
   trust or network cause is understood.
5. A runtime-trust block with no enabled binding is expected fail-closed
   behavior. It remains degraded so operators can resolve or archive the
   install.

## Query example

With an authenticated owner session:

```sh
curl --fail --silent \
  http://localhost:3001/api/dashboard/representatives/lin-founder-rep/capability-health
```

An alerting probe should fail when `.status == "critical"` and retain the
returned `alerts[].code`, `count`, and `recommendedAction` in the incident.

## Current limitations and next steps

- Export process-local counters to the deployment's metric collector before
  relying on them in a multi-replica production environment.
- Add a durable skill-operation failure event only with an explicit retention,
  tenant-isolation, and sensitive-error redaction design.
- Add a real MCP circuit breaker only after the open, half-open, reset, and
  state-changing retry semantics are agreed.
- Load-test the approval counts and owner relation filters against production
  cardinality. Existing indexes cover the primary status/time and binding
  lookups, but workspace-wide joins should still be measured.
