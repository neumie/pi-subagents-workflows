# pi-subagents-workflows build contract

This document records the implemented JSON contract for
`pi-subagents-workflows`, the public `pi-subagents` seam it requires, and the
approved restricted-JavaScript amendment. Phase 15 received independent
architecture/security READY reviews and explicit owner approval before any
runtime dependency or production JavaScript code.

## Current invariants and approved amendment

- The project and eventual repository/package name is
  `pi-subagents-workflows` (formerly `pi-workflows`).
- Strict JSON IR v1 remains a supported, inert definition language with its
  current parser, engine, exports, selector DTOs, and audit compatibility. The
  shared saved-name namespace intentionally gains one fail-closed edge: a name
  matching more than one JSON/JavaScript candidate is ambiguous instead of
  silently preferring the previously valid JSON candidate.
- The next product increment adds **a separate restricted-JavaScript engine**.
  It executes ordinary entropy-controlled JavaScript in a fresh QuickJS/WASM
  runtime inside a disposable, credential-less child process; it is not lowered
  into `WorkflowDefinitionV1` and never executes in the Pi, provider, or
  extension process. “Deterministic” means deterministic bookkeeping for a
  fixed ordered capability-settlement transcript, not timing-independent model
  output or a formal language proof.
- Static parsing is a fail-closed preflight for pure-literal `meta`, hidden
  controls, imports, TypeScript, entropy, unsupported syntax, and prohibited
  capabilities. It is not a substitute evaluator for dynamic loops, reducers,
  or output-driven fan-out.
- The trusted parent retains source resolution and approval, hard limits,
  scheduling, leaf dispatch, typed outcomes, usage, audit, cancellation, and
  process termination. The QuickJS guest receives only bounded framed JSON
  orchestration capabilities and no supported Node, Pi, provider, workspace,
  credential, network, filesystem, subprocess, or environment API. The Node
  runner necessarily has a Node/network surface if the engine boundary is
  compromised; Node permissions are only defense in depth.
- Leaves run with the authority of the installed `pi-subagents` configuration.
  Exact-source approval and script containment do not narrow worker tools,
  credentials, models, or side effects; unsupported per-leaf authority options
  fail rather than being ignored.
- The portable security claim is deliberately limited: a disposable
  QuickJS/WASM child plus Node permissions as defense in depth reduces exposed
  authority and contains ordinary guest failures, but is not a formally
  verified OS sandbox and does not provide portable hard network denial or RSS
  isolation.
- Both engines remain foreground-only. Background launch, resume, replay,
  detach, adoption, daemon ownership, and audit-as-execution-state remain
  deferred until a foreground release and a separately reviewed daemon design.

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
   arguments, calls the selected foreground engine, streams hooks, renders
   typed aligned outcomes, and cancels only its owning run. JSON behavior stays
   compatible; JavaScript is admitted only after exact-source approval and
   audit-before-authority ordering. It never exposes raw delegation events.
5. **Restricted-JavaScript boundary** —
   `prepareRestrictedJavascriptWorkflow(source, options)` performs bounded
   preflight in a credential-less inspector child and returns an opaque,
   source-bound prepared value;
   `executeRestrictedJavascriptWorkflow(prepared, args, leafRunner, hooks,
   policy)` supervises one fresh runtime child through the shared parent-side
   leaf coordinator. Public library callers are trusted supervisors; the Pi
   adapter must additionally supply a non-forgeable approval receipt.

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
4. `feat/pi-0.82-compatibility` — exact Pi 0.81/0.82 compatibility expansion;
   it must merge before restricted-JavaScript implementation branches.
5. `design/restricted-javascript-v1` — this product/security contract only.
6. Restricted-JavaScript implementation branches follow phases 16–27 in order;
   no branch skips the containment, coordinator, approval, or audit gates.
7. `design/durable-workflow-daemon` — later design-only starting point, opened
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

Delegation v2 shipped in `pi-subagents@0.36.0`. The consumer pins the normal
runtime dependency range `>=0.36.0 <0.39.0`; the retained provider artifact and
real-session matrix verifies reviewed 0.36.0 and 0.37.0 registry releases.

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
acceptance is green; hostile active-namespace behavior remains an explicit
exclusion rather than an incomplete Phase 14 gate.

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

Commit:
`1445426 feat(extension): expose foreground workflow tool and command`

### 14. Foreground hardening and release acceptance

Add hostile metadata, traversal/symlink, maximum-size/limit,
deterministic-event, tarball-install, provider minimum/current, and real
extension tests. Document foreground, active-context, current-authority, and
non-durable limits.

The provider minimum/current artifact and real-extension jobs across exact Pi
0.81.0/0.82.1 host baselines, local and hosted Node 24 Ubuntu/Windows
unit/type/package gates, independent correctness/security reviews, and native
static Windows ACL/reparse acceptance are green. The Windows public-seam test
starts from broad inherited and
protected ACLs, requires exact current-user/`SYSTEM`/Administrators DACLs, and
uses real file links and junctions without a Windows skip. This completes Phase
14 for the documented static/observable threat model. Trusted launch state is a
prerequisite; pathname-based checks do not claim protection from an active
principal able to mutate an ancestor.

