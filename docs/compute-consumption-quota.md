# Compute admission uses consumption quota

Updated: 2026-09-23.

PASS and DEEP_HELP are retired commercial tiers, not prerequisites for code,
browser, process, or MCP capabilities. Their former compute checks survived
the wallet migration in the rule engine, rule generators, and dashboard
overlay editor. Those active checks and configuration options are removed.

## Authorization order

1. Conversation admission authorizes available consumption quota and stores
   the generation's billing/reservation state on the server.
2. Before creating an audience compute session and again before execution,
   `requireAudienceGenerationRunAuthorization` verifies the active generation,
   audience, representative, conversation, and reservation ownership.
3. A wallet-funded run must have a valid reservation verified against the
   usage and entitlement ledgers. Released, transferred, expired, missing, or
   cross-user reservations fail closed. Existing server-authorized free-use
   runs remain supported; they do not create a membership identity.
4. The capability policy evaluates allowed operations, approval requirements,
   network/filesystem limits and execution budgets. It does not evaluate a
   paid membership tier.
5. Success settles usage; failure/cancellation uses the existing release flow.

The legacy request flag `hasPaidEntitlement` is accepted only for transport
compatibility. It is never trusted as quota authorization. A positive wallet
balance alone is also not sufficient: the current run needs a valid reservation
so concurrent tasks cannot overspend it.

## Migration and compatibility

`20260923160000_retire_compute_plan_tiers` clears `requiredPlanTier` and
`requiresPaidPlan` in existing capability rules. It does not modify rule
decisions or human-approval flags, wallet balances, purchases, historical
orders, or published representative snapshots.

The database compatibility columns and historical pricing enums are retained.
They no longer appear in active compute configuration or influence capability
evaluation. Rule creation, setup saves and seeding persist null/false rather
than recreating old membership gates. Legacy overlay payloads containing a
plan tier are accepted with that obsolete property stripped.

Consumption quota and the automatic-execution Token budget are distinct.
Removing retired plan checks does not disable approval settings, Token limits,
complex-command review, native browser mutation approval, or MCP binding policy.
