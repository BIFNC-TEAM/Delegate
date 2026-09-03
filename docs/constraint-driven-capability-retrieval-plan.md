# Constraint-Driven Capability Retrieval and Recovery Plan

Status: APPROVED
Branch: `codex/dashboard-optimization`
Date: 2026-09-01

## Goal

Replace brittle intent-box routing with a composable source-requirement pass that participates in capability retrieval for every TurnPlan V3 turn. Keep strict evidence validation, but ensure ordinary recoverable misses end in an answer, clarification, approval wait, or explicit capability limitation instead of a generic strict-plan failure.

## Scope

This change adds no market-data provider, no unrestricted Web access, no new database model, and no new policy authority. It reuses the existing capability catalog, semantic contracts, provider fallback chain, knowledge fallback policy, action fencing, and evidence validator.

```text
user message
    |
    v
strict source-requirement inference (untrusted model output)
    |
    +-- unavailable/invalid --> full catalog, existing authority defaults
    |
    v
server-schema validation --> capability retrieval --> TurnPlan V3
                                                   |
                                                   v
                                      execute verified sources/actions
                                                   |
                         +-------------------------+------------------+
                         |                                            |
                  evidence satisfied                         source miss/unavailable
                         |                                            |
                         v                                            v
               strict response.compose               server-owned recovery outcome
                         |                               answer / clarify / limitation
                         v                                            |
                 evidence validation                                v
                         |                                  terminalize plan + run
                         v
                    delivery
```

## Existing Components Reused

- `CapabilitySemanticRequirementV3` already models operations, evidence classes, freshness classes, and authority classes.
- `retrieveCapabilityCandidatesV3` already filters and ranks the full small catalog from semantic requirements.
- TurnPlan V3 already validates selected capability semantics, provenance, DAGs, availability, and evidence.
- `knowledgeFallbacks` already authorizes stable-general fallback only for server-approved goals.
- `completeTerminalDelegationFailure` already provides an evidence-independent system-message boundary.
- `failActiveV3InlinePlanExecution` already fences and closes active inline attempts.

## Implementation

1. Add a strict source-requirement inference contract in model-runtime. It produces composable semantic dimensions, never capability names, policy decisions, or authority grants.
2. Run that inference before V3 candidate retrieval. Invalid/unavailable inference falls back to full-catalog retrieval, not to an answer.
3. Require accepted planner goals to remain compatible with any inferred non-empty semantic dimensions.
4. Before composing, detect unsatisfied required evidence after source execution. Use an explicit deterministic recovery message and skip the evidence-bound model call.
5. If every composer Provider returns an invalid draft, close the plan and return a reason-specific deterministic message; never publish the invalid draft.
6. Treat failed read-only inline model/knowledge calls as terminal failures rather than reconciliation-required unknown external effects.
7. Centralize V3 public recovery messages and remove duplicate generic strict-plan messages made unreachable by the new recovery path.

## Security Boundaries

- Requirement inference may narrow candidate retrieval but cannot publish capabilities, grant data scopes, lower approval, or authorize stable-general fallback.
- The server-owned source-authority boundary remains authoritative.
- Live, transactional, Owner-specific, and external facts still require matching evidence.
- Strict evidence ID, class, goal ownership, action-result, and freshness validation remain unchanged.
- If no eligible source exists, the response states the limitation; it never invents a result.

## Test Coverage

```text
SOURCE REQUIREMENT INFERENCE
  valid stable/general requirement ................ unit
  valid live/external requirement ................. unit + eval
  malformed/provider failure ...................... unit
  classifier cannot name/grant a capability ....... unit

CAPABILITY RETRIEVAL + PLAN VALIDATION
  inferred live requirement removes stable KB ..... unit
  planner cannot downgrade live to stable ......... regression
  no compatible capability produces limitation .... integration

EXECUTION RECOVERY
  knowledge miss + stable fallback ................ integration
  knowledge miss + no fallback .................... regression
  composer invents evidence refs ................... regression
  provider chain exhausts .......................... regression
  read-only failure terminalizes Plan/Action ....... integration
  loading/run state reaches a terminal status ...... integration
```

## Failure Modes

| Failure | Handling | User outcome |
|---|---|---|
| Requirement model unavailable | Full catalog; existing server authority remains | Planner continues safely |
| Requirement proposal invalid | Ignore proposal and record diagnostic | Planner continues safely |
| No compatible current source | Do not call composer | Explicit current-source limitation |
| Knowledge miss, stable fallback allowed | Existing stable-general composer path | Disclosed general answer |
| Knowledge miss, fallback denied | Do not call composer | Explicit authorized-source limitation |
| Composer evidence invalid | Reject draft and terminalize | Explicit response-generation limitation |
| Read-only Provider outcome unknown | Fail terminally; no reconciliation hold | Loading clears; retry remains possible |

## NOT in Scope

- A real `market.read` or general `web.retrieve` provider; it needs a separately published read-only source with availability and evidence contracts.
- Unrestricted sandbox networking.
- Skill execution publication; installed Skill metadata still lacks the immutable Runner publication required by V3.
- Multi-action natural-language `compute.task`; its first release remains one self-contained Python action.
- Removing V2/shadow modes while they remain supported deployment rollback paths.

## Engineering Review Summary

- Step 0: scope reduced to semantic retrieval, deterministic recovery, and state cleanup; no fake live-data implementation.
- Architecture: requirement inference is advisory/narrowing only; server authority and evidence validation remain final.
- Code quality: one inference module and one centralized recovery helper; no new service or persistence model.
- Tests: unit, integration, regression, and live eval coverage required for every branch above.
- Performance: one small classifier call per active V3 turn; provider fallback is bounded and the input excludes catalog/history payloads.
- Critical gaps: none accepted; every recoverable failure must produce a terminal user outcome.
- Lake Score: 4/4 complete recommendations selected.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | 4 issues resolved, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | Backend/state-only; no visual redesign |

**VERDICT:** ENG CLEARED — ready to implement.