Commits:

- `11cab6c feat(extension): harden Windows audit ACLs`
- `test(windows): complete native filesystem acceptance`

Gate: unit, integration, and real extension E2E pass on Node 24 Ubuntu and
Windows for Pi 0.81.0/0.82.1 and provider 0.36.0/0.37.0;
`npm ci --ignore-scripts`, `npm pack --dry-run`, clean tarball install, every
public export, and the complete host/provider matrix are green. The documented
foreground gate is satisfied; publishing a `0.x` release remains a separate
explicit decision.

## Restricted JavaScript v1 amendment

This amendment resolves the conflict between the local static-lowering reports
and the canonical Claude v2.1.218 research. A syntax-only frontend can reuse IR
v1, but it cannot preserve dynamic reducers, loops, arbitrary aggregate returns,
or output-dependent fan-out such as the verifier cohort in
`research/examples/comprehensive-review.workflow.js`. The product therefore
selects a second, bounded runtime engine. Static lowering remains a possible
future convenience profile, not the implementation of dynamic workflows.

Evidence retains the canonical research labels: **Official-doc**,
**Prompt-attested**, **Binary-attested**, **Disk-observed**,
**Inspected-source**, **Secondary-source**, **Inference**, and
**Proposed Pi policy**. The rules below are the approved Pi product contract;
individual hardening rules retain the Proposed Pi policy evidence label rather
than being misrepresented as Claude behavior. They do not turn unrecovered
Claude behavior into a compatibility promise.

### Product scope and intentional divergences

Restricted JavaScript v1 supports ordinary entropy-controlled JavaScript
dataflow, including bounded loops, conditionals, arrays, objects, `Map`, `Set`,
reducers, and output-driven construction of later cohorts. It exposes:

- pure-literal first-statement `export const meta = { name, description,
  phases? }`;
- deep-frozen strict-JSON `args`, or an explicitly encoded absent-arguments
  state exposed to the guest as `undefined`;
- `agent()`, `parallel()`, `pipeline()`, `phase()`, and `log()`; and
- a bounded JSON-compatible final return value, with strings remaining literal.

The `meta` schema is closed in v1. `phases` is an ordered array of
`{title, detail}` display records. Runtime limits are trusted-host policy shown
at approval time, not script-controlled metadata. Unknown metadata fields,
including phase-level model selection, fail until separately versioned.
Formatting may preserve metadata semantics, but every byte change produces a
new source hash and invalidates approval.

The guest has no ambient clock, entropy, locale, host I/O, or scheduling API.
Pure deterministic built-ins required by the canonical example—such as bounded
array methods, `Object.keys`/`values`/`entries`, `Map`, `Set`, and guest-local
`JSON` operations—may be allowlisted only after escape tests. Promise settlement
is nevertheless an explicit input to program behavior: provider replies are
journaled in settlement order, and scripts that observe races or mutate shared
state from concurrent continuations may produce different graphs for different
settlement transcripts. V1 therefore promises deterministic bookkeeping only
for the same source, args, runtime/policy, leaf values, and ordered settlement
transcript. Documentation and tests must not claim timing-independent model
output or formal determinism. V1 does not pretend static analysis can recognize
all race-equivalent programs; observed capability settlement order is explicit,
bounded audit input to any script that chooses to depend on it.

`agent(prompt, options)` initially accepts only exact mappings supported by the
published leaf seam:

- required `agentType`, mapped to the `LeafRunnerRequestV1.agent` specialist;
- optional JSON Schema `schema`, selecting structured output;
- optional bounded display `label` and `phase`; and
- optional Pi-specific `limits: {timeoutMs, maxTurns, maxToolCalls}` that may
  only reduce trusted host maxima.

`model`, `effort`, `thinking`, `isolation`, `stallMs`, retries, tool policy,
skills, context, worktrees, and arbitrary provider options are rejected before
leaf dispatch. They are not silently inherited from script text. Effective
worker authority still comes from installed `pi-subagents` policy and must be
shown in the approval warning.

Primitive semantics are:

- successful plain leaves return exact text; JSON-looking text is never parsed;
- successful schema leaves return only the separately tagged, validated value;
- a direct `agent()` non-success rejects with a stable bounded guest error;
- `parallel(thunks)` validates and reserves the whole collection before calling
  thunks, runs them concurrently under the shared semaphore, waits for the full
  cohort, preserves input order, and projects individual thunk rejection to
  `null`;
- `pipeline(items, ...stages)` reserves the collection before dispatch, runs
  item-local serial lanes without a stage barrier, passes
  `(previous, original, index)`, and short-circuits only a rejected or explicit
  `null` lane;
- malformed combinator arguments, policy/cap failures, and cancellation reject
  the containing operation instead of truncating; and
- `phase()` changes bounded presentation state and `log()` emits bounded
  narration; neither creates synchronization.

