# Development Plan: Phase 0/1 Multi-Provider Sandbox Runtime

Generated on 2026-08-28
Branch: `codex/dashboard-optimization`
Design: `docs/multi-provider-sandbox-design.md`
Status: IMPLEMENTED — TENCENT LIVE SMOKE PASSED; DAYTONA PENDING

## Objective

Implement the approved Phase 0/1 design without changing current customer execution by default:

- preserve the existing Docker/Daytona behavior behind `legacy` routing mode;
- add an explicit `manual_poc` mode for allowlisted test representatives;
- pin every sandbox identity to its creation-time provider;
- add Tencent AGSX as a code-runtime provider through its E2B-compatible endpoint;
- harden Daytona code execution to the same normalized contract;
- record creation attempts durably and prevent ambiguous remote creation from executing;
- verify everything locally with unit, contract, schema, and PostgreSQL race tests;
- run live cloud smoke tests only when credentials and test Tools are present.

## Scope Decision

The approved design already reduced the original production replacement into a bounded Phase 0/1 PoC. Although implementation necessarily touches more than eight files, further file-count reduction would combine schema, provider, configuration, and tests into oversized modules. The plan keeps one new routing module, one Tencent adapter module, and one provider-operation module; all other edits extend existing ownership boundaries.

## What Already Exists

- `SandboxIdentity` and `SandboxLease` persistence.
- Docker and Daytona `SandboxProvider` implementations.
- Per-contact/conversation sandbox scope keys.
- Lease cleanup and provider-specific stop/delete restoration.
- Compute session, approval, billing, audit, and execution fencing.
- S3-compatible artifact storage, not used for customer workspace hydration in this phase.
- Vitest unit tests and PostgreSQL integration-test conventions.

## Runtime Modes

```text
SANDBOX_ROUTING_MODE=legacy (default)
    |
    +-- existing identity --> stored provider
    +-- new identity ------> existing SANDBOX_PROVIDER behavior

SANDBOX_ROUTING_MODE=manual_poc
    |
    +-- existing identity --> stored provider only
    +-- absent identity
          |
          +-- representative not test-eligible/allowlisted --> reject
          +-- allowlisted --> manual default/override --> pin once
```

`manual_poc` is opt-in. This prevents the code deployment itself from becoming a production cutover.

## Implementation Sequence

### Step 1 — Database foundation

Files:

- `prisma/schema.prisma`
- new forward-only migration under `prisma/migrations/`
- `apps/compute-broker/tests/sandbox-schema.test.ts`

Changes:

- Add `TENCENT` to `SandboxProviderKind`.
- Add `SandboxRuntimeClass { CODE BROWSER }`.
- Add `SandboxProviderOperationState` and `SandboxProviderOperationKind`.
- Add server-only `Representative.sandboxTestEligible Boolean @default(false)`.
- Add `SandboxIdentity.lifecycleEpoch Int @default(1)`.
- Add `SandboxLease.identityLifecycleEpoch Int @default(1)` and `runtimeClass`.
- Add `ComputeSession.runtimeClass`.
- Add `SandboxProviderOperation` with unique creation key and lease/attempt/operation constraint.
- Backfill runtime class from known browser base image/session evidence; use CODE only for provably non-browser rows and fail the migration if ambiguous rows remain.

Verification:

- Prisma validation/generation.
- Schema contract tests.
- Migration SQL inspection and migration fixture where practical.

### Step 2 — Routing configuration

Files:

- new `apps/compute-broker/src/sandbox-routing.ts`
- `apps/compute-broker/src/config.ts`
- new `apps/compute-broker/tests/sandbox-routing.test.ts`

Changes:

- Parse `SANDBOX_ROUTING_MODE=legacy|manual_poc`.
- Parse versioned `SANDBOX_PROVIDER_ROUTING_JSON` with duplicate-key detection, maximum size/count, provider validation, default/override/admission consistency, and canonical SHA-256 digest.
- Separate configured adapters from new-identity admission.
- Resolve override by immutable representative ID.
- Validate allowlist membership and expose a database-readiness validator.
- Preserve legacy defaults when mode is omitted.

