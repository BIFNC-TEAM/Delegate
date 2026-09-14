# Pi Agent rearchitecture

This is the implementation and continuation record for the Pi Agent migration.
The acceptance source is `agent-regression-test-spec.md`, SHA-256
`bab859de44974ca77006fa948ef7b05b14a844943160bbfac0eac0cef832a468`.

## Runtime decision

Delegate embeds the official Pi libraries rather than wrapping the legacy
Planner/Composer pipeline:

- `@earendil-works/pi-agent-core@0.85.1`
- `@earendil-works/pi-ai@0.85.1`
- `typebox@1.3.7`

The former `@mariozechner/pi-agent-core` package is deprecated and points to
the Earendil Works namespace. Pi's `Agent` class owns model turns, automatic
tool execution, parallel independent calls, steering/follow-up queues, and
cancellation. Delegate supplies business adapters and persistence only.

## New request path

```text
Web / Matrix / Telegram input
  -> existing authentication, tenant, version and conversation fences
  -> Conversation Worker
  -> DelegatePiAgentRuntime
       -> one direct model turn for ordinary questions
       -> optional knowledge / MCP / Skill / sandbox / handoff tools
       -> Pi continues from real tool results until a final answer
  -> completeInlineGenerationRun
       -> message, citations, artifacts, handoff and billing state
       -> contextSnapshot.agentTrace (events + spans + TTFT + tokens)
  -> existing channel delivery and Web SSE terminal snapshot
```

`resolveConversationWorkerConfig()` always resolves `agentRuntimeMode=pi`.
The old conversation processor, V2/V3 model Planners, Composer, source
requirement model, TurnPlan persistence service and inline-action audit chain
have been physically removed. New production inputs execute only through
`processNextPiConversationWork` and `DelegatePiAgentRuntime`.

The non-persistent representative demo route also invokes Pi directly. It
returns `503 pi_model_unavailable` or `502 pi_run_failed` instead of silently
falling back to the old Agent framework.

## Capability adapters

| Capability | Production adapter | Completion truth |
|---|---|---|
| Authorized knowledge | `recallRepresentativeContext` with `PUBLIC_KNOWLEDGE` scope | Generation-scoped Memory UseRun and cited item IDs |
| Current/external data | Published MCP tools, including current-data providers | Actual server/tool result and source coordinate |
| MCP | Pinned representative bindings and existing Compute Broker execution | Returned business state; approval/wait state is not success |
| Skill | Search enabled pinned Skill metadata, then load one selected version | `skill.loaded` is separate from subsequent execution |
| Sandbox | Isolated Compute Broker session with structured `write -> exec -> write artifact` steps | Successful execution plus verified stdout persisted as the requested artifact |
| Artifact | Existing Compute artifact/download contract | Artifact ID plus product URL returned by the broker |
| Human handoff | `ensureConversationLeadAndHandoff` | Real queued/active state; completion reuses the request atomically |

`WorkspaceSkillRelease` stores immutable instructions, their SHA-256 and
version-pinned resources. Published snapshots include the body only when the
digest verifies; the runtime records the digest/resource count without storing
the body in operational telemetry. The built-in spreadsheet recovery additionally
requires its server-known version, digest and resource URI to match exactly.
Third-party Skill execution remains fail-closed until an equally immutable,
trusted body is installed; the runtime does not infer trust from a Skill name.

## Runtime events and timing

The canonical runtime emits:

`request.accepted, model.started, model.first_event, response.delta,
retrieval.completed, skill.discovered, skill.loaded, tool.started,
tool.completed, tool.failed, sandbox.started, sandbox.completed,
artifact.created, handoff.updated, run.completed, run.failed, run.cancelled`.

Every observable boundary records a monotonic span with trace/run/case IDs,
parent relationship, module, operation, logical call, attempt, offset,
duration, status, provider/model/tool/Skill coordinates, retry wait, tokens and
result reference when available. Parent self-time subtracts the union of child
intervals. Parallel call durations are deliberately not summed as request wall
time. Provider-internal or sandbox-internal phases that are not exposed remain
N/A rather than fabricated as zero.

Production completion stores the bounded operational trace under
`GenerationRun.contextSnapshot.agentTrace`. It contains no hidden reasoning,
credentials, raw tool arguments or large tool output.

## Regression commands

```bash
pnpm test:agent:contract
pnpm test:agent:smoke
pnpm test:agent:full
pnpm test:agent:live
pnpm test:agent:performance
pnpm test:agent --suite regression --id KB-01,BOX-01
pnpm test:agent --suite smoke --baseline reports/agent-regression/<run>.json
pnpm test:agent:stack:up
pnpm test:agent:stack:seed
pnpm test:agent:smoke:product
pnpm test:agent:stack:ps
pnpm test:agent:stack:down
```

The versioned catalog contains all 90 case coordinates. The 15 required smoke
cases have controlled fixtures and hard result/path assertions. Smoke uses a
real configured model; knowledge, weather, MCP and handoff use controlled
test adapters, while sandbox code is actually executed in a restricted
temporary fixture process. `ARCH-03` requires `AGENT_TEST_BASE_URL` and
`AGENT_TEST_DATABASE_URL` pointing at the guarded isolated stack. It verifies
HTTP/SSE output, downloaded CSV bytes, the persisted Pi trace, successful
MCP/EXEC/WRITE evidence and absence of a legacy DelegationTask on the Pi path.
`live` never falls back to mocks.