This deliberately combines Claude-like script-visible `null` slots with Pi's
stronger authoritative ledger. A rejected leaf capability keeps its existing
typed leaf outcome. A guest-only exception in a thunk or stage has no leaf
outcome, so the trusted bootstrap reports a bounded `guest_operation_failed`
record carrying the parent-issued collection ID and exact slot/item/stage before
projecting `null`; an uncorrelated or unreportable guest exception fails the
whole run. Explicit `null` is not fabricated as a failure. Direct leaf failure
classification in Claude is incomplete and the current provider seam does not
expose every reference class, so v1 does not invent exact direct-`agent()` null
parity.

`budget` and child `workflow()` are not in the first release slice. One-level
`workflow("saved-name", args?)` may be added only after the base engine is green
and tests prove that parent and child share one coordinator, semaphore, call and
item counters, cancellation tree, approval policy, and audit identity. Its child
binding must reject further nesting. Output-token `budget` remains deferred
until its accounting and in-flight overshoot contract can be enforced from
published provider data. General imports, TypeScript, package access, script I/O,
and exact Claude branding, trigger, background, retry, classifier, worktree, or
resume behavior are not v1 goals.

### Trust zones and accepted threat claim

All source, arguments, prompts, selectors, filesystem state, provider events,
results, logs, errors, approval display text, frames, and stored audit files are
untrusted. The design has four zones:

1. **Trusted parent supervisor:** resolves exact bytes, computes hashes, owns
   policy, approval, audit, the shared leaf coordinator, provider calls,
   cancellation, and child termination.
2. **Disposable inspector child:** receives source only, performs bounded AST
   parsing and pure-literal metadata/prohibited-source checks, and returns strict
   framed JSON. It has the same sanitized process posture as the runtime but no
   QuickJS execution or provider capability.
3. **Disposable runtime child:** owns one exact-pinned QuickJS/WASM module,
   runtime, and context for one run. It receives approved source, args, and
   policy only after durable audit creation and can request only versioned
   orchestration capabilities.
4. **Provider leaves:** execute through public `pi-subagents` delegation v2
   under installed provider authority. They never share objects, credentials,
   or event-bus access with the script child.

Phase 15 originally selected exact-pinned `quickjs-emscripten@0.32.0` with one
synchronous QuickJS-NG WASM variant for Phase 16 evaluation. The completed
Phase 16 review rejected that engine and the bounded, dated alternative set it
screened. A supplemental custom build against Bellard QuickJS 2026-06-04 later
passed fixed-memory and concurrent-promise seams but reproduced the persistent-
object OOM teardown abort from wrapper issue #257. There is no accepted
production candidate as of 2026-07-31. A future candidate must still use
host-created deferred QuickJS promises and explicit pending-job pumping so
multiple `agent()` calls can remain outstanding. It must not use an Asyncify
design that serializes the whole module. See
[`research/restricted-javascript-phase16.md`](research/restricted-javascript-phase16.md)
for the exact dispositions and reopening criteria.

One fresh Node 24 child is spawned with `shell:false`, dedicated stdio, an empty
run cwd, an allowlisted environment, and Node permissions granting only the
runner/dependency/WASM reads needed to start. Source and arguments travel only
inside framed stdin, never argv, environment, a shell, or a temporary executable
file. On Windows the minimum trusted launch variables such as `SystemRoot` are
explicitly audited. Existing file descriptors, workers, addons, WASI, inspector,
subprocesses, and filesystem writes are not granted.

Node permissions are a seat belt for the trusted runner, not a malicious-code
boundary. QuickJS heap, stack, and interrupt limits are soft engine controls.
The parent wall watchdog and process kill are the portable hard stop for a
wedged guest. The release must say that compromise of the child Node/WASM engine
could still reach ordinary network or same-user OS resources; portable hard
network denial and RSS caps require separately tested OS enforcement and are
not claimed by v1.

### Source policy, preparation, and approval

The source parser accepts plain JavaScript in a strict async-body profile. The
first non-comment statement must be the pure-literal `meta` export. The export
is removed and the remaining body is wrapped for top-level-looking `await`,
`for await`, and `return`. Full-source preflight rejects the entire file,
including unreachable code, for:

- static or dynamic imports, additional exports, TypeScript, JSX, source maps,
  and unsupported directives;
- hidden C0/C1 controls, bidi controls, malformed UTF-8, a BOM, or disallowed
  line separators under the documented display policy;
- `process`, `require`, `module`, `Buffer`, Node or web I/O, timers, workers,
  addons, WASI, WebAssembly, inspector, and environment access;
- clocks, entropy, locale-sensitive APIs, `Date`, `Math.random`, `performance`,
  `Intl`, and host-dependent enumeration helpers not explicitly allowed;
- `eval`, `Function`, constructor-chain code generation, dynamic import, Proxy,
  accessors, `toJSON`, prototype mutation, dangerous prototype keys, and
  reflective paths that can make bridge serialization invoke guest code; and
- AST/source/depth/node complexity beyond policy limits.

Runtime removal/poisoning of prohibited globals and prototype escape paths is
defense in depth; preflight is not the authorization boundary. Pure standard
computation remains available only where the escape/entropy corpus proves it.
No host object, callback, error, Promise, logger, schema instance, or QuickJS
handle crosses the protocol. Bridge values are canonical strict JSON and are
revalidated in the parent.

