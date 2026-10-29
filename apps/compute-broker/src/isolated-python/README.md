# Restricted Python executor

The Broker now invokes `executeIsolatedPython` only for a validated structured
`isolatedPython` action. Worker requests, approvals, exclusive leases, cancellation,
artifact validation and audience download checks are wired to that path.
`generalCodeExecutionAvailability` remains false: it is not the restricted Python
profile and must not be flipped to admit raw commands, shell or persistent code.
Session preflight checks compatible configuration; actual setup still fails closed.

## Contract

- Current tested environment: Tencent PUBLIC All-in-One, x86_64, Python 3.12
  under `/usr/local`, Linux namespaces and `libseccomp.so.2`.
- Executes Python source in one process. Network sockets, threads, subprocesses,
  namespace changes and capability acquisition are unavailable. Installed
  site/dist packages are masked; supplied Python input modules remain data/code
  subject to the same restrictions. No package installer or shell is provided.
- Inputs are at `/workspace/inputs`, read-only; `/workspace/outputs` and `/tmp`
  are fresh scratch space. Scratch files are not persisted or delivered.
- Source: 64 KiB; Broker inputs: 32 regular files / 20 MiB (launcher ceiling 32 MiB), no subdirectories or links;
  stdout and stderr: each at most 64 KiB, strict UTF-8.
- Deadline: 100–30,000 ms after readiness, with a separate setup bound. CPU
  rlimit is rounded wall seconds plus one. Address space is capped at 256 MiB;
  this is **not an aggregate VM RSS or kernel-memory cap**. Scratch tmpfs and
  inode limits, per-file 8 MiB, FD and process limits apply separately.
- `cleanupConfirmed` means the managed execution has no active process after
  completion. It does not mean the cloud instance was deleted or all host-side
  staging/logs were erased.

The trusted parent and child use private readiness/admission pipes. User code
starts only after restrictions are installed and its process identity is
recorded. Cancellation and timeouts stop the managed execution. SDK failures
with uncertain submission return a stable error and never trigger a replay or
fallback to raw commands. Only a coherent, bounded receipt is released.

## Broker invariants (required for any future caller)

1. Use a fresh, exclusively controlled CODE environment with trusted runtime
   binaries. Do not reuse legacy arbitrary-code instances or a browser lease.
2. Derive the input directory from verified session/task authorization. The
   path-prefix validator is not an access-control system. Freeze the authorized
   input manifest and bytes before approval/dispatch; no concurrent host writer
   may alter the read-only bind source. Do not forward private data solely
   because the model supplied a path.
3. Bind the actual source, input manifest, action and profile to the effective
   approval. Recheck current access, effective policy and cancellation before
   dispatch. Labels and source hashes alone never authorize execution.
4. Persist the execution/control handle and quarantine uncertain leases. A
   killed supervisor can leave trusted staging files. Reconcile/retire the
   disposable execution environment before reuse; don't delete old user data.
5. Connect authoritative cancellation to `signal`, including durable recovery
   after worker loss. The Broker persists a private recovery handle, polls current
   authority and never resubmits an uncertain action. Component signal tests
   and Broker database tests are separate evidence.
6. Map results to real execution states and existing accounting/artifact checks.
   Exit 0 alone is not proof of a valid requested deliverable. Do not transform
   source or output bytes using the legacy command workspace path mapper.
7. Package `launcher.py` with the module and verify the exact deployed image.
   Unsupported setup fails closed, without ordinary SDK-command fallback.

## Evidence

See [D04B1 component acceptance](../../../../reports/agent-remediation/20260929-d04b/acceptance.md)
and [D04B2 integration acceptance](../../../../reports/agent-remediation/20260929-d04b2/acceptance.md)
for real-cloud tests, actual PostgreSQL state/approval tests and worker/HTTP/Broker
integration. S3 transport in the integration fixture is controlled, not production.
Source revocation across all derived context and full business/delivery recovery
remain separate development items. Linux namespaces/seccomp/rlimits are defense
layers, not proof against every kernel or runtime vulnerability.
