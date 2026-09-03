# Natural-Language Sandbox Task Compiler Plan

Status: APPROVED
Branch: `codex/dashboard-optimization`
Date: 2026-09-01

## Goal

Allow an audience user to request a self-contained computation in natural language without supplying a shell command. The system must still preserve TurnPlan V3 grounding, representative capability policy, approval, billing, audit, provider pinning, sandbox isolation, and verified-result composition.

Example first-release task:

```text
请在沙箱里计算 1 到 1000 之间的所有质数，并给出数量和前 20 个结果。
```

The first release compiles this objective into bounded Python code. It does not grant a model general-purpose shell, network, credential, attachment, or durable-workspace authority.

## Scope Decision

Keep the existing `compute.exec@1` command capability unchanged. Add the planner-only `compute.task@1` capability with a grounded natural-language `instruction`; the central capability compiler maps it to the existing governed `exec` execution and approval boundary. A separate versioned Task Compiler produces Python source and a server-owned command wrapper only after the V3 plan has been validated and persisted.

This avoids a new database model, provider API, capability enum, approval system, or sandbox protocol.

## Existing Components Reused

- TurnPlan V3 selects, validates, persists, supersedes, and fences capability actions.
- Capability publication and compilation already bind immutable definition and argument hashes.
- `ComputeDelegationTask` already stores the objective, ordered request, resource policy, and execution status.
- Compute policy already maps `exec` to representative-owned `allow | ask | deny` modes; the default is `ask`.
- Compute Broker already owns sessions, approval, timeout, output limits, path normalization, billing, audit, and sandbox leases.
- `SandboxIdentity.provider` remains authoritative; the compiler never selects Tencent, Daytona, or Docker.
- The existing model-runtime provider/fallback stack is reused for the compiler call.

## Data Flow

```text
untrusted audience message
        |
        v
TurnPlan V3 capability retrieval
        |
        +-- no compute needed ----------------------> ordinary governed response
        |
        v
validated + persisted compute.task action
  arguments: { instruction: <exact user message> }
        |
        v
Sandbox Task Compiler v1
        |
        +-- insufficient/unsupported --------------> clear no-execution failure
        |
        v
strict JSON parse + Python safety validation
        |
        v
server builds base64 Python command
        |
        v
existing capability mode + Broker policy
        |
        +-- deny -----------------------------------> blocked
        +-- ask ------------------------------------> existing approval flow
        +-- allow ---------------------------------->
                                                     governed Compute execution
                                                               |
                                                               v
                                                   verified result + Composer
```

## Compiler Contract

Compiler input:

```ts
type SandboxTaskCompilerInputV1 = {
  instruction: string;
  maxCodeBytes: number;
};
```

Compiler proposal:

```ts
type SandboxTaskCompilerProposalV1 =
  | { needsExecution: false; reason: string }
  | {
      needsExecution: true;
      summary: string;
      language: "python";
      riskClass: "self_contained_compute";
      code: string;
    };
```

Compiled metadata persisted with the delegation request:

```ts
type CompiledSandboxTaskMetadata = {
  compilerVersion: "sandbox-task-compiler.v1";
  instructionHash: string;
  codeHash: string;
  riskClass: "self_contained_compute";
  compilerProvider?: string;
  compilerModel?: string;
};
```

The generated command uses base64 payload transport so model output never enters shell quoting syntax directly.

## Safety Rules

The compiler accepts only self-contained Python computations whose complete data is present in the message. It rejects or declines:

- network, URLs, browsers, downloads, sockets, HTTP clients, or remote APIs;
- credentials, environment-variable access, subprocesses, shells, package installation, dynamic imports, or native extensions;
- file reads/writes and attachment claims in the first release;
- persistence, database access, messaging, payments, or any external side effect;
- `eval`, `exec`, `compile`, `__import__`, reflection/dunder access, or interactive input;
- code over the configured byte limit, control characters, and malformed model output.

The sandbox remains the second containment boundary; compiler validation is not treated as a substitute for `NO_NETWORK`, ephemeral filesystem policy, timeout, or output limits.

## Approval and Risk

No new approval engine is introduced.

```text
compiled compute.task -> execution capability=exec -> published capability mode
                                      |
                                      +-- deny  -> no session
                                      +-- ask   -> Owner approval
                                      +-- allow -> automatic execution
```