Invocation arguments use one closed envelope:
`{"kind":"absent"}` or `{"kind":"value","value":<JsonValue>}`. Present values
pass the same accessor/proxy/prototype/cycle/non-finite/depth/entry/size boundary
as protocol values; `undefined` is valid only through the absent arm. Hashing,
`args.json`, approval, and runtime input use the exact UTF-8 bytes produced by
the package's versioned canonical JSON algorithm: object keys sorted by Unicode
code point, arrays retained in order, shortest `JSON.stringify` number spelling
(with `-0` normalized to `0`), standard JSON string escapes, and no insignificant
whitespace. The manifest binds the canonicalization profile. `null` remains a
present value and cannot collide with absent arguments.

JavaScript is disabled on every Pi extension route until an explicit
source-bound approval succeeds:

1. Resolve exactly one selector and read immutable bounded bytes.
2. Parent and inspector independently hash the same source; reject mismatch.
3. Parse metadata and policy diagnostics without executing the body.
4. Present provenance, full safely rendered source, source and metadata hashes,
   argument hash/summary, resolved caps, runtime/WASM identity, execution mode,
   and the installed-provider authority warning through a trusted host surface.
5. Default to deny. A one-run receipt binds session/run identity, exact source,
   canonical provenance, metadata, arguments, resolved policy, runtime identity,
   and approval-policy version.
6. Durably publish receipt, source, the canonical argument envelope, manifest,
   and the first `workflow_started` journal event before spawning the runtime
   child or any real provider leaf through a Pi route.

The low-level execution API is a trusted-supervisor seam and cannot enforce Pi
UI or run-store policy by itself. Before phase 26 exports it, all Pi routes must
wrap it in the approval/audit capability above; tests in phases 20–22 use only a
fake capability broker and fake leaves. External library supervisors explicitly
own equivalent authorization and persistence policy and receive no claim of Pi
approval. Intent, a slash command, a model tool argument, a workflow name,
metadata, a keyword, project trust, or a prior receipt cannot mint approval.
TUI and long-lived RPC may offer approval only when every approved byte can be rendered
without truncation or control ambiguity. JSON and print modes fail closed in v1;
a future exact-hash host preapproval must be a host capability outside
model-controlled tool parameters. The model tool may propose inline or saved
JavaScript only after this approval path exists. Explicit paths remain
user-command-only. Project saved JavaScript is neither discovered nor runnable
when the host cannot establish project trust and exact-source review.

Source selectors remain strict and non-hybrid:

```text
inline JSON IR                      model tool and command
inline restricted JavaScript       model tool and command after approval
saved <name>.workflow.json          model tool and command
saved <name>.workflow.js            model tool and command after approval
explicit *.workflow.json path       command only
explicit *.workflow.js path         command only after approval
```

Saved names check the exact user/project JSON/JavaScript candidates and reject
more than one match; no root or format wins by precedence. A JavaScript parse
failure never falls back to JSON, and vice versa.

### Framed capability protocol and hard limits

Inspector and runtime transport use `uint32-be length || strict UTF-8 JSON` over
stdout/stdin. Stdout is protocol-only; bounded non-content diagnostics use
stderr. The parent creates the run ID and random 256-bit nonce before spawn and
speaks first with one `init` frame carrying both. Every later frame must echo
them. Runtime call IDs are parent-validated, strictly increasing positive safe
integers. Replies may settle in any order only for currently outstanding calls.
Wrong run/nonce, unknown or duplicate IDs, replayed settlements, unknown fields,
duplicate keys, dangerous keys, truncation, extra terminal frames, stdout text,
or EOF/state ambiguity poisons the run, cancels admitted leaves, and kills the
child.

Before approval, the parent resolves and hashes the installed runner, parser
profile/package, selected runtime package/variant, and WASM from trusted package
paths. `init` carries the expected identity and mode. Child `hello` only echoes
what it loaded; the parent compares it with its independently computed expected
identity before sending source. The echo is a consistency check, not remote
attestation. Approval binds the parent-computed identities.

The inspector is a closed one-shot state machine:

- parent `init` selects `mode:"inspect"`, run/nonce, expected runner/parser
  identity, frame limits, and source-policy profile;
- child `hello` echoes mode and actual runner/parser identity;
- parent `inspect` carries exact source, parent source SHA-256/byte length, and
  preflight limits;
- child emits exactly one terminal `inspected` with either the same source hash,
  canonical metadata and metadata hash, bounded diagnostics, parser/profile
  identity, and `ok:true`, or one bounded typed error with `ok:false`; then clean
  EOF is required.

The inspector has no runtime, provider, or capability-call state. Wrong hashes,
extra frames, cancellation, crash, timeout, malformed diagnostics, or ambiguous
EOF reject preparation and mint no approval.

The runtime is a separate fresh process and state machine:

- parent `init` selects `mode:"run"` with expected runner/runtime/WASM identity;
- child `hello` echoes the loaded identity;
- parent `run` carries approved source, canonical argument envelope, metadata,
  and resolved policy;