Every run writes JSON, JUnit XML, Markdown and HTML under
`reports/agent-regression/`. Reports include strict outcome counts, failure
reasons, per-case evidence, spans, module aggregates, slowest cases and only
comparable baseline changes. Missing modules render as “未调用”; unavailable
submeasurements render N/A.

`compose.agent-test.yml` defines the isolated product stack used by ARCH/live
tests. It uses project `delegate-agent-test`, host ports 13002/14010/14040,
separate Postgres/MinIO/OpenViking volumes, and distinct image/container names.
`stack:down` deliberately preserves volumes; removal is a separate explicit
operator decision.

## Phase record

### 1. Inventory and baseline — complete

- Old persistent path: public route -> inbox/outbox -> conversation worker ->
  V2/V3 Planner -> three-phase action authorization/approval -> Compute or
  inline execution -> separate Composer -> delivery.
- Old demo path: deterministic `createConversationPlan` ->
  `generateRepresentativeReply`.
- Reused services: conversation/version fences, OpenViking recall, MCP/Compute
  Broker, artifacts, handoff, channel delivery and tenant/auth isolation.
- Baseline `pnpm test`: failed in `web-data` because the pre-existing empty
  migration directories `20260903123000_tencent_all_in_one_runtime` and
  `20260907112000_pi_gateway_call_reservations` have no `migration.sql`.
  Before that failure, `model-runtime` had 222 pass/10 skip, `runtime` 137 pass,
  and `web-data` 1704 pass/1 fail/180 skip.

### 2. Minimal Pi path and instrumentation — complete

- Pi owns the real loop and emits text/tool lifecycle events.
- Direct answer, one tool call, multiple parallel calls, bounded retries,
  max steps, cancellation, steering and follow-up are implemented.
- Deterministic timing/report contracts have executable tests.

### 3. Capability adapters — implemented with stated external limits

- Knowledge, published MCP, selected Skill metadata, Compute sandbox/artifacts
  and real handoff requests are wired.
- Direct public web search has no existing trusted product service; current
  data is available through published MCP tools. A live provider must be
  configured and verified before that path can pass live tests.
- Immutable Skill bodies, SHA-256 verification and pinned resources are present.
  The built-in spreadsheet path is product-verified; untrusted or ambiguous
  third-party bodies remain unavailable rather than falling back to summaries.

### 4. Combined execution — implemented and product-validated

- Pi supports dependent multi-turn tool continuation and parallel independent
  tool calls.
- Existing Compute Broker continues to enforce idempotency and result
  verification. Pi never retries an unclassified write. Individual Pi Compute
  calls do not create or reuse the legacy one-task-per-generation
  DelegationTask, so MCP and sandbox steps can run in one Pi-owned loop.
- The production sandbox adapter writes the program into its isolated
  workspace, executes it with a simple interpreter command, and persists
  verified stdout as the one requested output. Missing stdout or multiple
  requested outputs fail closed.
- Active run cancellation and message steering APIs are present. Cross-process
  cancellation still relies on the existing durable task cancellation path.

### 5. Cleanup and acceptance — core runtime cleanup complete; final regression pending

- The production scheduler now imports only `processor-pi.ts`. That processor
  directly owns outbox delivery, GenerationRun leasing, Pi execution and the
  knowledge/MCP/Skill/sandbox/handoff adapters; it does not import the legacy
  processor or invoke V2/V3 Planner/Composer code.
- `TURN_PLANNER_V2_MODE`, `TURN_PLAN_V3_MODE`,
  `TURN_PLAN_V3_ACTIVE_RELEASE_APPROVED` and `PENDING_CLARIFICATION_MODE` were
  removed from Compose, `.env.example` and the production config schema.
  Supplying one now fails startup with a retirement error.
- `pnpm agent:pi:legacy-preflight` is a read-only release gate. The isolated
  database passed with zero active old plans, delegation tasks, delegated
  GenerationRuns, legacy workflows and legacy approvals. The separate six
  active Pi/handoff GenerationRuns were reported as observations and were not
  mutated.
- `processor-legacy.ts`, `legacy-config.ts`, the 9,271-line old processor test,
  V2/V3 Planner/Composer implementations and tests, TurnPlan persistence,
  V3 inline-action audit services and their tests have been deleted. Current
  Pi worker tests cover the production path, outbox delivery, status command,
  legacy-generation rejection and timing persistence; lower business fences
  remain covered in web-data, Matrix and Compute Broker suites.
- Compute Broker no longer imports old PlanAction authorization/terminalization
  services. A minimal generation lease fence remains only to reject/contain
  pre-Pi delegated sessions during rolling migration; Pi sessions never set a
  DelegationTask coordinate.
- `WorkspaceSkillRelease` now stores optional immutable instructions,
  `instructionsSha256` and resources. Published representative snapshots carry
  the body only when its SHA-256 matches; Pi Skill loading uses that body before
  the summary. The isolated `pi_6` representative version was newly published
  (not mutated) and verified with a 231-character body, digest
  `466c5f1f629df8d0decc05d74ea966aca7c693c00c0fb664661578322272f7b9`
  and one version-pinned resource.
- Skill load telemetry records only the verified digest and resource count,
  never the instruction body. Product ARCH-03
  `agent-regression-2026-09-09T01-22-03-134Z.*` passed in 28.3 s while asserting
  the persisted `skill.loaded` event carried that digest and one resource.
