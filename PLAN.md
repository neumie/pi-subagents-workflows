# pi-subagents-workflows build contract

This document is the implementation contract for `pi-subagents-workflows` and
the public `pi-subagents` seam it requires. It records the approved direction
before code starts.

## Fixed decisions

- The project and eventual repository/package name is
  `pi-subagents-workflows` (formerly `pi-workflows`).
- Workflow definitions use a restricted, strict JSON IR. They do not execute
  JavaScript.
- The build is phased but covers the full foreground parser, engine, provider
  adapter, and Pi tool/command path.
- Leaves run with the authority of the installed `pi-subagents` configuration.
  This project does not claim a narrower capability boundary, sandbox, or
  prepare/approve/run-pinned security model.
- Foreground execution must be complete and green before daemon design or
  implementation starts.

## Repository ownership

- **`pi-subagents`** owns specialist discovery; child Pi lifecycle; model,
  thinking, tool, context, skill, and workspace resolution; structured capture;
  per-leaf limits and retries; sessions, transcripts, artifacts, worktrees;
  progress and control events; detailed usage; and the public owned-leaf API.
- **`pi-subagents-workflows`** owns strict IR and argument binding; workflow
  scheduling; sequential steps, barriered parallel cohorts, and item-local
  pipelines; typed aligned outcomes; the workflow-wide semaphore, limits,
  cancellation, and usage aggregation; final-result selection; provider
  adaptation; and the Pi workflow tool/command experience.
- **Pi host** owns extension lifecycle, model-facing tool plumbing, command
  registration, pending updates and abort, session surfaces, and documented
  nested-usage accounting.

`pi-subagents-workflows` must consume published exports. It must not
deep-import, copy, or expose `pi-subagents` internals, and it must not rebuild
the child executor.

## Confirmed public TDD seams

The following seams are frozen by tests before their implementations are
considered complete:

1. **`pi-subagents` delegation v2** — strict discriminated v1/v2 DTOs; owned
   single foreground dispatch; logical identity by `ownerRunId` plus `nodeId`,
   with a fresh `requestId` correlating each dispatch attempt; literal-text
   versus schema-backed structured output; requested and effective
   thinking/model data; detailed usage;
   explicit `duplicate_node`; exact cancellation correlation; and at-most-once
   terminal delivery. Delegation v1 and model-facing executor behavior remain
   unchanged.
2. **`parseWorkflowDefinition(input: unknown): WorkflowDefinitionV1`** — the
   only definition entry point. It strictly validates, rejects unknown fields,
   resolves no ambient code, and returns an immutable normalized definition.
3. **`executeWorkflow(def, args, leafRunner, hooks)`** — the foreground engine
   boundary. `LeafRunner` is the only leaf dependency; hooks carry phase, log,
   progress, and lifecycle updates. Engine outcomes are typed and retain stable
   run/node/slot/item/stage identity.
4. **Pi tool/command adapter** — loads and parses definitions, binds
   arguments, calls `executeWorkflow`, streams hooks, renders typed aligned
   outcomes, and
   cancels only its owning run. It does not expose arbitrary JavaScript or raw
   delegation events.

## IR v1 scope

IR v1 is strict JSON with an exact version and discriminant allowlist. It
contains ordered top-level steps:

- `agent`: one sequential leaf;
- `parallel`: an ordered cohort of agent tasks followed by an explicit barrier;
- `pipeline`: a bounded item collection and ordered agent stages, with each item
  advancing independently and no stage-wide barrier.

Definitions include unique IDs; declared arguments; explicit argument, step,
item, index, and prior-stage reference objects; strict template objects;
per-step phase/log metadata; workflow-wide and step-level limits; output mode
and object schema; supported pipeline failure policy; and one required
final-result reference. Literal strings are never reinterpreted as references.

The parser rejects unknown fields or discriminants, duplicate IDs, malformed
schemas/templates, forward or out-of-scope references, missing template values,
invalid limits, unsupported policies, and final references that cannot resolve.
No imports, executable JavaScript, arbitrary expressions, nested workflows, or
implicit string references are part of IR v1.

## Branches

### `pi-subagents`

1. Rebase `feat/add-workflow-delegation-v2` onto current `upstream/main`, then
   classify its baseline without feature edits.
2. Use that branch for the delegation-v2 contract, implementation, lifecycle,
   integration, and documentation.
3. Keep `fix/wake-idle-supervisor-requests` separate.

### `pi-subagents-workflows`

1. `feat/build-workflow-extension` — preserve and merge the research and this
   pre-code contract.
2. `chore/establish-pi-subagents-workflows` — final identity, package
   scaffold, CI, and manifest tests, branched from updated `main`.
3. `feat/foreground-workflow-ir-v1` — IR, engine, adapters, extension, and
   foreground hardening after the scaffold merges.