- child `call` requests `agent`, `reserveCollection`, `guestOperationFailed`,
  `phase`, or `log`;
- parent `return` supplies either one safe JSON value or one bounded stable
  error; and
- child emits exactly one terminal `result`, followed by clean EOF.

`reserveCollection` returns a parent-issued collection ID. The internal guest
bootstrap uses it to correlate slot/item/stage diagnostics;
`guestOperationFailed` is audit data, never leaf authority. Author-facing
`phase()` and `log()` remain synchronous-looking; their internal frames are
acknowledged with bounded outstanding backpressure. The trusted runner must not
emit `result` until its capability registry is empty and the top-level guest
promise has settled. Independently, the parent accepts `result` only when its
outstanding-call map is empty, every admitted provider leaf is terminal, every
phase/log/guest-diagnostic acknowledgement is settled, and child issued/settled
counters equal the parent's counters. A fire-and-forget `agent()`, result before
return, terminal with pending event, or EOF with any outstanding call is a fatal
protocol violation: cancel exact leaves, reject success, terminate then
force-kill the child, and publish only a failed workflow terminal. Parent
capability validation is authoritative even when the child already validated
the same request. Cancellation closes input and escalates
terminate/force-kill; no cancellation frame is trusted to stop a wedged guest.

Hard ceilings start with the already reviewed package bounds and may be lowered
by measurements, never silently raised:

- 1 MiB each for source, encoded args, and final JSON value;
- 4 MiB per frame, depth 64, 100,000 aggregate entries, and 1,000 outstanding
  calls;
- 1,000 lifetime `agent()` calls;
- `maxCollectionSize <= 4,096` for each `parallel()` or `pipeline()` call and a
  separate trusted `maxAdmittedCollectionEntries <= 4,096` cumulative counter
  across all JavaScript combinators in the run; both are checked atomically
  before callbacks or leaves start;
- resolved concurrency at most 16, with the Claude-observed CPU formula as the
  default and a trusted policy allowed to lower it;
- 64 KiB captured stderr and existing bounded log/progress/audit/render limits;
- one runtime module/context, one terminal, and one process lifetime per run.

Exact QuickJS heap, stack, interrupt-count, guest-CPU, parent wall, and kill-grace
values are frozen only after cross-platform containment measurements. Network
or install timeout budgets remain separate from workflow runtime budgets.
Collections and call slots fail atomically instead of truncating. The
JavaScript cumulative collection counter is a new policy domain and does not
reinterpret JSON IR's existing `maxItems` or counters during coordinator
extraction. Future child workflows must share the JavaScript counters. Parent
usage aggregation is by monotonic call identity, checked for safe-integer
overflow, and remains independent of completion order.

### Shared coordinator and compatibility boundary

`src/engine/execute-workflow.ts` currently owns the fair semaphore, call/item
reservations, terminal validation, usage, bounded progress, cancellation, and
leaf accounting. These mechanics move behind one internal parent-side leaf
coordinator before the JavaScript engine can dispatch a leaf. JSON IR keeps its
own reference/template evaluation, parallel barrier, pipeline lanes, outcomes,
final refs, and public `executeWorkflow` signature.

The extraction is accepted only if all existing JSON parser/engine fixtures and
public projections remain deep-equal, including ordering, counters, typed
failures, hook behavior, timeout cleanup, and usage. The JavaScript engine then
uses the same coordinator for dynamic calls. `(ownerRunId, nodeId)` remains
logical identity and `(requestId, ownerRunId, nodeId)` remains one provider
attempt. JavaScript node IDs are parent-owned monotonic identities, never labels
or guest-controlled correlation keys.

The root, `./ir`, and `./engine` exports remain compatible. A separately reviewed
`./javascript` subpath may expose opaque preparation and trusted-supervisor
execution APIs. Prepared values retain exact source in private module state,
are non-forgeable within the process, and cannot be reconstructed from audit
files. The Pi extension's approval requirement is stricter than the public
library seam and cannot be bypassed by serializing a prepared value.

### JavaScript audit and lifecycle

Existing JSON manifest v1 records and `source.workflow.json` remain readable and
unchanged. JavaScript uses a backward-readable manifest v2 with exact source,
metadata, argument, policy, approval, runtime package/variant/WASM, and terminal
hashes. Its run directory contains `source.workflow.js`, canonical argument
envelope `args.json`, `approval.json`, journal, and terminal summary; no file is
replay input. The manifest states `executionMode: "foreground-only"` and
`replayPolicy: "disabled"`.

Inspection verifies codecs and hashes but never parses audit source as authority,
reconstructs a prepared value, executes JavaScript, resumes a VM, or adopts a
process. An incomplete record remains `incomplete (not running; rerun
explicitly)`. Existing atomic no-replace publication, fsync ordering, POSIX
modes, Windows DACL/reparse checks, session hashing, pointer advisory status,
and active-ancestor exclusions continue to apply.

Foreground ordering is:

