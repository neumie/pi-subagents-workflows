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

The user has approved the local, package, and GitHub rename. Rename the active
local directory only at a controlled handoff with no child processes. Creating
the final GitHub repository is in scope; npm publication remains a release-time
operation after all gates pass.

## Phases and red-green slices

A slice stops on its first failing predecessor gate. A red test must fail for
its intended missing behavior; a green slice must keep all earlier contracts
passing.

### 0. Documentation contract (current)

Rename documentation, publish this plan, and make no implementation claim.
There is no code commit in this task.

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

### 7. Final consumer identity and scaffold: red-green

On `chore/establish-pi-subagents-workflows`, first freeze package name, exports,
extension paths, peer range, and metadata with manifest tests. Then add the
minimal Node 24 ESM/npm scaffold, CI, release workflow, ignore rules, and
approved license. Fail fast against v1-only providers.

Commit: `chore: establish pi-subagents-workflows package identity`

Gate: collision checks are approved, then `npm ci --ignore-scripts`, manifest
tests, and `npm pack --dry-run` pass. No sibling, `file:`, deep-import, or
`npm link` dependency may enter the repository.

### 8. Strict JSON IR v1: red-green

On `feat/foreground-workflow-ir-v1`, add table-driven parser, reference, and
template tests covering every accepted node and rejection listed above. Confirm
normalization and immutability. Implement the smallest parser/resolver code that
makes them green.

Commit: `feat(ir): add strict workflow definition v1`

### 9. Sequential engine and outcomes: red-green

Test and implement `executeWorkflow(def, args, leafRunner, hooks)`: argument
validation, deterministic refs/templates, sequential order, typed outcomes,
identity alignment, usage, limits, cancellation, hook order, and final-result
selection. Authoritative failures are discriminated records, never `null`.

Commit: `feat(engine): execute sequential workflows with typed outcomes`

### 10. Barriered parallel engine: red-green

Use controlled promises to prove overlap, a complete cohort barrier, stable slot
order under reverse completion, one workflow-wide semaphore, partial typed
failures, and no permit leaks. Then implement the shared semaphore path.

Commit: `feat(engine): add barriered parallel agent tasks`

### 11. Item-local pipeline engine: red-green

First prove that one item enters stage 2 while another is still in stage 1,
failed lanes do not advance, supported policy is honored, and output stays
item/stage aligned. Then implement pipelines using the same semaphore and
limits.

Commit: `feat(engine): add item-local pipeline stages`

### 12. Public `pi-subagents` LeafRunner adapter: red-green

Against a packed/published provider artifact, test v2 identity, concurrency,
duplicates, text-versus-structured values, thinking/model, detailed usage,
cancellation, reload/disposal, and typed failures. Implement only against
`pi-subagents/delegation`; reject unsupported providers rather than downgrading.

Commit: `feat(adapter): run workflow leaves through delegation v2`

### 13. Pi tool and command adapter: red-green

First test packed-package extension loading and both invocation paths, hook
updates, structured/literal rendering, run/session identity, and targeted
cancellation. Then register and implement the bounded foreground tool and
command adapter.

Commit: `feat(extension): expose foreground workflow tool and command`

### 14. Foreground hardening and release acceptance

Add hostile metadata, traversal/symlink, maximum-size/limit,
deterministic-event, tarball-install, provider minimum/current, and real
extension tests. Document
foreground, active-context, current-authority, and non-durable limits.

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
slice if any predecessor is red. Stop release for provider deep imports, silent v1 fallback,
sibling/file dependencies, missing packed-package E2E, or a failed Ubuntu or
Windows gate.

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
- publish npm packages or begin implementation as part of this documentation
  task. The already-approved GitHub/local rename is handled as the next
  controlled delivery step.