- Product attachment execution now loads the GenerationRun's trusted
  MessageAttachment objects, revalidates size and SHA-256, and transfers bytes
  through a dedicated Broker session-input endpoint. Docker receives the bytes
  over stdin at `/workspace/inputs/<safe-name>`; attachment bodies never enter
  ToolExecution commands or model context. The endpoint enforces 10 MB per
  file, 20 MB per message in the worker loader, a 15 MB request ceiling and an
  exact checksum. Input transfer now goes through the selected SandboxProvider:
  Docker streams stdin, Tencent AGSX uses the installed E2B-compatible
  `files.write/read(format=bytes)` API, and Daytona uses
  `uploadFile/downloadFile`. Both cloud paths re-read remote bytes and fail
  with `TRANSFER_INTEGRITY` on any mismatch.
- The first base64-via-ToolExecution prototype was rejected after a real
  420 KB input exceeded that path and would have duplicated private bytes into
  execution records. The replacement Broker endpoint streams Docker input over
  stdin and creates no ToolExecution for transfer; `session-inputs.ts` owns
  file-name, base64, byte-length, checksum, session-authority and provider
  checks.
- CHAT-02 now has a real multipart product path. After fixing stale same-name
  artifacts and retryable FAILED SSE snapshots, report
  `agent-regression-2026-09-09T01-50-27-076Z.*` passed 1/1 in 32.2 s with an
  object-store verified input, pinned Skill digest, one final downloadable CSV,
  four Shenzhen rows and total 850.
- During CHAT-02 validation, attempt 1 briefly reached GenerationRun FAILED
  while its Outbox remained retryable; the SSE stream incorrectly disconnected
  before attempt 2 completed. `getPublicGenerationRunSnapshot` now reports
  `processing` for that state. After deploying the rebuilt isolated Reps
  server, the product test passed with one final 104-byte CSV instead of two
  stale same-name candidates.
- A 10,000-row product PERF-04 attempt
  (`agent-regression-2026-09-09T01-57-42-903Z.*`) no longer failed at the old
  oversized ToolExecution WRITE boundary. In that sample the real model did
  not call Skill or sandbox at all, so the runtime returned a safe partial
  answer and no artifact; this remains a model-routing reliability failure.
- A second bounded attachment escalation was added and contract-tested: after
  an ignored first correction, Pi receives one final instruction requiring its
  next turn to be a tool call. The contract suite is now 27/27. The real
  qwen-plus PERF-04 sample `agent-regression-2026-09-09T02-06-47-500Z.*`
  still made zero tool calls after both corrections, so the runtime correctly
  returned an unfinished message. Further prompt escalation is rejected as an
  optimization path; recovery must use a version-pinned, server-validated Skill
  resource for safely compilable CSV operations.
- The bounded recovery is now implemented. It accepts exactly one CSV, one
  explicit output CSV, the declared `quantity*unit_price-refund_amount`
  workflow and its required output header. It recomputes the installed Skill
  digest, requires the exact built-in resource URI, emits data-derived Python
  without golden result values, and invokes the existing production sandbox
  adapter. Requests outside that grammar remain partial/unfinished.
- Sandbox attachment calls must select a current attachment and contain an
  actual `open`, `readFileSync`, `createReadStream` or bounded shell read of its
  `/workspace/inputs/<name>` path. A model program that merely prints expected
  values is rejected before execution. Two failed attachment sandbox attempts
  stop model self-retry; the two runtime corrections remain bounded, after
  which only the trusted recovery may run. A successful recovery can finish
  after the ordinary Pi step budget is exhausted, but never after cancellation,
  timeout or another model/runtime error.
- Product validation exposed and fixed a strict-wire bug: the object-store
  attachment record carried a database `id`, which was accidentally serialized
  into the Broker's strict input schema. `uploadAudienceComputeInput` now
  projects only `fileName`, `mimeType`, `sizeBytes`, `checksum` and `base64`.
  The regression test proves extra record fields never cross the wire.
- The final strict PERF-04 product report is
  `agent-regression-2026-09-09T02-42-41-636Z.*`: 1/1 PASS in 47.8 s, first
  answer 1.40 s, six real model calls and seven tools. The 10,000-row object was
  downloaded and verified at 100,000 net sales; the successful sandbox program
  declared/read the uploaded path. Persisted spans include
  `skill/load_recovery_resource` and `sandbox/skill_resource_recovery` (585.2
  ms). Product reports now merge the persisted Pi spans, so model/Skill/sandbox
  rows no longer incorrectly display “未调用”. An earlier 42.1 s run that only
  printed prompt-provided golden values is intentionally not treated as valid
  evidence after the stronger read assertion.
- SSE no longer publishes a retryable GenerationRun FAILED attempt as terminal
  while its generation outbox remains pending/processing/failed-but-unprocessed.
  The snapshot reports `processing` until the retry converges; the regression
  found a real attempt-1 failure followed by attempt-2 completion and added a
  24-test source-disclosure/snapshot proof.
- Telegram conversation ownership now accepts only `worker` in every
  environment. Setting `legacy` or `shadow` fails startup even if the former
  diagnostics flag is present; bot mode tests pass 8/8 and worker config tests
  pass 11/11.
- The cleanup removes roughly 37,000 lines of old processor, Planner, Composer,
  TurnPlan persistence, PlanAction admission/verifier and associated tests.
  Current full monorepo typecheck remains 20/20 and the Pi contract is 31/31.