Verification:

- Valid default/override routing.
- Malformed/duplicate/oversized JSON.
- Disabled default or override.
- Docker rejected in `manual_poc` production configuration.
- Unknown/non-test representatives rejected by readiness.

### Step 3 — Provider contract and registry

Files:

- `apps/compute-broker/src/sandbox-provider.ts`
- new `apps/compute-broker/src/tencent-agsx-provider.ts`
- new `apps/compute-broker/src/sandbox-provider-registry.ts`
- `apps/compute-broker/src/runner.ts`
- `apps/compute-broker/tests/sandbox-provider.test.ts`
- new `apps/compute-broker/tests/tencent-agsx-provider.test.ts`
- new shared provider contract test

Changes:

- Extend provider kind to Docker, Daytona, and Tencent.
- Add runtime class, creation key, network/filesystem contract, timeout, working directory, independent output limits, and typed termination.
- Add sanitized provider-error taxonomy.
- Centralize adapter construction/readiness in one registry.
- Harden Daytona mappings:
  - `no_network -> networkBlockAll`;
  - working directory passed to `executeCommand`;
  - command timeout passed in seconds;
  - output callbacks enforce independent byte limits;
  - missing credentials never fall back in manual mode.
- Implement Tencent code adapter using `@e2b/code-interpreter` against `E2B_DOMAIN=<region>.tencentags.com`:
  - create/connect/kill lifecycle;
  - command execution with cwd and timeout;
  - streaming stdout/stderr limits;
  - metadata/creation key where supported;
  - sanitized E2B error mapping.
- Keep vendor clients behind injected narrow interfaces for deterministic tests.

Verification:

- Shared contract suite for Docker, Daytona, and Tencent fakes.
- Provider-specific mapping and error tests.
- No-network and output-limit behavior proven by fakes locally; live proof remains a promotion gate.

### Step 4 — Immutable identity reservation and operation journal

Files:

- `apps/compute-broker/src/sandbox-leases.ts`
- new `apps/compute-broker/src/sandbox-provider-operations.ts`
- `apps/compute-broker/src/leases.ts`
- `apps/compute-broker/src/executions.ts`
- `apps/compute-broker/tests/sandbox-leases.test.ts`
- new operation-journal tests
- PostgreSQL identity-race integration test

Changes:

- Existing identity lookup precedes new-identity routing.
- Remove provider from ordinary identity updates.
- Lock identity rows and fence lifecycle with `lifecycleEpoch`.
- Create identity with conflict-safe insert; winner's stored provider is authoritative.
- Record `SANDBOX_IDENTITY_CREATED` only for the winning insert.
- Persist provider creation journal before remote create.
- Bind remote runtime only if identity epoch and lease state remain current.
- Classify definite failure, ambiguous result, quarantine, and resolved states.
- Provider execution, cleanup, and restart always instantiate the stored provider.
- No cross-provider or Docker fallback in manual mode.

Verification:

- Override change does not move an existing identity.
- Concurrent creators with different routing converge on one provider.
- Archive/delete race loses the bind fence and cleans up/quarantines remote runtime.
- Disabled provider remains usable for existing pins but not new identities.
- Ambiguous create cannot execute until reconciled.

### Step 5 — Runtime class and readiness wiring

Files:

- `apps/compute-broker/src/sessions.ts`
- `apps/compute-broker/src/index.ts`
- relevant serializers/protocol schemas and tests

Changes:

- Determine immutable runtime class from server-validated requested capabilities.
- Copy runtime class to leases and provider operations.
- Keep Phase 1 admission CODE-only.
- Add local adapter/readiness snapshots without exposing credentials.
- Make liveness independent from remote provider availability; readiness reports degraded configured/pinned providers.

Verification:

- Browser request rejected in `manual_poc` Phase 1.
- Existing legacy browser sessions remain compatible.
- Readiness cache and stale refresh behavior tested with fake clock.

### Step 6 — Deployment configuration and documentation

Files:

- `.env.example`
- `compose.yml`
- `deploy/staging/stack.yml`
- `docs/per-user-sandbox-runtime.md`
- `README.zh-CN.md` where necessary
- `apps/compute-broker/package.json` and `pnpm-lock.yaml`

Changes:

- Pass routing, Daytona, and Tencent variables to compute-broker.
- Add `@e2b/code-interpreter` dependency.
- Document legacy/manual modes, test representative marking, manual override changes, rollback, and credential handling.
- Document live smoke prerequisites and commands without secrets.

## Data Flow

```text
create ComputeSession
      |
      v
derive runtimeClass (CODE in Phase 1)
      |
      v
lookup SandboxIdentity tuple
      |
      +-- existing --> validate stored provider --> reserve same-provider lease
      |
      +-- absent --> test eligibility + allowlist
                        |
                        v
                 resolve routing snapshot
                        |
                        v
                 conflict-safe identity insert
                        |
                        +-- lost race --> reload winner provider
                        |
                        v
                 create STARTING lease + operation journal
                        |
                        v
                 provider.start(creationKey)
                        |
             +----------+-----------+
             |                      |
          definite                 ambiguous
          success/fail             result
             |                      |
      fenced bind/FAILED          UNKNOWN
             |                      |
             v                      v
         execute only          quarantine/reconcile
         after BOUND           never execute UNKNOWN
```

## Code Path Coverage

```text
[+] routing parser
    ├── valid legacy/manual configurations                 [UNIT]
    ├── duplicate/malformed/oversized JSON                [UNIT]
    ├── default/override points to disabled provider       [UNIT]
    └── production Docker admission                        [UNIT]

[+] identity selection
    ├── existing ACTIVE pin ignores changed routing        [UNIT + PG]
    ├── absent + allowlisted override/default              [UNIT]
    ├── absent + non-test representative                   [UNIT]
    ├── ARCHIVED/DELETED identity                           [UNIT]
    └── concurrent insert/delete/config change             [PG INTEGRATION]

[+] remote create journal
    ├── BOUND success                                      [UNIT]
    ├── definite FAILED                                    [UNIT]
    ├── ambiguous UNKNOWN                                  [UNIT]
    ├── duplicate/quarantine                               [UNIT]
    └── crashed owner lease reclaim                        [UNIT + PG]

[+] provider execution
    ├── cwd + timeout                                      [SHARED CONTRACT]
    ├── stdout/stderr independent byte limits              [SHARED CONTRACT]
    ├── no-network mapping                                 [PROVIDER UNIT + LIVE]
    ├── typed/redacted errors                              [UNIT]
    └── stop/delete idempotency                            [SHARED CONTRACT]

[+] user-visible flow
    ├── allowed test representative completes code task    [INTEGRATION]
    ├── disallowed representative gets explicit denial     [INTEGRATION]
    ├── pinned provider unavailable gets retryable error    [INTEGRATION]
    └── no cross-cloud fallback after outage               [INTEGRATION]
```

## Failure Modes and Required Evidence

| Failure | Handling | Test |
|---|---|---|
| malformed routing config | startup error | unit |
| override typo/customer representative | readiness failure | unit/integration |
| rolling deploy routes same identity differently | unique winner provider | PostgreSQL race |
| remote create times out ambiguously | UNKNOWN + quarantine | fault injection |
| remote succeeds after identity archived | bind fence fails; cleanup | race test |
| provider credentials invalid | degraded readiness, no fallback | unit/live |
| output exceeds cap | terminal output-limit result | contract |
| command exceeds timeout | terminal timeout, no retry | contract/live |
| stored provider disabled for new identities | existing pin still works | integration |
| provider disappears | explicit pinned-provider error | integration |

## Performance Plan