4. `design/durable-workflow-daemon` — later design-only starting point, opened
   only after the foreground release gate passes.

The approved local, package, and GitHub rename is complete. The canonical local
directory and GitHub repository are now `pi-subagents-workflows`; npm
publication remains a release-time operation after all gates pass.

## Phases and red-green slices

A slice stops on its first failing predecessor gate. A red test must fail for
its intended missing behavior; a green slice must keep all earlier contracts
passing.

### 0. Documentation contract (complete)

The documentation rename and pre-code contract landed before the package
scaffold. No implementation was claimed by that phase.

### 1. Rebase and baseline `pi-subagents`

Rebase `feat/add-workflow-delegation-v2` onto current `upstream/main` without
delegation-v2 edits. Record exact results for:

```sh
node --experimental-strip-types --test \
  test/unit/watchdog-lsp-diagnostics.test.ts
npm test
npm run test:integration
npm run test:e2e
```

The known watchdog mismatch must be resolved or explicitly quarantined if it
still reproduces. A timeout or inconclusive run is not green.

### 2. Delegation-v2 contract: red

On `feat/add-workflow-delegation-v2`, add failing unit and manifest tests for
the public v2 DTO, strict parsing, version projection, identity,
literal/structured
outputs, thinking, detailed usage, duplicate handling, cancellation, bounds,
and malformed schemas. Keep all v1 fixtures and unknown-version/field tests
green.

Commit: `test(delegation): specify owned v2 protocol and compatibility`

Freeze bounded payload behavior in these tests: at most 64 KiB for the encoded
schema and 1 MiB for the encoded structured value. A later release may lower
these bounds incompatibly only in a new protocol version.

### 3. Delegation-v2 DTO and parser: green

Implement strict version-specific parsing and stable public DTO projection.
Literal text that resembles JSON stays text; structured mode requires a
validated captured value; public DTOs do not export internal result types.

Commit: `feat(delegation): add strict owned v2 DTOs and adapters`

Gate: all phase 2 tests and v1 regressions pass.

### 4. Concurrent owned-single executor: red-green

First prove overlap, preservation of the model-facing guard, defensive rejection
of mixed modes, structured-output bounds, exact text, detailed usage/thinking,
and unique runtime paths with controlled failing tests. Then add only the narrow
`executeOwnedSingle` path, reusing existing leaf policy and lifecycle.

Commit: `feat(delegation): add concurrent owned single execution`

### 5. Ownership, duplicate, and cancellation lifecycle: red-green

First test distinct-node overlap, duplicate-attempt rejection without stealing
the original, exact-match cancellation, race cases, disposal/reload, ID reuse
after terminal state, and at-most-once terminals. Then route only strict v2 to
the owned executor; v1, tools, slash/RPC/scheduled calls, and fanout remain on
the guarded path.

Commit: `feat(delegation): wire owned v2 lifecycle and cancellation`

### 6. Provider integration and release gate

Add real-extension tests for the published seam, then provider documentation
covering foreground/current-authority limits and v1 compatibility.

Commits:

- `test(integration): cover public v2 lifecycle`
- `docs(delegation): document v2 limits and compatibility`

Gate: focused tests plus full unit, integration, and E2E suites pass on Node 24
Ubuntu and Windows. Publish a v2-capable release or RC before the consumer pins
a final supported range.

### 7. Final consumer identity and scaffold: red-green (complete)

On `chore/establish-pi-subagents-workflows`, first freeze package name, exports,
extension paths, host peer range, and metadata with manifest tests. Then add the
minimal Node 24 ESM/npm scaffold, CI, safe release workflow, ignore rules, and
approved license. Do not add `pi-subagents` until delegation v2 is published;
provider compatibility belongs to the adapter slice in phase 12.

Commit: `chore: establish pi-subagents-workflows package identity`

Gate: collision checks are approved, then `npm ci --ignore-scripts`, manifest
tests, and `npm pack --dry-run` pass. No sibling, `file:`, deep-import, or
`npm link` dependency may enter the repository.

### 8. Strict JSON IR v1: red-green (complete)

On `feat/foreground-workflow-ir-v1`, add table-driven parser, reference, and
template tests covering every accepted node and rejection listed above. Confirm
normalization and immutability. Implement the smallest parser/resolver code that
makes them green.

Commit: `feat(ir): add strict workflow definition v1`

### 9. Sequential engine and outcomes: red-green (complete)

Test and implement `executeWorkflow(def, args, leafRunner, hooks)`: argument
validation, deterministic refs/templates, sequential order, typed outcomes,
identity alignment, usage, limits, cancellation, hook order, and final-result
selection. Authoritative failures are discriminated records, never `null`.
Parallel and pipeline nodes remain parsed but return typed `unsupported_step`
failures without dispatch until phases 10 and 11.

Commit: `feat(engine): execute sequential workflows with typed outcomes`