- All 90 catalog cases now have executable paths. `ARCH-04` uses the isolated
  product plus a persistent browser driver; in restricted environments that
  cannot bind the driver port it reports `BLOCKED/BROWSER_DRIVER_UNAVAILABLE`
  rather than falling back to an API-only pass.
  deliberately report `FAIL/NOT_IMPLEMENTED`, not skip.
- The user explicitly approved sending the fictional fixtures to the configured
  Agicto/Bailian test model and creating the isolated Docker stack. Its seeded
  KB/MCP/Skill records are fictional and its database, artifacts and ports are
  separate from the developer stack.

## Latest verification

- Provider-internal model attempts are now observable without extra calls.
  Production wraps Pi's real `StreamOptions.fetch`; every physical request is
  a child `model/provider_attempt` span keyed by one logical turn, and the
  actual interval before a scheduled retry is a
  `wait/provider_retry_backoff` span. No payload, body or credential is
  recorded. BASIC-01 report
  `agent-regression-2026-09-09T06-23-00-677Z.*` passed with one logical model
  call and one HTTP-200 provider attempt (826.8 ms); contract tests are 32/32.
- Three failures from the first instrumented 90-case run were fixed and passed
  together in `agent-regression-2026-09-09T06-45-10-011Z.*` (3/3). A later
  full candidate reached 89 PASS/1 FAIL, with the sole KB-08 result being a
  correct “does not mean zero leave” answer rejected by an overly narrow
  equivalent-phrasing assertion; KB-08 then passed alone in
  `agent-regression-2026-09-09T07-08-16-596Z.*`.
- The next complete candidate
  `agent-regression-2026-09-09T07-08-33-481Z.*` executed all 90 with browser
  enabled but finished 85 PASS/5 FAIL. The retained failures are substantive:
  SKILL-03 counted a header as a row, SKILL-08 included a cancelled order,
  BOX-03 returned CSV only as stdout instead of a file, FLOW-05 exhausted its
  runtime while attempting files, and ARCH-04 exposed a cancel-versus-late-
  handoff race. This run is not eligible as a performance baseline, so the
  suite correctly remains `NOT_DETERMINED`.
- Complete post-recovery regression
  `agent-regression-2026-09-09T03-20-24-353Z.*`: all 90 cases executed,
  89 PASS, 0 FAIL, 1 BLOCKED, 0 SKIP/REVIEW, strict pass rate 98.89%, total
  1,163,961.9 ms. The only block is ARCH-04 because the command environment
  did not provide a persistent browser driver. Functional remains `FAIL` and
  performance remains `NOT_DETERMINED`; neither status is softened. Slowest
  cases were SKILL-01 (61.1 s), PERF-01 (53.8 s), BOX-05 (52.1 s), CHAT-02
  (50.7 s) and SKILL-04 (46.6 s). Model p50/p95 were 2,352.3/11,649.1 ms;
  sandbox p50/p95 were 94.4/1,070.2 ms. Two product recovery spans totalled
  918.9 ms.
- The only full-run block was subsequently executed with the real persistent
  headless browser driver. ARCH-04 report
  `agent-regression-2026-09-09T03-42-28-462Z.*` passed 1/1 in 29.9 s after
  verifying queued handoff UI, the cancel control, convergence back to
  `busy=false`, and dynamic test-operator takeover. The first browser attempt
  exposed top-level-await incompatibility in the CJS test helper; wrapping it
  in `async main()` fixed the automation without changing product behavior.
  Combined evidence therefore covers all 90 cases, while the original 90-case
  report remains immutable at 89 PASS + 1 BLOCKED.
- Tencent AGSX live smoke was repeated after adding the provider-level input
  contract. A temporary `delegate-code-v1` sandbox in
  `ap-guangzhou.tencentags.com` started in 1,191 ms; its 53-byte CSV was
  uploaded and remotely re-read in 599 ms, Python verified the exact byte
  count/SHA-256 in 251 ms, outbound network access remained blocked, and the
  smoke deleted the remote sandbox in `finally`. No credential value or file
  body was logged. The post-abstraction Docker product PERF-04 report
  `agent-regression-2026-09-09T03-48-32-757Z.*` also passed 1/1.
- Full Tencent product attachment E2E now passes. The isolated representative
  was activated on a newly published immutable `NO_NETWORK + EPHEMERAL_FULL`
  version, and the Broker was switched to `tencent/manual_poc`. The first run
  exposed that command arguments still contained the public `/workspace`
  contract while AGSX uses `/home/user/workspace`; Tencent command mapping was
  fixed and covered by a provider test. Report
  `agent-regression-2026-09-09T08-14-02-476Z.*` then passed PERF-04 end to end
  in 54.1 s: Pi, Broker, TENCENT SandboxIdentity/Lease, input transfer,
  successful WRITE/EXEC, 45-byte CSV artifact and product download. The shared
  remote lease was explicitly released afterward, and the active test version
  and Broker were restored to Pi/Docker.
- The immediately preceding full run
  `agent-regression-2026-09-09T02-48-39-760Z.*` retained 9 failures and one
  browser block. The nine failure IDs were rerun after scoped fixes at 8/9 in
  `agent-regression-2026-09-09T03-12-39-728Z.*`; the remaining corrupt-file
  case passed in `agent-regression-2026-09-09T03-18-24-985Z.*`. The complete
  rerun above then verified all nine in the same 90-case sample.