This keeps risk authority server-owned and representative-version-pinned. The Task Compiler may classify only `self_contained_compute`; it cannot lower a representative's `ask` or `deny` ceiling.

## Failure Modes

| Failure | Handling | Test | User-visible outcome |
|---|---|---|---|
| V3 does not select Compute | Ordinary response path | candidate/processor tests | Normal answer |
| Compiler model unavailable | Fail closed; no legacy generated shell | model-runtime test | Retry message |
| Invalid JSON | Reject proposal | parser test | No-execution failure |
| Unsupported code/import | Reject before session creation | safety table tests | Unsupported task message |
| Compiler returns oversized code | Reject before persistence/execution | size-bound test | Narrow-task message |
| Approval required | Existing pending-approval workflow | processor regression | Approval card/status |
| Approval denied or stale | Existing execution fence | existing regression suite | Denied/canceled status |
| Sandbox/provider unavailable | Existing typed provider error | existing broker tests | Provider unavailable |
| Command timeout/output limit | Existing terminal execution result | existing broker tests | Explicit failure |
| Duplicate worker delivery | Existing plan/action/idempotency fence | existing concurrency tests | One execution |

## Test Coverage Plan

```text
CODE PATH COVERAGE
==================
[+] Compiler proposal parser
    ├── valid self-contained Python ................ unit
    ├── no-execution proposal ....................... unit
    ├── malformed JSON/schema ....................... unit
    └── excessive code/output fields ................ unit

[+] Python safety validator
    ├── permitted math/statistics/json code ......... unit
    ├── network/socket/HTTP imports ................. unit
    ├── subprocess/os/environment/files ............. unit
    ├── dynamic execution/dunder access ............. unit
    └── control characters / byte ceiling ........... unit

[+] TurnPlan V3 bridge
    ├── exact instruction grounding ................. unit
    ├── compiler success -> base64 exec request ...... integration
    ├── compiler refusal -> no Compute session ....... integration
    ├── capability ask -> pending approval ........... regression
    └── explicit /compute remains unchanged .......... regression

USER FLOW COVERAGE
==================
[+] Natural-language calculation ................... [EVAL + integration]
[+] Explanation-only question stays conversational . [EVAL]
[+] Network/file/external-effect request is refused . [EVAL + unit]
[+] Missing task details produce no execution ....... [EVAL]
```

## Performance

- The compiler adds one model call only after a persisted V3 action selects `compute.task`.
- Compiler input is limited to the current instruction and a small server-owned contract; it does not receive the whole capability catalog or conversation history again.
- Code and response byte limits are fixed and validated before command construction.
- No additional database query or remote provider call is added before approval.

## Rollout

1. Land parser, safety validator, and tests.
2. Publish V3 `compute.task@1` only when representative natural-language delegation is enabled; keep `compute.exec@1` for explicit commands.
3. Activate through existing `TURN_PLAN_V3_MODE=active_governed` and per-representative `delegation.naturalLanguageEnabled`.
4. Keep `exec=ask` for the first canary representative.
5. Run prompt evals and one Tencent synthetic task after explicit approval.
6. Only then consider `exec=allow` for narrowly scoped representatives.

## NOT in Scope

- Attachment or artifact hydration; it requires the provider-neutral workspace transport design.
- Browser, URL, MCP, payment, messaging, or other external-effect task synthesis.
- Multi-step generated plans; one compiled Python program is the first-release atomic action.
- Package installation and arbitrary shell generation.
- Changing provider routing or `SandboxIdentity` pinning.
- Changing default representative approval modes.
- Daytona activation while strict network policy remains unsupported by the current organization tier.
- UI changes.

## Engineering Review Summary

- Step 0: Scope reduced to one self-contained Python action and existing `compute.exec` authority.
- Architecture Review: 2 issues resolved — no parallel policy engine; compiler runs only after persisted V3 validation.
- Code Quality Review: 2 issues resolved — versioned dedicated compiler module; server-owned base64 command construction.
- Test Review: all new branches listed above are required in this change, including prompt eval cases.
- Performance Review: 1 issue resolved — the second model call is conditional and bounded.
- Failure modes: no silent untested failure is accepted.
- Lake Score: 5/5 complete recommendations selected within the reduced slice.