```text
resolve -> inspect -> approve -> durable begin/started -> spawn child
-> dispatch leaves -> cancel/terminal child -> workflow terminal
-> result publication -> advisory terminal pointer -> teardown
```

Cancellation closes admission, aborts exactly owned provider leaves, rejects
pending guest promises, ignores any later success frame, terminates then
force-kills the runtime, and awaits bounded cleanup. It cannot roll back external
worker effects and never claims exactly-once behavior. Session shutdown follows
the same path and leaves no reusable runtime or orphan child.

## Restricted JavaScript implementation phases

Each slice starts with a red test that fails for the intended missing behavior,
then the smallest green implementation, then all predecessor gates. Phases
20–22 may start disposable runtime children only behind a private fake broker
and fake leaves. No Pi route, public package export, or real provider leaf may
use the JavaScript engine before phases 15–24 are green.

### 15. Contract amendment (complete)

`PLAN.md` and the current-status language in `README.md` were updated without
claiming that JavaScript is implemented or released. `CHANGELOG.md`, package
exports, dependencies, and release notes remain unchanged until a code slice
actually lands.

Independent architecture and security reviewers returned READY on the
second-engine decision, evidence labels, approval policy, portable threat claim,
unsupported options, foreground lifecycle, deterministic qualification, and the
intentional saved-name collision edge while preserving all other JSON
compatibility. On 2026-07-27 the repository owner explicitly accepted:

- the portable disposable QuickJS/WASM child baseline without a portable hard
  network-denial or RSS-sandbox claim;
- the closed v1 metadata, mapped agent options, globals, failure semantics, and
  deferral of `budget` and nested `workflow()`; and
- committing this contract before beginning Phase 16 as a disposable
  dependency/containment proof only.

No production runtime dependency or JavaScript execution path is approved until
the Phase 16 stop gates pass.

### 16. Dependency and containment proof

In a disposable prototype first, exact-pin the candidate QuickJS package and
selected WASM variant; record package integrity, WASM SHA-256, license,
maintainer/release posture, lifecycle scripts, and applicable advisories.
Reproduce and classify upstream-equivalent OOM/disposal concerns. Prove two or
more host-created deferred promises settle independently while pending jobs are
pumped; infinite loops interrupt; recursion, allocation bombs, runtime abort,
malformed bridge values, and forced cancellation kill only the child; and
repeated teardown does not grow or wedge the parent beyond a reviewed bound.

Gate: Node 24 macOS, Ubuntu, and Windows pass the proof from a clean packed
install. Any applicable unresolved high/critical advisory, install-time native
build/script, serialized async bridge, parent crash/hang, unbounded growth, or
unreliable teardown stops the feature. Do not fall back to `node:vm`, a worker,
in-process QuickJS, or unrestricted Node execution.

**Disposition (2026-07-31): complete — rejected, no accepted candidate.** The
merged `quickjs-wasi@3.2.0` fixture remains valid functional, packaging,
lifecycle, and three-OS evidence, but its exact QuickJS-NG engine lacks later
memory-safety fixes, its package omits standalone license/notice files required
by project adoption policy, and the fixture does not exercise the final
empty-cwd/Node-permission launch posture.
The original `quickjs-emscripten@0.32.0` candidates use stale engines with
separate memory-safety or OOM/disposal blockers. The reproducibly built
`quickjs-wasm@0.0.5` near-candidate failed independent concurrent promise
settlement in three fresh Node 24 runs. The later custom synchronous wrapper
against exact Bellard QuickJS 2026-06-04 produced byte-reproducible fixed-memory
artifacts and correctly settled overlapping deferred promises, but persistent-
object OOM still aborted `JS_FreeRuntime` after the PR #266 allocator changes;
its notice bundle also omitted musl. No production dependency or JavaScript
route is approved, and Phase 17 remains blocked until a future exact candidate
satisfies the reopening criteria in the Phase 16 disposition record.

### 17. Shared leaf coordinator extraction

Write controlled red tests for FIFO admission, atomic call/item reservation,
provider terminal validation, per-leaf timeout/cancellation, result and usage
bounds, progress backpressure, safe aggregation, and permit cleanup. Extract
only these mechanics from `executeWorkflow`; keep JSON scheduling and public
outcomes where they are.

Gate: all existing JSON unit fixtures remain deep-equal and the full current
suite, provider artifact smoke, and packed real-extension matrix remain green
before JavaScript can call the coordinator.

### 18. Strict framed transport and disposable child

Implement and fuzz the frame codec, strict schemas, state machine, nonce/run/ID
correlation, bounded decoder, sanitized spawn posture, stderr separation,
watchdogs, cancellation escalation, and one-process teardown. Use a plain ESM
child entry artifact that Node can launch from an installed package without
Jiti, cwd assumptions, shell interpolation, or source on argv.

Gate: both inspector and runtime state machines handle fragmented/coalesced
frames; parent-first nonce establishment and independently computed identity
checks work; oversized lengths, malformed UTF-8, duplicate/prototype keys, wrong
IDs, call floods, stdout logs, extra terminal frames, result-before-return,
fire-and-forget calls, pending event acknowledgements, crashes, hangs, and EOF
races fail closed with exact leaf cancellation, parent survival, no successful
terminal publication, no post-terminal leaf, and no orphan child.