- `pnpm test:agent:contract`: 31/31 passed.
- Product-backed core smoke
  `agent-smoke-2026-09-09T02-45-20-107Z.*`: 15/15 PASS, 0
  FAIL/BLOCKED/SKIP/REVIEW, strict pass rate 100%, total 176.0 s. It includes
  real-model routing plus isolated product ARCH-03 and reports no comparable
  performance baseline.
- Strict product PERF-04
  `agent-regression-2026-09-09T02-42-41-636Z.*`: 1/1 PASS with internal Pi
  spans merged into the module table and a successful declared attachment read.
- `@delegate/model-runtime`: 114 passed, 4 opt-in evals skipped after removing
  the retired Planner/Composer suites.
- `@delegate/conversation-worker`: 57/57 passed, including the production Pi
  processor and trusted spreadsheet recovery tests.
- `@delegate/reps`: 292 passed after removing the retired progress-contract
  tests.
- `@delegate/web-data`: 1537 passed, 180 integration tests skipped without
  their opt-in services. The migration startup contract passes 2/2 after the
  user-authorized removal of two empty placeholder directories.
- `@delegate/compute-broker`: 245 passed, 4 opt-in tests skipped. The two MCP
  localhost-listener suites were rerun with local bind permission and passed.
- `@delegate/workflow-runner`: 33/33 passed.
- Full monorepo typecheck: 20/20 packages passed after the physical cleanup.
- The earlier structural failure from empty migration directories is resolved.
  Fully parallel `pnpm test` can still time out mock-heavy suites under local
  resource contention; the deterministic package-level reruns pass, and
  `pnpm exec turbo run test --concurrency=1` completed 27/27 tasks successfully
  in 19.0 s. Bot passed 80/80, Compute Broker 284/284 non-opt-in tests, Reps
  294/294 and web-data 1682/1682 non-opt-in tests.
- Post-cleanup product ARCH-03:
  `agent-regression-2026-09-09T00-28-02-268Z.*` — 1/1 PASS in 35.5 s using the
  isolated product, real configured model, MCP, Skill, Docker sandbox and
  artifact download. The immediately preceding read-only migration gate again
  reported zero active legacy blockers.
- Post-cleanup ARCH-02:
  `agent-regression-2026-09-09T00-29-04-016Z.*` — 1/1 PASS.
- Post-cleanup smoke:
  `agent-smoke-2026-09-09T00-29-48-082Z.*` — 15/15 PASS in 208.5 s.
- Post-cleanup complete regression:
  `agent-regression-2026-09-09T00-33-27-816Z.*` — all 90 started; 82 PASS,
  7 FAIL, 1 BLOCKED, 0 SKIP/REVIEW, strict pass rate 91.11%, total 1,221.3 s.
  Focused remediation then passed KB-08, FLOW-04, CHAT-04 and ERROR-08 in
  `agent-regression-2026-09-09T00-55-46-252Z.*`; ERROR-05's real
  `Not a valid ZIP file` result passed separately in
  `agent-regression-2026-09-09T00-57-40-796Z.*` after accepting that semantic
  equivalent. CHAT-02 and PERF-04 still failed strict artifact delivery in
  `agent-regression-2026-09-09T00-58-12-116Z.*`; the runtime returned
  partial/cancelled and exposed no false artifact.
- Controlled real-model smoke report:
  `reports/agent-regression/agent-smoke-2026-09-08T03-35-20-243Z.*` — 14 PASS,
  0 FAIL, 1 BLOCKED (`ARCH-03`), strict pass rate 93.33%. Against the preceding
  comparable real-model run, average model time improved 10.7%, request time
  10.6%, and response-stream time 12.0%; no meaningful regression remained.
- Full 90-case classification report:
  `reports/agent-regression/agent-regression-2026-09-08T05-21-27-495Z.*` —
  23 PASS, 67 FAIL, 0 BLOCKED, strict pass rate 25.56%, total 305642.7 ms.
  Exactly 64 failures are `NOT_IMPLEMENTED`; three are retained real-model
  assertion failures: KB-03 skipped required retrieval and invented internal
  support coordinates, KB-04 treated an underspecified version reference as a
  clarification instead of retrieving, and KB-08 over-interpreted a policy's
  “not applicable” boundary. The successful 15-case smoke run remains the
  functional release signal for the currently implemented core set.
- `@delegate/compute-broker` with loopback permission: 301 passed,
  4 opt-in tests skipped.
- Real product ARCH report:
  `reports/agent-regression/agent-smoke-2026-09-08T04-52-47-914Z.*` — 1 PASS,
  strict pass rate 100%. The product download matched Shanghai 300/1,
  Guangzhou 200/1 and Shenzhen 850/4; persisted evidence showed Pi plus
  knowledge, MCP, Skill and sandbox spans, and no legacy DelegationTask.
- Complete core smoke report:
  `reports/agent-regression/agent-smoke-2026-09-08T05-17-17-956Z.*` — 15 PASS,
  0 FAIL/BLOCKED/REVIEW, strict pass rate 100%, total 234256.0 ms. This is the
  first complete sample in the accurately labelled
  `controlled-dependencies-real-model+isolated-product` mode, so its
  performance conclusion is `NOT_DETERMINED` until a second comparable run.