### 10. Barriered parallel engine: red-green (complete)

Controlled-promise public engine tests prove capped FIFO overlap, a complete
cohort barrier, source alignment under reverse completion, stable task
identities, deterministic group/task references, partial typed failures,
cancellation and hook-abort alignment, final group/task semantics, source-order
usage overflow outcomes, bounded group rendering and retained success payloads,
progress backpressure, exact counters, and no permit/listener leaks. Sequential
leaves and parallel tasks now share one fair workflow-wide semaphore. Pipelines
remain typed unsupported until phase 11.

Commit: `feat(engine): add barriered parallel agent tasks`

### 11. Item-local pipeline engine: red-green (complete)

Controlled public engine tests prove item-local advancement without a stage
barrier, serial same-item stages, shared fair FIFO admission, stable item/stage
identity, exact local references, stop-item propagation, source-order terminal
accounting, atomic cumulative item/call reservations, bounded group projection,
final group semantics, cancellation and hook-failure alignment, and timeout
permit cleanup. Pipelines use the same semaphore, limits, result-size formula,
and progress bounds as every other leaf kind. Terminal validation caps every
reported usage field at
`floor(Number.MAX_SAFE_INTEGER / definition.limits.maxCalls)` and requires the
four token categories to fit together within that same cap before a pipeline
lane can advance. This ensures that at most `maxCalls` accepted usages and the
derived Pi token subtotal cannot overflow later source-order aggregation.

Commit: `feat(engine): add item-local pipeline stages`

### 12. Public `pi-subagents` LeafRunner adapter: red-green (complete)

Fake-bus tests cover v2 identity, constant-listener concurrency, duplicates,
literal text and structured values, thinking/model, detailed usage, hostile
payloads, cancellation races, reload/disposal, bounded progress, and typed
failures. A separate reviewed-artifact smoke gate proves clean external tarball
installation, public `pi-subagents/delegation` loading, protocol/export
compatibility, hard-zero request projection, and the published
`structured_output_failed` terminal; it does not stand in for the real
cross-extension E2E required by Phase 14. The runtime rejects unsupported
providers rather than downgrading.

Delegation v2 shipped in `pi-subagents@0.36.0` and remains supported in 0.37.0.
The consumer now pins the normal runtime dependency range
`>=0.36.0 <0.38.0`; CI verifies reviewed registry tarballs for both endpoints.

Commit: `763b6b7 feat(adapter): run workflow leaves through delegation v2`

### 13. Foreground Pi integration: staged red-green

Phase 13 is split so filesystem provenance and audit persistence do not imply a
registered or background-capable product.

#### 13a. Strict definition sources and foreground run audit store (consumer complete)

Focused red-green tests and internal modules implement discriminated
inline/saved/path resolution, exact non-recursive saved roots with ambiguity
rejection, capability-gated explicit paths, bounded strict UTF-8 regular-file
reads, duplicate-key rejection, exact source hashing/snapshots, pre-existing
link rejection, and observable mutation/replacement detection. The separate
Workflow-owned run store derives a session key from the stable Pi
session identity, creates restrictive exclusive run directories, awaits the
engine-issued `workflow_started` audit writes, serializes and fsyncs every
non-progress event, and uses atomic no-replace publication for one bounded
terminal summary without duplicating retained leaf payloads. Strict
listing/inspection decoders stream-check the journal and expose provenance and
terminal or incomplete audit summaries only: there are no replay, resume,
continue, cache,
adoption, daemon, or saved-definition mutation APIs. Windows run creation now
applies and verifies a protected DACL for the current user, `SYSTEM`, and local
Administrators at the audit, current-session, and new-run directories before
audit writes. This native adapter requires a trusted launch environment and
`SystemRoot`; pathname-based checks do not claim handle-pinned protection from
any active principal able to mutate an ancestor. Native static ACL/reparse
acceptance and hostile active-namespace behavior remain distinct Phase 14
release gates.

Commit:
`1fe39ec feat(extension): add workflow provenance and foreground audit store`

#### 13b. Shared foreground run service and rendering: red-green (complete)

Focused tests prove awaited journal-before-dispatch ordering, exact in-memory
run-ID ownership and cancellation, concurrent foreground calls, bounded
shutdown, hook/store/adapter failure cleanup, terminal-before-result
publication, bounded progress and terminal rendering, literal/structured result
preservation, and exact nested Pi usage without fabricated category costs. The
service creates one lazy shared public provider adapter per invocation cwd,
caps cwd-scoped services, disposes each once, and treats disk only as
audit/inspection state.

#### 13c. Pi registration: red-green (complete)