### 19. Source preflight and inspector child

Freeze table-driven accepted/rejected source policy tests, pure-literal
metadata, full AST bans, hidden-control policy, complexity limits, exact
bounded diagnostics, parser/profile identity, canonical metadata, and
parent/inspector hash agreement over the closed one-shot inspector protocol. Add
no runtime capability yet.

Gate: the comprehensive example's deterministic computation syntax parses after
unsupported authority options are removed, while imports, TypeScript, entropy,
code generation, reflection/prototype escape paths, accessors/proxies, malformed
metadata, and unreachable prohibited code fail before approval or dispatch.

### 20. Restricted QuickJS realm and JSON bridge

Create one fresh exact-pinned module/runtime/context; apply heap, stack, and
interrupt controls before source load; remove prohibited globals; install only
frozen args and the internal capability bridge; pump pending jobs; and
canonicalize bridge/final JSON without invoking guest accessors or `toJSON`.

Gate: bounded loops, reducers, `Map`/`Set`, object/array aggregation, top-level
await/return, and independently settling deferred promises work. Clock, random,
locale, eval/constructor, dynamic import, WebAssembly, Node, host-object, proxy,
getter, cycle, bigint, non-finite, deep, and oversized cases fail safely.

### 21. Sequential `agent()` vertical slice

Add parent-owned dynamic identities, call admission, exact option validation,
literal versus structured results, typed parent outcomes/events, guest error
projection, usage, progress, and cancellation through the shared coordinator.
Test the trusted library seam only; do not expose it through Pi yet.

Gate: one prepared script behind the private test broker can call one fake leaf
and return one bounded value; unsupported options dispatch zero leaves;
cancellation kills the child and exact fake leaf; an unawaited fake leaf makes a
terminal result fail and cancels that leaf; and JSON engine/provider projections
remain unchanged. This gate does not claim Pi source approval or audit durability.

### 22. Dynamic combinators and events

Implement `reserveCollection`, ordered all-settled `parallel`, item-local
`pipeline`, phase/log event delivery, output-driven fan-out, and final aggregate
return. Add property and controlled-runner tests for dynamic loops and reverse
completion.

Gate: concurrency never exceeds policy; per-collection and cumulative
reservations are distinct and atomic; the 1,001st call, 4,097-entry collection,
and cumulative-entry overflow fail without partial dispatch; parallel order is
stable; pipeline has no stage barrier; leaf failures retain typed leaf outcomes;
guest exceptions produce correlated `guest_operation_failed` records before a
`null` projection; event backpressure is bounded; and usage follows call
identity rather than completion order.

### 23. Source resolution and non-forgeable approval

Extend source unions and strict saved/path handling without changing existing
JSON selector DTOs or JSON parsing. Add the documented intentional four-way
saved-name ambiguity, exact JavaScript bytes, project-trust gates, TUI/RPC source
review, one-run receipts, replay prevention, and fail-closed JSON/print behavior.
A model-supplied field can never represent approval.

Gate: denial, cancel, source/argument/policy/runtime changes, receipt replay, and
cross-run/session use start zero runtime children and leaves. Path capability
remains command-only; unsafe display or unproved project trust disables the
JavaScript route.

### 24. JavaScript audit v2

Add backward-compatible manifest decoding and durable JavaScript source,
canonical argument envelope/profile, policy/runtime, receipt, journal, and
terminal publication. Preserve manifest-v1 inspection exactly.

Gate: all authority-bearing files and `workflow_started` are durable before
child spawn; corruption/replacement is detected; inspection never executes or
prepares source; incomplete runs are non-running/non-resumable; and terminal
event precedes result publication.

### 25. Foreground service, rendering, and Pi surface

Dispatch by source format under the existing owned foreground service. Add
bounded JavaScript final-value/failure rendering and exact nested usage. Expose
inline/saved JavaScript to the model tool only where trusted approval exists;
expose path JavaScript only to `/pi-workflow run --path`. Keep the command set at
`run|list|status|cancel`.

Gate: service/store/pointer ordering matches the lifecycle above; TUI/RPC
approval and cancellation work; JSON/print reject; session reload/shutdown leave
no child; JavaScript strings remain literal; and all current JSON host tests are
unchanged.

### 26. Public package and packed acceptance

Only after the internal path is green, intentionally add the `./javascript`
export, exact runtime/parser dependencies, installed child/WASM resolution,
manifest tests, documentation, and changelog entries. Do not expose internal
protocol, coordinator, approval constructors, or audit-to-execution APIs.

Gate: clean Jiti imports of existing subpaths and the new subpath, exact tarball
contents, lifecycle-script-free install, no deep/sibling dependencies, no
examples or credentials in the package, and one packed dynamic workflow through
the real Pi/provider extension.

### 27. Containment, compatibility, and release gate

Add adversarial escape/DoS/cancellation/property stress and the full Node 24
macOS/Ubuntu/Windows × Pi 0.81.0/0.82.1 × provider 0.36.0/0.37.0 packed matrix.
Keep provider-free containment jobs separate from real-extension jobs. Record
Node patch, OS image, package/variant/WASM digest, provider tarball digest,
resolved limits, and exact results.