- No new per-command database lookup beyond the existing lease load; provider routing occurs only during identity/lease acquisition.
- Cache static parsed routing configuration for process lifetime.
- Cache remote capability probe for five minutes and local provider-reference readiness for 90 seconds.
- Index operation journal by state/deadline and provider operation ID.
- Live benchmark: 5 warm-ups excluded, then at least 100 sequential and 20 concurrent executions per provider.
- Capture cold-start p50/p95/p99, warm dispatch overhead, success rate, quarantine/orphan convergence, and estimated cost.

## Verification Commands

```bash
pnpm db:generate
pnpm db:validate
pnpm --filter @delegate/compute-broker typecheck
pnpm --filter @delegate/compute-broker test
pnpm typecheck
pnpm test
git diff --check
```

Live smoke commands are executed only when the corresponding API key, endpoint/region, and test Tool are configured. Secret values are never printed.

## NOT in Scope

- geographic/tenant/health/price routing;
- automatic provider failover;
- migration of existing identities;
- browser and All-In-One parity;
- customer workspace hydration;
- production billing reconciliation;
- customer data-residency/cross-border design;
- Dashboard provider controls;
- production Docker cutover.

## Completion Gate

- All local schema, routing, identity, journal, registry, adapter, and contract tests pass.
- Full typecheck passes.
- No existing Docker/Daytona tests regress in legacy mode.
- Manual mode cannot route non-test representatives or silently fall back.
- Live provider smoke status is reported separately as passed or blocked by missing external credentials/capabilities.
- Final diff review finds no unresolved P0/P1 issues.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | Infrastructure-only change; not required |
| Codex Review | `/codex review` | Independent second opinion | 0 | — | Final diff review scheduled after implementation |
| Eng Review | `/plan-eng-review` | Architecture & tests | 1 | CLEAR | Scope reduced to Phase 0/1; code-path and failure coverage defined; 0 unresolved decisions |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | No UI scope |

**VERDICT:** ENG CLEARED — ready to implement.

## Implementation Result

- Added manual `legacy | manual_poc` routing with versioned, duplicate-safe configuration parsing.
- Added immutable Provider pinning for `SandboxIdentity`; routing changes affect only absent identities.
- Added Tencent AGSX/E2B code adapter and centralized Docker/Daytona/Tencent registry.
- Hardened Daytona no-network, working-directory, timeout, and output-limit mappings.
- Added runtime class, lifecycle epoch, provider operation journal, deadline CAS, quarantine loop, and safe public errors.
- Added `/ready` configuration/pinned-provider diagnostics without credential disclosure.
- Added and applied migration `20260828122000_multi_provider_sandbox_phase1` locally.
- Added sanitized Tencent live smoke command: `pnpm --filter @delegate/compute-broker smoke:tencent-agsx`.

Verification:

- `pnpm typecheck`: 19/19 tasks passed.
- `pnpm exec turbo run test --concurrency=2`: 26/26 tasks passed.
- compute-broker: 49 files passed, 272 tests passed, 4 conditional skips.
- Prisma schema validation, Docker Compose config validation, and `git diff --check` passed.
- Local PostgreSQL confirms `DOCKER | DAYTONA | TENCENT`, operation table availability, and 101 historical sessions backfilled to `CODE`.
- Tencent AGSX live smoke passed against `delegate-code-v1`: 798 ms start, 251 ms command execution, no-network egress blocked, and zero residual running smoke instances.
- Manual-PoC broker integration passed against published representative version 8: a new contact-scoped `SandboxIdentity` and `SandboxLease` were both pinned to `TENCENT`, the lease enforced `NO_NETWORK + EPHEMERAL_FULL`, the remote sandbox was created, and the governed Python execution completed with exit code `0` before the session was released.
- Fixed Compose startup handling for blank optional Daytona URL/resource variables; blank strings are now treated as unset and covered by two regression tests.