- Post file-evidence-gate core smoke:
  `reports/agent-regression/agent-smoke-2026-09-08T07-39-48-312Z.*` — 15/15
  PASS, strict pass rate 100%, total 174174.7 ms. This verifies the new
  attachment correction turn did not regress the real product ARCH flow.
- Post production-processor split core smoke:
  `reports/agent-regression/agent-smoke-2026-09-08T09-50-21-813Z.*` — 15/15
  PASS, strict pass rate 100%, total 177822.1 ms. This run used the standalone
  Pi processor after removing all retired Planner variables from Compose.
- Post MCP/handoff evidence-gate smoke:
  `reports/agent-regression/agent-smoke-2026-09-08T06-30-39-300Z.*` — 15/15
  PASS, total 197511.2 ms. The CLI was intentionally run without `--baseline`,
  so the persisted performance conclusion remains `NOT_DETERMINED` even though
  an earlier same-mode report exists; no comparison was fabricated afterward.
- Knowledge source-boundary stability reports:
  `agent-regression-2026-09-08T06-12-16-947Z.*`,
  `agent-regression-2026-09-08T06-12-44-065Z.*` and the post-assertion
  `agent-regression-2026-09-08T06-14-51-022Z.*` each passed KB-03/04/08 at
  3/3. KB-04 is now correctly modeled as an anaphoric multi-turn version check;
  the standalone underspecified wording remains a clarification case.
- BASIC-08 plus WEB-02..08:
  `reports/agent-regression/agent-regression-2026-09-08T06-19-58-382Z.*` —
  8/8 PASS with real model routing and controlled web/MCP evidence.
- MCP-02/03/04/06/07/08 and HUMAN-02/04/05/06/07/08 are executable. The first
  batch report `agent-regression-2026-09-08T06-24-40-052Z.*` passed 11/12 and
  exposed missing inherited arguments in MCP-07; its fixed isolated rerun
  `agent-regression-2026-09-08T06-28-08-591Z.*` passed. A later full-batch run
  retained two history-only false handoff claims; after adding the current-run
  action evidence gate, `agent-regression-2026-09-08T06-29-44-502Z.*` passed
  HUMAN-06/07 at 2/2.
- SKILL-01/03..08 and BOX-03..08 now use generated single-source fixtures and
  real local sandbox processes. The combined report
  `agent-regression-2026-09-08T07-23-18-623Z.*` passed 10/13 and retained three
  useful failures. Subsequent reports verified the fixes: BOX-05 generated a
  decodable PNG plus 400/250/300/400 source CSV, BOX-06 recorded original
  `KeyError: qty` before a 1350 repair, BOX-07 recorded a real 150 ms timeout,
  SKILL-06 enforced the missing-column completion contract, and SKILL-05
  verified zero data rows by actual file read.
  Focused successful evidence includes BOX-05 in
  `agent-regression-2026-09-08T07-13-51-656Z.*`, BOX-07 in
  `agent-regression-2026-09-08T07-13-19-112Z.*`, BOX-06 in
  `agent-regression-2026-09-08T07-19-01-410Z.*`, SKILL-06 in
  `agent-regression-2026-09-08T07-22-30-354Z.*`, and SKILL-05 in
  `agent-regression-2026-09-08T07-37-20-041Z.*`.
- FLOW-02, FLOW-03 and FLOW-06 passed in
  `agent-regression-2026-09-08T07-45-35-443Z.*` plus the focused FLOW-02
  recovery `agent-regression-2026-09-08T07-46-59-102Z.*`. FLOW-04/05/07/08
  have executable fixtures and assertions, but the latest group attempt
  `agent-regression-2026-09-08T07-54-57-247Z.*` was blocked before tools by a
  sustained Agicto timeout; BASIC-01 then reproduced the outage after the full
  bounded retry window in `agent-regression-2026-09-08T07-59-17-877Z.*`.
- Scripted run-control coverage is explicitly labelled and cannot be confused
  with real routing: ERROR-01/04/06/07 passed 4/4 in
  `agent-regression-2026-09-08T08-09-54-196Z.*`; CHAT-05/07/08 passed 3/3 in
  `agent-regression-2026-09-08T08-13-28-945Z.*`. CHAT-08 also verifies stable
  MCP idempotency from run + server + tool + canonical argument hash.
- CHAT-01/02/03/06 and ERROR-02/03/05/08 have real-model fixtures and hard
  assertions but await provider recovery for execution. The additional
  scripted ERROR-01/04/06/07 report
  `agent-regression-2026-09-08T08-09-54-196Z.*` is 4/4 PASS; the scripted
  steer/concurrency/reconnect report
  `agent-regression-2026-09-08T08-13-28-945Z.*` is 3/3 PASS.
- Scripted performance/architecture controls passed 4/4 in
  `agent-regression-2026-09-08T08-17-31-313Z.*`: overlapping one-second reads,
  ten concurrent sessions, twenty sandbox cancellations with zero active runs,
  and direct/MCP/sandbox Pi-loop evidence. PERF-02 passed separately in
  `agent-regression-2026-09-08T08-18-35-036Z.*`. PERF-01 and PERF-04 are wired
  for real-model execution but are not run while the provider is unavailable.
- The provider recovered and both remaining performance paths now have real
  evidence. PERF-04 passed in
  `agent-regression-2026-09-08T10-03-24-251Z.*`: an actual 10,000-row CSV was
  streamed through local sandbox code, deterministically verified at 100,000
  net sales, and delivered as a bounded CSV artifact. Total time was 66.9 s;
  sandbox time was 583.2 ms and model time was 66.3 s. The test first exposed
  an incorrect zero total and then a valid CSV/stdout delivery mismatch; both
  are now rejected or normalized at the sandbox evidence boundary.
