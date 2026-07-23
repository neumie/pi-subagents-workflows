# Claude Dynamic Workflows and `pi-subagents`: exact-checkout comparison

> **Scope:** Claude Code Dynamic Workflows v2.1.218 (with the recovered v2.1.217 Workflow prompt) versus `pi-subagents` v0.35.1 at exact checkout [`67ce1939977bdcdb32048fa0e4d387a48b22b729`](https://github.com/neumie/pi-subagents/tree/67ce1939977bdcdb32048fa0e4d387a48b22b729).
>
> **Evidence date:** 2026-07-23. This is documentation and architecture analysis, not a claim that a Pi Workflow extension has been implemented.

## Evidence and notation

Claude facts below inherit the evidence classes and version qualifications in the companion [Claude Code Dynamic Workflows report](claude-code-workflows.md#methodology-provenance-and-safety): official documentation, prompt-attested contracts, binary-attested implementation, disk observations, inspected source, inference, and proposed Pi policy remain distinct. In particular, recovered Claude internals are version-specific observations, not public API promises.

`PS:` citations are pinned source or test links in the inspected fork. `CCW §…` links to the companion synthesis. Git history claims use commit objects: upstream contribution links point to the upstream repository; fork-only `67ce193` and exact-checkout source links point to `neumie/pi-subagents`. No temporary audit artifact is a published source.

## Executive conclusion

**`pi-subagents` is a strong leaf, lifecycle, and UI substrate; it is not the Workflow engine.** It already owns much of the difficult child-agent machinery: specialist discovery, child Pi processes, model and thinking resolution, prompt/context hygiene, tools and skills, structured capture, barriered chains and fan-out, artifacts, worktrees, progress, controls, async status, revival, usage, quality gates, and polished inspectors. Reimplementing that machinery in `pi-workflows` would be wasteful.

Claude Dynamic Workflows puts a reviewed deterministic program above workers. That program owns arbitrary restricted-JavaScript control flow, value reduction, `parallel()`, item-local no-barrier `pipeline()`, shared resource domains, one-level workflow composition, a result journal, and replay. Current `pi-subagents` instead exposes parent/model-driven delegation plus a closed declarative chain grammar. Its public delegation API is one foreground text leaf, and its durable artifacts describe child runs rather than replayable Workflow calls.

The long-term architecture remains:

1. a trusted Workflow supervisor;
2. a selected script posture: explicitly trusted-only JavaScript, restricted
   orchestration IR, **or** a genuinely isolated JavaScript runner;
3. a Workflow-owned store, scheduler, journal, approval receipts, budgets, and UI state; and
4. `pi-subagents` as owner of transport-neutral, policy-enforcing leaf execution.

That target should be staged rather than made a prerequisite for learning. An optional non-release Phase 1A spike can wrap public delegation v1 with concurrency fixed at one and current `pi-subagents` authority. A concurrency-capable foreground release first needs a smaller upstream delegation/core change. Transport-neutral durable ownership belongs to Phase 2.

## Verdict vocabulary

| Verdict | Meaning |
| --- | --- |
| **Same** | The relevant observable contract is effectively the same in the stated narrow scope. |
| **Analogous** | It performs a similar job, but semantics, authority, or lifecycle differ. |
| **Materially different** | A recognizable counterpart exists, but substituting it would change the product contract. |
| **Absent** | No current counterpart exists in the inspected supported surfaces. |

## Product and user experience

| Area | Claude Dynamic Workflows v2.1.218 | Exact `pi-subagents` checkout | Verdict |
| --- | --- | --- | --- |
| Mental model | An approved deterministic script controls probabilistic workers and returns one aggregate ([CCW §1](claude-code-workflows.md#1-product-model-and-end-to-end-ux)). | Pi is the parent; child Pi sessions perform delegated work. Chains are declarative execution graphs, while prompt recipes guide the parent. | **Materially different** |
| Consent | Human-origin `ultracode`, direct request, named invocation, or session mode opts into orchestration; intent is separate from source approval. | Users invoke or allow the `subagent` tool and slash commands. There is no human-origin Workflow keyword or session policy. | **Materially different** |
| Source approval | The recovered launch path submits resolved script bytes through cancellation-default `permission_workflow`. | `clarify` edits launch parameters. No executable Workflow source exists to approve; child permission integration governs tool calls, not orchestration bytes. | **Absent** |
| Model-facing surface | `Workflow` launches code whose globals include `agent`, `parallel`, `pipeline`, `phase`, `log`, `args`, `budget`, and `workflow`. | One polymorphic `subagent` tool covers single, parallel, chain, and management calls; `subagent_wait` covers waiting. | **Analogous** |
| Named definitions | Saved JavaScript definitions execute in the Workflow engine and become slash commands. | Saved `.chain.md`/`.chain.json` definitions execute through `/run-chain`; prompt recipes are instructions, not engine programs. | **Materially different** |
| Live interaction | The script has no arbitrary mid-run user input; selected workers can be skipped or retried. | Clarification can precede launch; children can request supervisor decisions, and live children can be steered. | **Materially different** |
| Completion | Launch returns task/run IDs; completion is a bounded notification plus full artifact. | Foreground results stream inline; detached runs use status/result files and session-scoped delivery. | **Analogous** |
| Cost visibility | Completion reports token/tool totals; an output-token target controls new admissions with overshoot. | Status tracks tokens/cost and `/subagent-cost` reports child cost, but there is no Workflow-tree output-token pool. | **Materially different** |

The closest existing UX bundle is therefore **`subagent` + chains + Fleet/watch + async status/revival**, not a hidden Workflow implementation.

## Orchestration semantics

### Worker calls and values

Claude `agent(prompt, opts)` is an expression. It resolves to literal final text, a schema-validated value, selected `null` outcomes, or rejection; script code can branch on and reduce that value ([CCW §4](claude-code-workflows.md#4-worker-api-dataflow-failures-and-retries)).

The nearest Pi forms are a top-level single and one chain task. Chain tasks carry agent, prompt template, model, schema, phase/label, tool budget, and acceptance fields ([PS: `schemas.ts` 110–199](https://github.com/neumie/pi-subagents/blob/67ce1939977bdcdb32048fa0e4d387a48b22b729/src/extension/schemas.ts#L110-L199)). Internally, `SingleResult` already retains detailed usage, model attempts, structured output, artifacts, transcript, acceptance, and watchdog state ([PS: `types.ts` 585–630](https://github.com/neumie/pi-subagents/blob/67ce1939977bdcdb32048fa0e4d387a48b22b729/src/shared/types.ts#L585-L630)). Those rich results are not public Workflow expressions.

**Verdict: analogous leaf mechanics, materially different author contract.** A Workflow supervisor should preserve typed terminal outcomes and aligned slot identity. It may offer an explicit compatibility projection, but must not store Claude’s overloaded `null` as the authoritative outcome.

### `parallel()` and barriers

Claude `parallel()` accepts thunks, starts them concurrently, preserves input order, settles at a cohort barrier, and maps valid thunk rejections to aligned `null` slots.

Pi static parallel chain steps are genuine barriers: the outer executor awaits `runParallelChainTasks` before binding outputs and moving to the next chain step ([PS: `chain-execution.ts` 670–765](https://github.com/neumie/pi-subagents/blob/67ce1939977bdcdb32048fa0e4d387a48b22b729/src/runs/foreground/chain-execution.ts#L670-L765)). Failure semantics differ: failed children make the chain fail rather than becoming author-visible nullable values ([PS: `chain-execution.ts` 795–844](https://github.com/neumie/pi-subagents/blob/67ce1939977bdcdb32048fa0e4d387a48b22b729/src/runs/foreground/chain-execution.ts#L795-L844)).

**Verdict: analogous.** Existing parallel execution is reusable below the supervisor for declarative cohorts, but not as the general Workflow combinator.

### `pipeline()` and item-local lanes

Claude `pipeline(items, ...stages)` creates one serial lane per item. Item A may enter stage two while item B remains in stage one; one lane’s `null` or failure does not impose a stage-wide barrier.

Current chains iterate outer steps serially and await each static or dynamic cohort. Dynamic fan-out materializes one template over a bounded array and then collects in source order ([PS: `dynamic-fanout.ts` 217–289](https://github.com/neumie/pi-subagents/blob/67ce1939977bdcdb32048fa0e4d387a48b22b729/src/runs/shared/dynamic-fanout.ts#L217-L289)). Nested dynamic fan-out is rejected ([PS: `dynamic-fanout.ts` 183–207](https://github.com/neumie/pi-subagents/blob/67ce1939977bdcdb32048fa0e4d387a48b22b729/src/runs/shared/dynamic-fanout.ts#L183-L207)).

**Verdict: absent.** Repeating parallel chain steps inserts barriers and is not a faithful lowering. A Workflow supervisor must schedule item-local lanes.

### Dataflow, phases, logs, and child workflows

| Primitive | Existing Pi counterpart | Verdict |
| --- | --- | --- |
| JSON `args` and arbitrary deterministic transforms | String templates (`{task}`, `{previous}`, named outputs), JSON Pointer projection, ordered collection | **Materially different** |
| `phase(title)` | Declarative phase metadata and graph grouping | **Analogous** |
| `log(message)` | Progress/status updates, but no author-owned ordered Workflow log primitive | **Absent** |
| One-level `workflow()` with shared resources | Model-driven subdelegation may be configured; no chain node invokes another named chain with a shared Workflow resource domain | **Absent** |
| Arbitrary restricted-JS loops/branches/reducers | Closed chain shape with sequential, static parallel, and dynamic parallel nodes | **Absent** |

The graph snapshot is notably reusable presentation data: it emits phases, sequential nodes, static groups, materialized dynamic groups, current node, status, outputs, structured markers, acceptance, and errors ([PS: `workflow-graph.ts` 73–205](https://github.com/neumie/pi-subagents/blob/67ce1939977bdcdb32048fa0e4d387a48b22b729/src/runs/shared/workflow-graph.ts#L73-L205)). It is not a Workflow scheduler or replay journal.

## Leaf contract and resources

### What is strong today

`pi-subagents` has reusable mechanics that a leaf owner should retain:

- child Pi argument/environment construction, context mode, session placement, model fallback, thinking suffix, tool budgets, and cleanup;
- prompt rewriting that removes inherited project/skill sections when disabled, strips parent-only orchestration history, and installs a child boundary ([PS: `subagent-prompt-runtime.ts` 101–190](https://github.com/neumie/pi-subagents/blob/67ce1939977bdcdb32048fa0e4d387a48b22b729/src/runs/shared/subagent-prompt-runtime.ts#L101-L190));
- schema validation and a terminating `structured_output` capture ([PS: `subagent-prompt-runtime.ts` 381–416](https://github.com/neumie/pi-subagents/blob/67ce1939977bdcdb32048fa0e4d387a48b22b729/src/runs/shared/subagent-prompt-runtime.ts#L381-L416));
- detailed internal usage `{input, output, cacheRead, cacheWrite, cost, turns}` ([PS: `types.ts` 85–92](https://github.com/neumie/pi-subagents/blob/67ce1939977bdcdb32048fa0e4d387a48b22b729/src/shared/types.ts#L85-L92)); and
- artifacts, acceptance ledgers, transcripts, progress, fallback attempts, timeouts, watchdogs, and child controls.

The default child prompt is human/report oriented: it says the child is not the parent orchestrator and should complete an assigned task ([PS: `subagent-prompt-runtime.ts` 35–50](https://github.com/neumie/pi-subagents/blob/67ce1939977bdcdb32048fa0e4d387a48b22b729/src/runs/shared/subagent-prompt-runtime.ts#L35-L50)). A Workflow leaf needs a literal-return profile in which final text is machine-consumed data; acceptance reports and artifact wrappers must be separate fields rather than contaminating the value.

### Resources and caps

| Resource | Claude | Current `pi-subagents` | Verdict |
| --- | --- | --- | --- |
| Concurrency | Shared local semaphore, binary-attested `min(16, max(2, cores-2))`, shared with one child workflow | Chains and top-level parallel calls have per-invocation concurrency controls; each chain constructs a semaphore shared only within that execution. Delegation v1 is single-flight and rejects overlapping foreground dispatch. | **Materially different** |
| Lifetime calls | 1,000 `agent()` calls per Workflow tree | Session spawn budget exists; it is a different scope and accounting unit | **Absent at Workflow scope** |
| Shared token budget | Output-token admission target; in-flight work can overshoot | Per-child turn/tool limits and token/cost observations; no shared output-only pool | **Absent** |
| Collection cap | 4,096 items per `parallel`/`pipeline` is prompt-attested | Dynamic fan-out requires an effective `maxItems` and errors on excess ([PS: `dynamic-fanout.ts` 217–227](https://github.com/neumie/pi-subagents/blob/67ce1939977bdcdb32048fa0e4d387a48b22b729/src/runs/shared/dynamic-fanout.ts#L217-L227)); it is not Claude’s constant/scope | **Analogous** |
| Retry classes | Stall, user retry, throttle, structured correction, replay respawn, and provider retries remain distinct | Model fallback, timeout/watchdog, tool/turn nudges, and revival exist; no one Workflow attempt ledger | **Materially different** |
| Worktrees | Usually remove unchanged and preserve changed worktrees | Patch and cleanup behavior | **Materially different** |

A Workflow supervisor must own its semaphore, call/item counters, cancellation tree, combined attempt policy, expected-slot ledger, and aggregate usage. Existing session/leaf limits remain lower-level safety layers and should not be relabelled as Workflow limits.

## Persistence, revival, and ownership

Claude persists Workflow run state plus an append-only call journal. Resume recompiles and re-executes the script, reuses the longest unchanged successful prefix, and executes the incomplete/divergent suffix. It is neither VM continuation nor a general DAG cache ([CCW §6](claude-code-workflows.md#6-persistence-journal-replay-and-recovery-boundaries)).

`pi-subagents` detached execution creates a runner process with `detached:true`, file/ignored stdio, and `unref()` ([PS: `async-execution.ts` 401–457](https://github.com/neumie/pi-subagents/blob/67ce1939977bdcdb32048fa0e4d387a48b22b729/src/runs/background/async-execution.ts#L401-L457)). A recovery descriptor records the child’s model, thinking, tools, extensions, prompts, skills, output, acceptance, deadline, and budgets ([PS: `async-execution.ts` 1155–1195](https://github.com/neumie/pi-subagents/blob/67ce1939977bdcdb32048fa0e4d387a48b22b729/src/runs/background/async-execution.ts#L1155-L1195)). Status and result files support monitoring and reconciliation.

Revival selects a persisted child session file and launches a new follow-up against that conversation. Its prompt explicitly says not to assume the original process is alive ([PS: `async-resume.ts` 428–498](https://github.com/neumie/pi-subagents/blob/67ce1939977bdcdb32048fa0e4d387a48b22b729/src/runs/background/async-resume.ts#L428-L498)). Stale reconciliation repairs terminal status or marks a dead/stale runner failed; it does not respawn a Workflow call ([PS: `stale-run-reconciler.ts` 343–390](https://github.com/neumie/pi-subagents/blob/67ce1939977bdcdb32048fa0e4d387a48b22b729/src/runs/background/stale-run-reconciler.ts#L343-L390)).

| Event | Current behavior |
| --- | --- |
| Parent turn ends | Detached runner may continue. |
| Pi process exits | Detached runner may remain alive; process-local watchers are absent until Pi returns. |
| Different Pi session opens | Normal watcher/delivery/resume paths are exact-session scoped. |
| Runner dies | Reconciliation terminalizes failure; manual child revival may be possible. |
| Machine reboots | No durable daemon restarts the runner. |

**Verdict: materially different.** Child conversation revival is valuable leaf lifecycle, not Workflow journal replay, cache reuse, or adoption of a dead process.

The public background-work API reinforces this boundary. It registers a process-local `Symbol.for(...)` provider exposing only `{id, sessionId}`, optional wake channels, and optional reconciliation ([PS: `background-work.ts` 11–35, 115–130](https://github.com/neumie/pi-subagents/blob/67ce1939977bdcdb32048fa0e4d387a48b22b729/src/api/background-work.ts#L11-L35)). Snapshotting filters exact-session identities ([PS: `background-work.ts` 153–196](https://github.com/neumie/pi-subagents/blob/67ce1939977bdcdb32048fa0e4d387a48b22b729/src/api/background-work.ts#L153-L196)). It is visibility/wait integration—not result storage, cancellation, leasing, idempotency, reconciliation ownership, or adoption.

## UI, observability, and control

Claude `/workflows` is a run → phase → agent view backed by Workflow state and journals. It offers filtering plus pause/resume, stop, save, worker skip, and worker retry; pause means later replay, not a frozen VM ([CCW §7](claude-code-workflows.md#7-background-execution-progress-and-ui)).

The inspected Pi checkout has substantial reusable UI:

- native Fleet unifies active foreground, recent foreground, and async children ([PS: `fleet.ts` 19–58](https://github.com/neumie/pi-subagents/blob/67ce1939977bdcdb32048fa0e4d387a48b22b729/src/tui/fleet.ts#L19-L58));
- Fleet refreshes and preserves selection, but its keys only inspect, scroll, refresh, or close ([PS: `fleet.ts` 259–322](https://github.com/neumie/pi-subagents/blob/67ce1939977bdcdb32048fa0e4d387a48b22b729/src/tui/fleet.ts#L259-L322));
- watch exposes bounded task/status/model/thinking/tool/token/transcript data ([PS: `subagent-watch-data.ts` 8–94](https://github.com/neumie/pi-subagents/blob/67ce1939977bdcdb32048fa0e4d387a48b22b729/src/tui/subagent-watch-data.ts#L8-L94));
- watch polls output every 200 ms and targets every second ([PS: `subagent-watch.ts` 22–23](https://github.com/neumie/pi-subagents/blob/67ce1939977bdcdb32048fa0e4d387a48b22b729/src/tui/subagent-watch.ts#L22-L23), [307–320](https://github.com/neumie/pi-subagents/blob/67ce1939977bdcdb32048fa0e4d387a48b22b729/src/tui/subagent-watch.ts#L307-L320)); and
- the exact HEAD confines watch paths to direct run directories, validates indices, rejects final transcript-file symlinks, and bounds transcript reads ([PS: `subagent-watch.ts` 36–52, 84–93](https://github.com/neumie/pi-subagents/blob/67ce1939977bdcdb32048fa0e4d387a48b22b729/src/tui/subagent-watch.ts#L36-L52), [PS: `subagent-watch-data.ts` 200–247](https://github.com/neumie/pi-subagents/blob/67ce1939977bdcdb32048fa0e4d387a48b22b729/src/tui/subagent-watch-data.ts#L200-L247)).

**Verdict: analogous observability, materially different control.** Responsive overlays, roster/detail presentation, safe transcript reading, graph view-models, and status formatters are strong extraction candidates, but they are internal modules—not supported package imports. Reuse should happen through an upstream export or shared view-model seam, never a deep import or source copy. `pi-workflows` must still own Workflow run/phase/node state, journal/replay controls, source/save semantics, and whole-run completion. A thin `/workflows` projection should reuse shared presentation rather than clone the inspector stack.

## Security and authority

Neither system should be described through false sandbox equivalences:

- project trust approves project resource loading; it is not per-run source approval or isolation;
- tool lists and `pi.getActiveTools()` are selection metadata unless a trusted component enforces a final child capability ceiling;
- an acceptance role or prompt saying “read-only” is result guidance, not authorization;
- worktrees separate Git checkouts, not network, credentials, processes, or arbitrary host paths;
- separate child processes improve lifecycle separation, not containment; and
- Node `vm` is not a security boundary ([Node documentation](https://nodejs.org/api/vm.html#vm-executing-javascript)).

The checkout shows why tool configuration must be treated carefully. `--tools` is emitted only when at least one declared builtin tool exists, while extensions are separately loaded; ambient extensions are disabled only when `extensions` is explicitly supplied ([PS: `pi-args.ts` 141–177](https://github.com/neumie/pi-subagents/blob/67ce1939977bdcdb32048fa0e4d387a48b22b729/src/runs/shared/pi-args.ts#L141-L177)). Prompt stripping and environment depth/capability metadata are useful defense-in-depth, not OS authorization.

### Authority profile A — current `pi-subagents` authority

Use this only for the optional trusted Phase 1A spike:

- Workflow approval covers the Workflow definition/IR only.
- Agent discovery, precedence, specialist prompts, tools, extensions, skills, project-context behavior, model resolution, and cwd authority are exactly those already accepted for the installed `pi-subagents` configuration.
- Delegation v1 does not add a parent capability ceiling or prepare/approve pin.
- The product must not claim stricter Workflow leaf authorization, sandboxing, or reviewed specialist bytes.

### Authority profile B — hardened Workflow authority

Required before claiming stricter security than current delegation:

1. **prepare:** resolve canonical specialist, skill, extension, model, context, workspace, and effective capabilities; return provenance and content hashes without launching;
2. **approve:** bind Workflow source/IR, arguments, prepared leaf receipt, policy, limits, and workspace posture to an approval receipt; and
3. **run pinned:** verify the receipt and execute exactly those bytes/settings with deny-by-default tools, extensions, context, credentials, network, recursion, and workspace capabilities.

Any “read-only” claim requires enforced capability or OS policy. Any untrusted JavaScript claim requires a genuine external containment boundary; restricted IR can instead execute inside the trusted supervisor without being called an isolated runner.

## Supported APIs and integration boundary

The package exports only the root extension, `./background-work`, and `./delegation` ([PS: `package.json` 8–12](https://github.com/neumie/pi-subagents/blob/67ce1939977bdcdb32048fa0e4d387a48b22b729/package.json#L8-L12)); package tests freeze those public entrypoints ([PS: `package-manifest.test.ts` 42–63](https://github.com/neumie/pi-subagents/blob/67ce1939977bdcdb32048fa0e4d387a48b22b729/test/unit/package-manifest.test.ts#L42-L63)). Publishing internal `.ts` files does not make deep imports a supported API.

Delegation v1 is a strict versioned event contract. Its request carries request ID, agent/task, fresh/fork context, cwd, optional model, timeout, turn/tool budgets, skills, output, acceptance, and artifacts ([PS: `delegation.ts` 76–92](https://github.com/neumie/pi-subagents/blob/67ce1939977bdcdb32048fa0e4d387a48b22b729/src/api/delegation.ts#L76-L92)). Updates carry progress and aggregate tokens; terminal responses carry explicit status, output, paths, session, acceptance, turns, tool count, duration, and aggregate tokens ([PS: `delegation.ts` 94–156](https://github.com/neumie/pi-subagents/blob/67ce1939977bdcdb32048fa0e4d387a48b22b729/src/api/delegation.ts#L94-L156)).

Its verified limits are load-bearing:

- one single foreground leaf per request;
- active `ExtensionContext` required by the bridge;
- no output schema/structured value;
- no separate thinking field;
- no detailed input/output/cache/cost usage;
- no parent capability ceiling; and
- independent foreground dispatch is rejected by extension-global `subagentInProgress` ([PS: `subagent-executor.ts` 3946–3965](https://github.com/neumie/pi-subagents/blob/67ce1939977bdcdb32048fa0e4d387a48b22b729/src/runs/foreground/subagent-executor.ts#L3946-L3965)).

The internal RPC is not a substitute: it is unexported, event-bus/context bound, supports only `ping/status/spawn/interrupt/stop` ([PS: `rpc.ts` 14–31](https://github.com/neumie/pi-subagents/blob/67ce1939977bdcdb32048fa0e4d387a48b22b729/src/extension/rpc.ts#L14-L31)), and forces spawn detached ([187–213](https://github.com/neumie/pi-subagents/blob/67ce1939977bdcdb32048fa0e4d387a48b22b729/src/extension/rpc.ts#L187-L213)). Every non-ping call requires active context ([PS: `rpc.ts` 278–298](https://github.com/neumie/pi-subagents/blob/67ce1939977bdcdb32048fa0e4d387a48b22b729/src/extension/rpc.ts#L278-L298)). Do not promote it to a daemon protocol.

## Four-way reuse matrix

| Decision | Surface | Boundary |
| --- | --- | --- |
| **Use as-is** | `pi-subagents/background-work` | Process-local visibility, waiting, wake discovery, and headless integration only. Workflow store remains truth. |
| **Wrap** | Public delegation v1 | Optional non-release Phase 1A spike: the `pi-workflows` adapter queues calls at concurrency one because overlapping bridge dispatch is rejected; text only, active context, current authority, typed terminal statuses. |
| **Extract or export** | Concurrent owned single-leaf dispatch | Minimum foreground-release prerequisite; supervisor, not leaf API, owns Workflow ordering/semaphore. |
| **Extract or export** | Structured leaf value and detailed usage | Adapt existing `SingleResult.structuredOutput` and `Usage` into a stable public DTO. |
| **Extract or export** | Fleet/watch presentation, safe readers, and graph/nested view-models | Valuable code exists, but it is not publicly exported. Add a supported shared seam rather than deep-importing or copying it. |
| **Extract or export** | Long-term transport-neutral leaf ownership | Phase 2: idempotent owner/request identity, reconciliation, cancellation, leases/broker, notification ownership, and durable results. |
| **Extract or export** | Hardened prepare/run-pinned provenance | Needed only when stricter Workflow authority is promised. |
| **Do not reuse** | Current chain executor as the Workflow scheduler | Saved chains remain useful alongside the port, but barriers, closed topology, and failure semantics cannot supply general thunks or item-local `pipeline()`. |
| **Do not reuse** | Internal extension RPC as daemon transport | It is unexported, context-bound, unauthenticated process-local plumbing. |
| **Do not reuse** | Background-work registry as run store/controller | It has no results, controls, leases, idempotency, or adoption. |
| **Do not reuse** | Internal mixed executor or shared types as public wire contract | They couple `ExtensionContext`, callbacks, Pi messages, mutable state, and UI concerns. Define small JSON DTOs. |
| **Do not reuse** | Leaf artifacts as Workflow persistence | Leaf files are not an immutable manifest, append-only journal, atomic Workflow store, or retention policy. |
| **Do not reuse** | `node:vm`, worktree, process separation, prompt boundaries, or acceptance as a sandbox | None is a security boundary. |

## Contribution map without double counting

### Upstream contribution

[`8d2c05e51ce58923dea504b4530dc2643cb25c54`](https://github.com/nicobailon/pi-subagents/commit/8d2c05e51ce58923dea504b4530dc2643cb25c54) is the upstream squash for PR [#454](https://github.com/nicobailon/pi-subagents/pull/454), “add native fleet and companion display hooks.” Claim it once. It includes the companion-display contract: suppression of the built-in async widget, bounded task/goal metadata, current-session recent jobs, Fleet wiring, and lifecycle tests.

**Provenance caveat:** the old PR branch ended with Nico Bailon’s discrete native Fleet follow-up [`8fdb224`](https://github.com/nicobailon/pi-subagents/commit/8fdb224f5c30c696c85be4fd458c2e513d9c166f). The old tip and upstream squash have the same aggregate tree, so upstream Git attributes the squash to Jakub while pre-squash history attributes that discrete Fleet commit to Nico. Do not separately claim `8fdb224` as Jakub-authored.

### Fork-only line in this exact HEAD

The fork-only watcher line was consolidated and ported to v0.35.1 by [`dc65d0af7ce9cc8aa247affa6fb3897b5e4982f2`](https://github.com/neumie/pi-subagents/commit/dc65d0af7ce9cc8aa247affa6fb3897b5e4982f2). Count either the granular watcher development line or this consolidated port, never both. The line includes read-only watch, responsive/task-aware layout, live activity, metadata hardening, and [`63bb6f8e404e76a42704b012fa1342352a80bf20`](https://github.com/neumie/pi-subagents/commit/63bb6f8e404e76a42704b012fa1342352a80bf20), which makes Pi Lens child startup default to quick behavior unless explicitly overridden. The behavior is visible at [PS: `pi-args.ts` 105–109](https://github.com/neumie/pi-subagents/blob/67ce1939977bdcdb32048fa0e4d387a48b22b729/src/runs/shared/pi-args.ts#L105-L109).

Exact HEAD [`67ce193`](https://github.com/neumie/pi-subagents/commit/67ce1939977bdcdb32048fa0e4d387a48b22b729) adds unique watcher hardening: direct-run-directory confinement, safe indices, final transcript-file symlink rejection, and no-follow transcript reads. This is additive to the consolidated line.

### Separate branch, not in HEAD

[`53cc0c966e8001a247bf2906d64242fcc8c03452`](https://github.com/neumie/pi-subagents/commit/53cc0c966e8001a247bf2906d64242fcc8c03452) is a separate fork-only wake fix that makes an idle parent start a turn for a supervisor request. It is **not an ancestor of the inspected HEAD** and must not be described as current checkout behavior.

### Excluded duplicates

The original/rebased companion commits are semantic duplicates of the upstream squash, not extra contributions. The watcher development commits and `dc65d0a` represent one logical line. Merge [`237edf7`](https://github.com/neumie/pi-subagents/commit/237edf7715f20b5af97dbe79bf1e1d57b39c5e66) is synchronization: its tree equals its `dc65d0a` second parent and must not be counted as a feature. These duplicate/rebased commits and the merge are excluded from contribution totals.

## Test evidence

### Baseline observed during this audit

The exact checkout was exercised more than once:

- the first unit run reported **1,331 total / 1,327 pass / 3 fail / 1 skip**;
- an independent full unit rerun reported **1,331 total / 1,329 pass / 1 fail / 1 skip**;
- integration, run separately, reported **617 total / 615 pass / 2 skip**; and
- E2E, run separately, passed **2/2**.

The first unit run failed two child-boundary tests—supervisor-tool registration and missing requested-tool diagnostics ([PS: `subagent-prompt-runtime.test.ts` 605–661](https://github.com/neumie/pi-subagents/blob/67ce1939977bdcdb32048fa0e4d387a48b22b729/test/unit/subagent-prompt-runtime.test.ts#L605-L661))—plus malformed language-server JSON handling ([PS: `watchdog-lsp-diagnostics.test.ts` 93–117](https://github.com/neumie/pi-subagents/blob/67ce1939977bdcdb32048fa0e4d387a48b22b729/test/unit/watchdog-lsp-diagnostics.test.ts#L93-L117)). The boundary file then passed **31/31** both in isolation and within the independent full rerun. Those two failures are therefore order/interference-sensitive observations, not reproduced source failures.

The watchdog test remained the sole failure in the full rerun and failed **1/5** when rerun alone: the implementation returned `timeout` where the test expected `failed`. It is outside the Workflow leaf boundary, but it means the pinned checkout did not have a fully green unit baseline during this audit. None of these failures was caused by `pi-workflows`; no implementation existed or ran.

Existing coverage is broad around foreground/async execution, chains, fan-out, structured capture, worktrees, lifecycle, session leases, Fleet/watch, delegation parsing, and background-work validation. The public delegation tests use a fake event bus/executor; the two E2E tests use a real Pi session and child process with a faux provider. This does not yet prove a Workflow consumer contract.

### Minimum new release tests

Do not reproduce the whole backend matrix. Add the smallest cross-boundary suite that proves the selected release:

1. real inter-extension delegation through start/update/one terminal response, including cancel and extension reload;
2. concurrent owned singles with stable IDs/order, explicit duplicate-ID status, cancellation races, and no duplicate terminal delivery;
3. valid, invalid, missing, and oversized structured results through the public contract;
4. detailed usage propagation into the Workflow ledger and a tested Pi tool-result usage adapter—pending `execute()` alone is insufficient;
5. exact authority-profile tests: current-authority disclosure for the spike; prepare/approve/run-pinned provenance and deny-by-default capabilities for hardened release;
6. Workflow scheduler tests for barriers, true item-local lanes, typed failures, caps, cancellation, and in-flight budget overshoot;
7. crash/reload tests for journal monotonicity and, in Phase 2, idempotency/reconcile/broker ownership; and
8. safe filesystem/UI tests for run artifacts, transcript projection, hostile metadata, and branch/session completion routing.

## Staged architecture

### Optional Phase 1A — non-release learning spike

Prefer a restricted IR in the trusted extension and use a Promise adapter over
public delegation v1. Explicitly trusted-only JavaScript is a user-selected
alternative, not an accidental default:

- active extension context required;
- exactly one foreground leaf at a time, queued by the `pi-workflows` adapter
  because overlapping bridge dispatch is rejected;
- text results only;
- current `pi-subagents` authority profile;
- explicit typed terminal outcomes;
- pending tool for cancellation and progress;
- Workflow-local event/result log with no automatic cache reuse; and
- no schema, concurrency, daemon, hardened authorization, or accurate
  detailed-usage claim.

This spike validates the selected orchestration language, scheduler shape,
result semantics, approval UX, and UI projection. It is not a release candidate
and must not advertise Claude parity.

### Phase 1B — concurrency-capable foreground release

The minimum upstream delegation/core change is narrower than the long-term
daemon API:

- concurrent **owned single** requests; the Workflow supervisor remains the
  scheduler;
- schema input and structured terminal value;
- detailed input/output/cache/cost/turn usage, preferably monotonic in progress;
- explicit duplicate active-ID response rather than dropped or ambiguous
  behavior; and
- typed terminal outcomes preserved end to end.

Separate thinking is desirable and should be added when practical, but need not
block this release if model-suffix behavior and effective model are documented.
This release still uses an active extension context and need not claim daemon
independence.

Keeping `execute()` pending helps lifecycle: it retains the parent abort path,
allows `onUpdate`, and provides a place to return nested usage. **It does not by
itself solve Pi nested usage accounting.** Delegation must expose full usage,
and `pi-workflows` must adapt it into Pi’s documented nested-usage result shape
with an integration test against session/RPC totals. Until then the Workflow
store is the authoritative ledger.

### Stricter Workflow security

If the product claims authority narrower than ordinary installed
`pi-subagents`, add prepare/approve/run-pinned provenance and deny-by-default
capabilities. Approval must bind exact Workflow bytes/IR, args, resolved
specialist/skills/extensions/context/model, policy, and limits. Do not infer
authorization from project trust, tool lists, acceptance, worktrees, separate
processes, or `node:vm`.

### Durable Phase 2

Durability requires transport-neutral leaf ownership, not just detached children:

- stable owner-run/request identities and payload hashes;
- idempotent attach-or-return behavior;
- durable result and progress records;
- cancellation/control acknowledgements;
- reconcile after adapter/process loss;
- leases and authenticated broker/runner transport;
- notification ownership and branch/session-safe adoption; and
- a Workflow-owned store and replay policy.

`pi-subagents/background-work` remains useful visibility/wait plumbing only.
It is not the broker or task owner.

## Ownership recommendation

| Owner | Responsibilities |
| --- | --- |
| `pi-workflows` | Definition/IR and source approval, trusted supervisor, scheduling, true pipeline, typed slot policy, aggregate caps/budgets, Workflow journal/store, cache/replay policy, Workflow UI/control state, completion and branch policy. |
| `pi-subagents` | Specialist and child Pi lifecycle, model/thinking/tool/context resolution, structured capture, per-leaf limits/retries, sessions/transcripts, artifacts/worktrees, progress/control events, detailed usage, and long-term owned-leaf execution API. |
| Pi host | Extension lifecycle, model-facing tool contract, pending result/update/abort plumbing, session tree, TUI/RPC mode surfaces, and documented nested-usage accounting. |
| External isolation layer (if selected) | Actual CPU, memory, process, filesystem, network, credential, environment, and process-tree containment. |

## Recommended sequence and release gates

1. **Decide product/security scope.** Choose restricted IR, explicitly
   trusted-only JavaScript, or genuinely isolated JavaScript; choose current
   versus hardened leaf authority; choose read-only/writer workspace policy.
2. **Optionally run Phase 1A.** Queue delegation-v1 calls in the adapter at
   concurrency one; text only, non-release, current authority, no parity claims.
3. **Upstream the foreground minimum.** Concurrent owned singles, structured
   values, detailed usage, and an explicit duplicate-ID response; separate
   thinking if feasible.
4. **Build the foreground supervisor.** Typed outcomes, true item-local lanes,
   shared semaphore/caps, explicit budget semantics, source approval, Workflow
   store, and reused Pi UI primitives.
5. **Pass release gates.** Green/reconciled backend baseline; real consumer E2E;
   concurrency/cancel/schema/usage tests; selected authority and isolation
   tests; branch-safe completion; no false sandbox claims.
6. **Only then choose Phase 2 durability.** Extract transport-neutral leaf
   ownership and add idempotency, reconcile, leases, authenticated broker, and
   adoption. Do not promote internal RPC or background-work to that role.
7. **Add parity extras later.** Reviewed JavaScript if IR is insufficient,
   stronger memoization, nested workflows, pause/skip/retry UX, and expanded
   worktree policies.

## User decisions required before implementation

- **Language and trust:** restricted IR, trusted-only JavaScript, or mandatory
  external isolation?
- **Authority:** inherit current `pi-subagents` configuration, or require
  prepare/approve/run-pinned hardened leaves?
- **Compatibility:** exact Claude-like projections where evidenced, or Pi-native
  typed outcomes and stronger cache keys?
- **Definitions and approval:** supported directories, precedence, per-run/hash
  approval, and noninteractive denial policy?
- **Capabilities:** project context, skills, extensions, tools, MCP, network,
  credentials, recursion, and specialist exceptions?
- **Resources:** concurrency, call/item limits, output-token versus dollar
  budget, warnings, rate sublimits, and overshoot disclosure?
- **Workspace:** trusted ordinary cwd, patch-producing worktrees, or externally
  enforced read-only/writer isolation?
- **Persistence:** event log only, disabled cache, or later hardened memoization;
  retention, permissions, redaction, and deletion?
- **Foreground UX:** command/tool names, collision behavior, progress,
  cancellation, result presentation, and mode-specific approval?
- **Phase 2:** whether detached durability is required; lifecycle by
  TUI/RPC/JSON/print mode; completion/adoption policy; platform scope; detached
  usage disclosure?

No implementation should be represented as complete until these choices and the
matching release gates are resolved.