Final review auto-fixed five findings: lock-after-read staleness, Provider-construction orphan state, late remote response deadline fencing, sandbox public error mapping, and stale runtime documentation. No unresolved P0/P1 findings remain.

TurnPlan V3 follow-up: the server now binds only an explicitly marked, user-grounded command (`执行命令：...`, `run command: ...`, inline code span, or shell code fence) when the Planner emits an empty `argumentsJson`. An LLM-selected source span alone is never sufficient; unmarked or explicitly negated natural-language requests remain fail-closed and are never converted into shell commands.

Public end-to-end verification passed after the fix: a new website conversation produced a governed `compute.exec` action, waited for Owner approval, executed on a `TENCENT` lease with `NO_NETWORK + EPHEMERAL_FULL`, returned stdout `delegate-tencent-e2e-ok` with exit code `0`, composed the result into the public reply, and released the test session.

Follow-up verification: model-runtime 195/195 tests passed; the full repository test graph passed 26/26 tasks after the command-binding trust-boundary review.

External verification still required: Daytona live smoke cannot run until Daytona credentials are configured.

## Cloud-Only Sandbox Follow-up — 2026-08-31

Goal: new agent sandbox identities use only Tencent or Daytona. Docker remains a stored-provider compatibility adapter solely for already-pinned identities and local provider unit tests; it is not an admissible provider for any new identity or production legacy routing.

Implementation decisions:

- Keep `DOCKER` in the persisted Prisma enum until existing identities and leases are drained; deleting the enum first would make historical rows unreadable.
- Reject Docker as routing default, override, or enabled new-identity provider in every environment.
- Reject production `legacy` mode and production `SANDBOX_PROVIDER=docker`; cloud routing is mandatory.
- Remove the contactless Docker acquisition fallback. New compute execution without a Contact fails closed instead of opening a host Docker container.
- Keep the Docker adapter only for stop/delete/restore of historical pins during the drain window.
- Promote Daytona SDK `0.200.0` to the authoritative integration: atomic create options, resource/lifecycle settings, code and browser runtime classes, network block/full/domain-or-CIDR allowlists, activity refresh, recovery, wait-for-delete, typed error mapping, and independent output normalization.
- Persist the normalized network allowlist plus a policy hash on each lease so a policy change can never reuse a sandbox created under a different egress contract.
- Add a minimal Daytona code smoke independent of OpenCode/browser credentials; live execution remains blocked until `DAYTONA_API_KEY` is supplied.

NOT in scope:

- rewriting historical `DOCKER` rows to a cloud provider without an explicit migration/runbook;
- automatic geographic routing or cross-provider failover;
- sharing one runtime instance between Tencent and Daytona;
- production secret mounting into Daytona;
- removing Docker from local Compose infrastructure used to build and test the application itself.

Implementation result:

- New identity routing accepts only `daytona | tencent`; Docker defaults, overrides, and enablement are rejected in every environment.
- Production rejects legacy routing, Docker selection, contactless Docker acquisition, ready direct-Docker sessions, and historical Docker identity execution with stable migration-required errors.
- `/ready` reports only cloud providers in `configuredProviders`; historical Docker rows remain visible only in `pinnedProviders`.
- Daytona now uses the official SDK 0.200.0 boundary with deterministic create names, 409 recovery by creation-key label, code/browser classes, atomic resources/lifecycle/TTL/network settings, recovery, activity refresh, terminal delete waits, strict output normalization, and redacted typed errors.
- `SandboxLease` persists normalized network allowlists and a SHA-256 policy hash; legacy leases do not silently satisfy a new policy.
- Local migration `20260831113000_cloud_only_daytona_policy` applied successfully.
- Verification passed: 19/19 typecheck tasks, 26/26 repository test tasks, compute-broker 49 files / 290 tests passed with 4 conditional skips, production Docker build passed, Tencent live smoke passed after cutover, and cloud readiness reported `configuredProviders=[tencent]`.
- Daytona live smoke remains pending because no `DAYTONA_API_KEY` is configured locally.