- PERF-01 passed two comparable 20-sample real-model runs. The comparison
  report `agent-regression-2026-09-08T10-06-03-368Z.*` concludes performance
  PASS: average model/request time improved 15.6% to 2423.5/2423.8 ms, average
  response stream time improved 18.0% to 1626.2 ms, request p50 was 2152.4 ms
  and p95 was 3617.8 ms. All 20 samples used one model call and no tools.
- First fully executable 90-case run:
  `agent-regression-2026-09-08T10-08-46-862Z.*` started all 90 cases and
  produced 78 PASS, 11 FAIL, 1 BLOCKED, 0 SKIP/REVIEW in 1,273,347.1 ms
  (86.67% strict pass). `ARCH-04` was the sole infrastructure block because
  the persistent browser driver was unavailable in the command environment.
  The run exposed narrow semantic assertions, missing deterministic summaries,
  a skipped company-metric retrieval and several model-generated sandbox
  reliability failures; none were converted to skips.
- Post-run focused fixes are evidence-backed:
  `agent-regression-2026-09-08T10-37-26-468Z.*` passed KB-08, MCP-04 and
  ERROR-08 at 3/3 after accepting semantically equivalent limitation wording
  and enforcing an authoritative unverified-write result;
  `agent-regression-2026-09-08T10-42-05-182Z.*` passed CHAT-02 with a verified
  Shenzhen-only 850 CSV;
  `agent-regression-2026-09-08T10-48-56-547Z.*` passed FLOW-07 while preserving
  the valid CSV after a controlled chart failure;
  `agent-regression-2026-09-08T10-50-40-959Z.*` passed BOX-05 with a decodable
  PNG and its 400/250/300/400 CSV;
  `agent-regression-2026-09-08T10-51-51-497Z.*` passed FLOW-05 with mandatory
  KB-METRIC retrieval plus placeholder-free Markdown and consistent CSV.
  SKILL-05/06 and ERROR-03 also passed focused runs after their summaries were
  derived from actual sandbox/tool evidence.
- PERF-04 has one postcondition-gated PASS
  (`agent-regression-2026-09-08T10-03-24-251Z.*`) and a later FAIL
  (`agent-regression-2026-09-08T10-53-31-078Z.*`) where the model described a
  CSV it did not actually create. The latter is retained as a real reliability
  defect; no artifact assertion was weakened.
- Runtime evidence correction is now terminally fail-closed: if the model still
  lacks a successful sandbox read, knowledge attempt or real handoff state
  after its correction turn, the runtime discards any unsupported success
  prose and returns a deterministic partial/unfinished message. The contract
  suite proves a repeated false “result.csv generated” claim cannot reach the
  user without an artifact.
- ARCH-02 now checks the production scheduler import graph and the standalone
  Pi processor. It passed in
  `agent-regression-2026-09-08T09-39-10-251Z.*`; the scheduler imports
  `processor-pi.ts`, and that module has no legacy processor import or
  V2/V3/Composer call marker.
- The new production processor passed real isolated product ARCH-03 in
  `agent-regression-2026-09-08T09-39-53-035Z.*`: 1/1 PASS, first valid answer
  1050.3 ms, total 58067.0 ms, seven real model calls and six tools, including
  knowledge, MCP, Skill, Docker sandbox and artifact download evidence.
- Manual real-browser ARCH-04 verification against the isolated stack exposed
  and fixed two races: explicit handoff requests could end without current-run
  tool evidence, and queued cancellation left GenerationRun in WAITING_HUMAN
  plus React `busy=true`. After the fixes, queued showed the cancel control,
  cancellation converged to AI-active within 1.5s, and actual
  `assignConversationOperator` takeover dynamically showed the test operator
  with no permanent Working state. The CLI entry is `pnpm test:agent:ui`; its
  latest restricted-shell report is
  `agent-regression-2026-09-08T09-11-40-763Z.*` and documents the local-port
  driver block.

## Pi execution limits

- `DELEGATE_PI_MAX_STEPS` controls the per-request model/tool turn ceiling.
  Default `16`; values are clamped to `2..64`.
- `DELEGATE_PI_MAX_OUTPUT_TOKENS` controls each Pi model response token ceiling.
- `DELEGATE_PI_MODEL_MAX_RETRIES` controls provider-stream retries only and
  never retries tool side effects.

## Post-cutover representative knowledge correction — 2026-09-10

The first manual run against `founder-representative-2` exposed four Pi
cutover regressions: subject-domain questions were treated as source-free
general knowledge; unpaired historical audience questions were replayed as if
they were unanswered; the full first-person role summary was repeated; and the
public chat rendered Markdown markers as plain text.

- The Pi system/tool contract now prefers authorized knowledge for factual or
  explanatory questions inside the representative's stated specialty while
  preserving one-turn direct answers for greetings, arithmetic, translation,
  generic writing and clearly unrelated topics. A deterministic evidence gate
  requires retrieval when the draft and representative role share bounded
  domain terms.
- Standalone turns discard unpaired historical audience messages. Explicit
  follow-ups receive at most three previous visitor requests in a fenced
  “already handled, context only” block, so the model cannot answer an old
  question again as current work.