A fake-host test covers exact `pi_workflow` and `/pi-workflow` registration,
tool call ID and abort propagation, bounded/coalesced updates and errors,
inline/saved versus command-only path capability, same-session cwd changes,
branch pointers, targeted cancellation, and idempotent session-shutdown
disposal. The strict command parser exposes only `run`, `list`, `status`, and
`cancel`; there is no save, resume, detach, background, or model path
capability.

A clean-install E2E now packs the consumer, installs a reviewed provider
tarball, discovers both extension entrypoints from their published Pi
manifests, creates a real Pi `AgentSession`, and executes one workflow through
the real `pi-subagents` extension and a test-owned faux-provider child. It
asserts exact model/tool result delivery, compact details, branch pointers,
terminal audit state, and session shutdown. The gate passes for both supported
provider releases, 0.36.0 and 0.37.0.

Planned commit:
`feat(extension): expose foreground workflow tool and command`

### 14. Foreground hardening and release acceptance

Add hostile metadata, traversal/symlink, maximum-size/limit,
deterministic-event, tarball-install, provider minimum/current, and real
extension tests. Document foreground, active-context, current-authority, and
non-durable limits.

The provider minimum/current artifact and real-extension jobs, local Node 24
unit/type/package gates, and independent correctness/security reviews are
green. Native Windows filesystem/ACL/reparse validation and hosted Node 24
Ubuntu/Windows CI execution remain before Phase 14 can be called complete.

Commits:

- `test: harden foreground workflow integration`
- `docs: document foreground scope and limits`

Gate: unit, integration, and real extension E2E pass on Node 24 Ubuntu and
Windows; `npm ci --ignore-scripts`, `npm pack --dry-run`, clean tarball install,
every public export, and minimum/current provider jobs are green. Only then may
a `0.x` release be published.

### 15. Later daemon phase

Only after phase 14 is entirely green and release/RC-tested may
`design/durable-workflow-daemon` define transport-neutral ownership, a durable
journal, payload identity, leases, reconciliation, authenticated transport,
and adoption. Crash/restart invariants and any new provider seam require
separate review before the first daemon code commit. The
`pi-subagents/background-work` registry is not a broker.

## Commit and validation gates

- Keep sync/rename noise, protocol, scheduler, adapters, tests, and docs in the
  commits named above; never combine changes across repositories.
- Each commit passes its focused tests and every previously green suite. Full
  repository matrices run at the provider and consumer release gates.
- Do not call a timeout, skipped required platform, flaky-only pass, or
  unclassified baseline green.
- Consumer integration uses an installed packed/published dependency artifact,
  not sibling source or uncommitted provider work.
- The provider release/RC precedes a final consumer dependency range; the
  foreground release precedes daemon work.

## One-writer policy

One implementation writer owns each repository at a time. During provider
phases 2–6, a consumer writer may only prepare fixtures/tests pinned to the
reviewed DTO and must not edit provider files. Freeze the DTO after phase 2
review; contract changes land provider-first and regenerate consumer fixtures.

Within the consumer, ownership moves in order through `src/ir`, `src/engine`,
`src/adapters`, and `src/extension`. Shared files—`package.json`, lockfile,
exports, CI, `README.md`, and especially `execute-workflow.ts`—are serialized
through the repository owner. Two writers must never regenerate the lockfile or
edit the engine coordinator concurrently.

## Stop rules

Stop provider work if the upstream rebase is incomplete, baseline failures are
unclassified, v1 compatibility changes, duplicate correlation is ambiguous,
or the structured payload bounds are not enforced by tests. Stop a consumer
slice if any predecessor is red. Stop release for provider deep imports, silent
v1 fallback, sibling/file dependencies, missing packed-package E2E, or a failed
Ubuntu or Windows gate.

Most importantly, stop all daemon, replay, lease, reconciliation, adoption, and
background durability work until the complete foreground parser, sequential /
parallel / pipeline engine, provider adapter, Pi tool/command, packaging,
security tests, and cross-platform matrices are green.

## Explicit non-goals

For IR v1 and the foreground release, this project will not:

- execute trusted or untrusted JavaScript, imports, arbitrary expressions, or
  hidden keyword steering;
- claim Claude parity, reproduce Claude branding, or overload failures as
  authoritative `null` values;
- harden authority beyond the installed `pi-subagents` configuration or call
  project trust, prompts, worktrees, child processes, or `node:vm` a sandbox;
- deep-import provider internals, expose raw provider results, rebuild the child
  executor, or turn internal RPC/background-work plumbing into a broker;
- provide daemon survival, durable replay/adoption, remote workers,
  cross-session resume, exactly-once external effects, or detached parent
  usage accounting;
- add nested workflows, automatic cache reuse, arbitrary package resource
  discovery, parity retry policies, or expanded worktree policy to IR v1; or
- publish npm packages before the release gates pass. The current consumer
  includes the parser, foreground engine, provider adapter, and unregistered
  internal source/audit-store slice; the Pi tool/command and release gates are
  still incomplete.