Gate: every required cell passes without skip, timeout, unexplained retry, or
partial success; independent correctness and security reviewers return ready;
`npm audit`/advisory review has no applicable unresolved high/critical runtime
finding; parent memory/process/orphan checks stay within accepted bounds; and
release docs state the limited portable containment claim. Publication, version,
tag, GitHub release, credential use, and npm release remain separate explicit
decisions.

### 28. Optional one-level composition design

After phase 27, design `workflow("saved-name", args?)` against the actual shared
coordinator and approval/audit model. It is a separate reviewed slice, not a
shortcut through the Pi tool or nested provider orchestration. If exact shared
resource, cancellation, depth, provenance, and ambiguity semantics cannot be
proved, keep the global absent. `budget` remains independently deferred.

### 29. Later daemon phase

Only after the foreground JSON and restricted-JavaScript gates are green and a
foreground release/RC is tested may `design/durable-workflow-daemon` define
transport-neutral ownership, a durable execution journal, payload identity,
leases, reconciliation, authenticated transport, and adoption. Crash/restart
invariants and any new provider seam require separate review before the first
daemon code commit. The inspection audit and
`pi-subagents/background-work` registry are not brokers or replay state.

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
- Restricted-JavaScript commits keep dependency proof, coordinator extraction,
  transport, source policy, runtime, host integration, and release acceptance
  reviewable as separate slices. No prototype file or unreviewed WASM artifact
  becomes production code by copy.

## One-writer policy

One implementation writer owns each repository at a time. During provider
phases 2–6, a consumer writer may only prepare fixtures/tests pinned to the
reviewed DTO and must not edit provider files. Freeze the DTO after phase 2
review; contract changes land provider-first and regenerate consumer fixtures.

Within the consumer, ownership moves in order through `src/ir`, `src/engine`,
`src/adapters`, and `src/extension`. Restricted-JavaScript work adds serialized
ownership of `src/javascript`, the child entry artifact, and the shared leaf
coordinator. Shared files—`package.json`, lockfile, exports, CI, `README.md`, and
especially `execute-workflow.ts`—remain under the repository owner. Two writers
must never regenerate the lockfile, change the wire protocol, or edit the engine
coordinator concurrently.

## Stop rules

Stop provider work if the upstream rebase is incomplete, baseline failures are
unclassified, v1 compatibility changes, duplicate correlation is ambiguous, or
the structured payload bounds are not enforced by tests. Stop a consumer slice
if any predecessor is red. Stop release for provider deep imports, silent v1
fallback, sibling/file dependencies, missing packed-package E2E, or a failed
required platform/host/provider gate.

Stop restricted-JavaScript work immediately if the selected runtime cannot
isolate ordinary guest failure in a disposable child, independently settle
concurrent calls, enforce bounded teardown, or survive the escape/OOM corpus; if
an applicable unresolved high/critical runtime advisory exists; if source or
policy changes do not invalidate approval; if any Pi route starts a runtime
child or real provider leaf before durable approval audit; if the private fake
broker becomes reachable from a Pi route; if any route requires `node:vm`,
worker-thread containment, unrestricted Node, ambient credentials/environment/workspace, or live host
objects; if unsupported provider options are ignored; or if coordinator
extraction changes JSON behavior. A portable hard network/RSS requirement also
stops the release until tested OS enforcement exists.

Most importantly, stop all daemon, replay, lease, reconciliation, adoption, and
background durability work until the complete foreground parser/runtime,
provider adapter, approval and audit path, Pi tool/command, packaging, security
tests, and cross-platform matrices are green.

## Explicit non-goals

For strict JSON IR v1, this project will not execute JavaScript, imports,
arbitrary expressions, or implicit string references. The JavaScript engine is
a separate source format and execution path; it does not reinterpret or widen
IR v1.

For restricted JavaScript v1, this project will not:

- expose Node, package imports, filesystem, shell, network, process,
  environment, Pi, provider credentials, or arbitrary host capabilities to the
  script;
- claim exact Claude parity, reproduce Claude branding/triggers, or invent
  behavior for unrecovered approval, classifier, retry, cache, budget, or
  failure cases;
- accept script-selected model/effort/thinking/isolation/tools/worktrees or call
  source approval, project trust, QuickJS/WASM, Node permissions, child
  processes, prompts, or worktrees a complete sandbox;
- deep-import provider internals, expose raw provider results, rebuild the child
  executor, or turn internal RPC/background-work plumbing into a broker;
- provide background launch, daemon survival, durable replay/adoption,
  cross-session resume, automatic cache reuse, remote workers, exactly-once
  external effects, or detached parent usage accounting;
- provide `budget` or nested `workflow()` before their separate reviewed phases,
  or use audit files as prepared/executable state; or
- publish npm packages before the applicable release gates pass. Publication,
  version, tag, GitHub release, credentials, and npm release remain explicit
  operations governed by `RELEASING.md`.