- Knowledge query routing probes the immutable published corpus with the exact
  visitor question first. Model refinements are accepted only when the exact
  question misses and the refinement independently hits, preventing invented
  qualifiers such as “official curriculum standard” from suppressing a real
  match.
- Pi receives the public citation title, never the internal
  `knowledge/<asset-id>.md` resource key. The prompt and tool result forbid
  naming publications, textbooks, websites or authorities absent from the
  successful result.
- Public chat uses a React-escaped, bounded Markdown subset for paragraphs,
  headings, lists, separators, bold and inline code; no raw HTML or
  `dangerouslySetInnerHTML` is used.

Fresh product evidence:

- `cmtvdj3oe00pqp50nkxbo1wpb`: “等温线是什么” completed with one
  knowledge tool call and cited `地理_02_中国地理`.
- `cmtvdjdl300qmp50n89mlpqge`: “世界上面积最大的大洲是什么？”
  completed with one knowledge tool call and cited `地理_03_世界地理`,
  without repeating the prior question, biography, internal resource path or
  unsupported textbook attribution.
- The final first-turn run `cmtvdyyys0134p50nyirj5snv` used the immutable
  metadata hit before entering Pi: exactly two model calls (tool request, then
  grounded answer), one knowledge call, and one searched/injected/cited item.
  It returned the concise Asia answer with `地理_03_世界地理` and no
  unsupported source or internal resource key.
- Tool-turn narration is no longer published as answer text. When the
  immutable knowledge probe says the request is in scope, Conversation Worker
  suppresses response deltas until `retrieve_authorized_knowledge` has really
  started; the following grounded model turn remains streamed. The real SSE
  run `cmtw8rtt703f4p50n6bntil3v` first exposed `根据` (the first two
  characters of the final answer), never the discarded `我需要先检索...`
  preamble, and completed with two model calls, one knowledge call and the
  `地理_01_地球与地图` citation.
- Browser QA confirmed the final answer contains a real `<strong>` node rather
  than visible Markdown markers and reported no reproducible console error.
- Full affected package results: model-runtime 116 pass / 4 opt-in skip;
  conversation-worker 61/61; web-data 1537 pass / 180 opt-in skip; Reps
  293/293. All four affected package typechecks and the Reps production build
  passed.

## Remaining release checks

1. Full 90/90 and performance comparison remain deliberately paused by the
   user. The retained failures must not be weakened when that work resumes.
2. Planner and DelegationTask source/schema removal is complete. Migrations
   `20260910100000_remove_legacy_planner` and
   `20260910110000_remove_legacy_delegation` passed the repaired full
   170-migration replay, an upgrade rehearsal and the user-authorized localhost
   `delegate` migration. That target retained 33 active Pi GenerationRuns,
   removed the old physical tables and returned zero blockers after migration.
   No external staging/production database is configured; such a target still
   requires its own target-specific preflight, verified backup and maintenance
   approval. See `docs/pi-legacy-schema-removal.md`.
   The final compatibility pass also removed the V3 pure-runtime exports and
   Representative Setup `delegation` DTO. Artifact sanitization and MCP trust
   policy remain as explicitly named, Pi-independent security modules. The
   public Reps stream and UI no longer expose the dead `taskProgress` or
   `turnProgress` Planner/Delegation compatibility contract.
3. After the first future 90/90 run, collect a second full run with the exact
   `mixed-real-model+scripted-control+isolated-product` mode before claiming a
   full-suite performance improvement or regression. The current result remains
   `NOT_DETERMINED` by design.

## Public response streaming correction — 2026-09-14

The reported “我能让你做些什么？” run (`cmu0vlsxa05twpa0n40n8lwbv`)
showed that streaming transport already existed, but the runtime performed
three model turns: it streamed an initial capability draft, used a second turn
to request knowledge, and used a third turn to replace the draft. The knowledge
lookup itself took only about 35 ms; the redundant model turns produced the
10.9-second latency and two-answer appearance.

- Representative-domain evidence routing now depends on the current visitor
  request and the representative's configured role. It no longer uses terms
  invented in a model draft to retroactively classify a generic capability
  question.
- Organization-specific and actual representative-domain factual questions
  still suppress pre-evidence drafts. A representative-domain knowledge miss
  also suppresses the post-tool model draft and produces a deterministic
  limitation instead of an unsupported named source.
- Worker stream persistence now flushes the first token group immediately and
  coalesces later deltas at 64 characters or 75 ms. The public SSE snapshot
  interval is 150 ms instead of 500 ms.
- The exact-question after run (`cmu0wg0270077ul0nbtthi43f`) used one model
  call, zero tools and 4.17 seconds of Pi time; the persisted stream exactly
  matched the terminal answer. This is 61.83% lower Pi time than the reported
  run, but it is a targeted comparison rather than the paused full-suite
  performance conclusion.
- Browser verification run `cmu0wixf200bgul0nwbtsxt3f` displayed its first
  valid answer text at 1.851 seconds, rendered 13 progressive answer states at
  roughly 150–200 ms intervals, and reached the terminal answer at 3.901
  seconds with no replacement text.
- Verification: model-runtime 135 pass / 4 opt-in skip; conversation-worker
  78/78; Reps 293/293; all three affected package typechecks passed; the Reps
  production build and local service rebuild passed. Detailed targeted evidence
  is in `reports/streaming-capability-optimization-2026-09-14.{json,md}`.
