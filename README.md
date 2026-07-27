# pi-subagents-workflows

`pi-subagents-workflows` is a foreground orchestration add-on for
[`pi-subagents`](https://github.com/nicobailon/pi-subagents). It provides a
strict JSON workflow definition format, a deterministic scheduler, and a Pi
tool/command adapter while leaving child-agent execution and policy in
`pi-subagents`.

**Status: the restricted IR v1 parser, sequential/barriered-parallel/item-local
pipeline engine, public delegation-v2 adapter, strict source/audit layer, shared
foreground service, bounded renderer, `pi_workflow` model tool, and
`/pi-workflow` command are implemented.** Focused and provider-free unit gates
are green, and the adapter is artifact-tested against the supported published
`pi-subagents` 0.36.0 and 0.37.0 releases. Packed real-Pi sessions also pass
through the actual provider extension for both releases. Local Node 24 unit,
package, provider-matrix, correctness-review, and security-review gates are
green. The package is not published yet: native Ubuntu/Windows CI and
filesystem/ACL/reparse gates still have to pass. See [PLAN.md](PLAN.md) for the
TDD and release contract.

## Current branches and identity

- `feat/build-workflow-extension` preserves the research and pre-code contract.
- `chore/establish-pi-subagents-workflows` contains the identity scaffold.
- `feat/foreground-workflow-ir-v1` is the current consumer branch.
- Delegation v2 shipped in `pi-subagents@0.36.0`; 0.37.0 is the current
  supported release. The historical provider feature branch is retained only
  for provenance.

The repository, canonical local directory, and npm package use the full name
`pi-subagents-workflows`. The GitHub repository is
<https://github.com/neumie/pi-subagents-workflows>; npm publication still waits
for the release gates.

## Selected decisions

- **Definition language:** restricted, strict JSON IR; no workflow JavaScript.
- **Delivery:** phased full foreground build—IR,
  sequential/parallel/pipeline engine, provider adapter, and Pi
  tool/command—rather than a v1 spike release.
- **Leaf authority:** current installed `pi-subagents` authority. The add-on
  will not claim a stricter sandbox or capability boundary.
- **Integration:** public delegation v2 only, with no deep imports or silent
  delegation-v1 fallback.
- **Lifecycle:** foreground first. Daemon, replay, leases, reconciliation, and
  adoption are blocked until the full foreground matrix is green.
- **Identity:** full repository and package rename from `pi-workflows` to
  `pi-subagents-workflows`.

## Workflow provenance and foreground audit

The extension resolves three explicit definition source kinds: inline JSON,
exact saved names, and capability-gated user paths. The model-facing tool may
use only inline or saved definitions. Explicit paths are available only through
the user command. Saved names are lowercase bounded identifiers and resolve
non-recursively from only:

```text
<agent-dir>/pi-subagents-workflows/definitions/<name>.workflow.json
<cwd>/.pi/workflows/<name>.workflow.json
```

A name present in both roots is rejected as ambiguous. File reads accept only
regular `*.workflow.json` files up to 1 MiB, reject duplicate JSON keys, links,
and unsafe encoding, and retain the exact accepted UTF-8 text and SHA-256 audit
provenance. Reads detect observable path/content replacement before returning.
Arbitrary path sources are denied without the explicit user-command
capability; the `pi_workflow` model tool never receives that capability.

The internal foreground run store derives a session directory from the SHA-256
of the caller-supplied stable Pi session identity and writes per-run
`manifest.json`, `source.workflow.json`, `args.json`, and `journal.jsonl`, plus
`result.json` only after settlement. Immutable files use atomic no-replace
publication. Full leaf terminals remain in the append-only journal; the result
file is a strictly validated terminal summary (status, final ref, aggregate
usage/counters, and optional workflow error) capped at 1 MiB, so it neither
duplicates retained payloads nor becomes replay input. The journal is streamed
with a 512 MiB file ceiling and 4 MiB per-record ceiling, omits transient
`leaf_progress`, is inspection-only, and is never execution or recovery input.
Validated listing APIs cap each scanned directory at 10,000 entries,
stream-check the journal, and expose only saved-definition provenance and run
audit summaries.

A stored run without a result is labeled `incomplete (not running; rerun
explicitly)`. These files do **not** provide resume, replay, cache reuse,
adoption, daemon survival, detached execution, or exactly-once external
effects. Running also never creates or changes saved definitions. POSIX modes
are restrictive where supported, but this foreground audit layer is not a
sandbox against an active same-account/privileged process that swaps filesystem
ancestors between Node path operations; native Windows reparse/ACL and hostile
same-UID namespace hardening remain explicit Phase 14 release tests. Audit files
can contain prompts and retained results and are not automatically deleted.

Each foreground launch also writes bounded, versioned advisory start/terminal
pointers to the current Pi session branch. Restoration descriptor-checks only
a bounded tail of `sessionManager.getBranch()` and never invokes entry
accessors. Pointers are never ownership, replay, or recovery state. Session
shutdown closes host admission before awaiting anything, cancels only runs
owned by the current extension instance, waits for bounded cleanup, and
disposes its cwd-scoped provider adapters. A late source resolution cannot
reopen the stale extension instance.

## Pi tool and command

The model tool is `pi_workflow`. It accepts a strict inline definition or an
exact saved name plus an arguments object, runs once in the foreground, streams
bounded progress summaries, and returns a bounded result plus exact nested Pi
usage. It does not accept paths and cannot save, resume, replay, detach, or
adopt a run.

The user command exposes only these forms:

```text
/pi-workflow run --name <name> [--args <JSON-object>]
/pi-workflow run --path <path.workflow.json> [--args <JSON-object>]
/pi-workflow list
/pi-workflow status [runId]
/pi-workflow cancel <runId>
```

TUI command runs use a cancellable foreground loader; Escape closes the modal
immediately while the command still awaits owned audit/provider cleanup.
Print/RPC mode awaits the same shared service directly. `cancel` targets an
exact active run ID. A stored
incomplete audit is reported as not running and must be rerun explicitly.
There is intentionally no save, resume, detach, daemon, or background command.

## Provider adapter

`createPiSubagentsLeafAdapter({ events, cwd, context? })` is exported from the
package root. It loads only the public `pi-subagents/delegation` subpath at
runtime, requires protocol version 2, defaults to fresh context, and leaves
model, thinking, skill, artifact, and other authority policy to the installed
provider. Each adapter returns a `leafRunner` for `executeWorkflow` and an
idempotent `dispose()` method. The package pins the supported runtime range
`pi-subagents >=0.36.0 <0.38.0`; malformed or incompatible public v2 exports
reject with `PiSubagentsV2UnavailableError`. There is no delegation-v1
fallback.

The adapter shares one response listener and one update listener per event bus,
uses exact owned-attempt cancellation tuples, defensively validates untrusted
provider payloads, and exposes only engine terminal/progress values—not raw
provider DTOs or metadata.

## Published provider contract

Delegation v2 is published in `pi-subagents@0.36.0` and remains supported in
0.37.0. The public contract provides:

- concurrent owned single-agent dispatch;
- stable logical `ownerRunId` / `nodeId` identity with a fresh `requestId` for
  each dispatch attempt;
- literal text and schema-validated structured terminal values;
- requested/effective thinking and model information;
- detailed input, output, cache, cost, and turn usage;
- explicit duplicate-node rejection and exact correlated cancellation;
- at-most-once terminal delivery;
- typed `structured_output_failed` terminals; and
- strict delegation-v1 compatibility without changing model-facing tool
  behavior.

CI downloads the immutable 0.36.0 and 0.37.0 registry tarballs, verifies their
reviewed SHA-256 digests, and runs the packed consumer adapter matrix against
both. The `pi-subagents` extension must still be enabled in Pi: installing this
package provides the protocol dependency but does not silently activate the
provider extension or widen child authority.

## IR v1 example

The grammar is frozen by parser tests. This illustrative JSON shows a valid
restricted definition with explicit references and templates, ordered steps,
bounded output modes, and one final-result reference.

```json
{
  "version": 1,
  "id": "review-topic",
  "args": {
    "topic": { "type": "string" }
  },
  "limits": {
    "concurrency": 2,
    "maxCalls": 3,
    "maxItems": 1
  },
  "steps": [
    {
      "type": "agent",
      "id": "draft",
      "agent": "researcher",
      "prompt": {
        "template": "Research {{topic}}",
        "values": {
          "topic": { "ref": "arg", "name": "topic" }
        }
      },
      "output": { "mode": "text" },
      "limits": {
        "timeoutMs": 120000,
        "maxTurns": 8,
        "maxToolCalls": 20
      },
      "meta": { "phase": "Draft" }
    },
    {
      "type": "parallel",
      "id": "checks",
      "tasks": [
        {
          "id": "accuracy",
          "agent": "reviewer",
          "prompt": {
            "template": "Check accuracy:\n{{draft}}",
            "values": {
              "draft": { "ref": "step", "stepId": "draft" }
            }
          },
          "output": { "mode": "text" },
          "limits": {
            "timeoutMs": 120000,
            "maxTurns": 6,
            "maxToolCalls": 10
          }
        },
        {
          "id": "clarity",
          "agent": "reviewer",
          "prompt": {
            "template": "Check clarity:\n{{draft}}",
            "values": {
              "draft": { "ref": "step", "stepId": "draft" }
            }
          },
          "output": { "mode": "text" },
          "limits": {
            "timeoutMs": 120000,
            "maxTurns": 6,
            "maxToolCalls": 10
          }
        }
      ],
      "meta": { "phase": "Check" }
    }
  ],
  "result": { "ref": "step", "stepId": "checks" }
}
```

IR v1 parses and executes sequential `agent` steps, barriered `parallel`
cohorts, and true item-local `pipeline` stages through one fair FIFO
workflow-wide semaphore. A pipeline reserves its complete actual item and stage
slot count atomically, starts one serial lane per source item, and lets a lane
enqueue its next stage as soon as that item succeeds—there is no stage-wide
barrier. `stop-item` materializes later stages as `upstream_failed`; caller or
hook cancellation instead aligns all not-yet-reached stages as `cancelled`.
Other lanes and later top-level steps continue after ordinary failures or a
pipeline admission error.

Parallel and pipeline groups retain typed partial failures and expose bounded,
deterministic source-aligned projections to later templates. A final group
reference succeeds with its complete aligned outcome, including partial leaf
failures or an inspectable `limit_exceeded` admission error; caller cancellation
still wins. Pipeline item status is the first non-success stage status, or
`succeeded` when every stage succeeds. Group projections and prompt templates
are rendered with an incremental 256 KiB UTF-8 ceiling. Successful text and
structured values use an effective per-result cap of
`min(1 MiB, floor(64 MiB / definition.limits.maxCalls))`, bounding retained
successful-result payloads to 64 MiB per workflow; oversize provider results
become typed `provider_contract_violation` failures. Every reported usage field is capped per leaf at
`floor(Number.MAX_SAFE_INTEGER / definition.limits.maxCalls)`; the input,
output, cache-read, and cache-write token subtotal must also fit within that
same cap. Integer usage fields must still be safe integers, and reported
turns/tool calls must still respect their leaf limits. This ensures that at
most `maxCalls` accepted usages—and Pi's derived `totalTokens`—cannot overflow
later aggregation. Accepted usage and `leaf_terminal` events
are accounted exactly once in item/stage source order, independent of settlement
order. Progress delivery retains at most eight pending updates per active leaf
and excess updates are ignored. Unknown fields,
implicit string references, forward or invalid references, missing template
values, unsupported policies, and malformed schemas or limits fail parsing.

## Phased roadmap

1. Rebase the provider feature branch onto upstream and classify its baseline.
2. Specify delegation v2 with failing compatibility/contract tests.
3. Implement strict DTO parsing and concurrent owned-single execution.
4. Prove duplicate, cancellation, reload, structured-output, usage, and provider
   release behavior.
5. Establish the final `pi-subagents-workflows` package identity and CI.
6. Build strict IR v1 through a parser red-green slice.
7. Build sequential typed execution, barriered parallel execution, and
   item-local pipelines as separate red-green slices.
8. Add the public `pi-subagents` `LeafRunner` adapter. **Implemented against
   the published 0.36/0.37 provider range.**
9. Add strict definition provenance and the foreground-only run audit store.
   **Implemented and independently reviewed.**
10. Add the shared foreground run service, renderer, Pi tool, and command.
    **Implemented, including packed real-extension acceptance.**
11. Pass packed-package, security, provider-matrix, Node 24 Ubuntu/Windows, and
    real-extension release gates. **Provider artifact and real-extension
    matrices are green; native platform and final review gates remain.**
12. Only then open a separately reviewed daemon design phase.

See the [full build contract](PLAN.md#phases-and-red-green-slices) for branches,
commit boundaries, validation gates, stop rules, and the one-writer policy.

## Development and tests

Node 24 or newer is required. Dependency lifecycle scripts stay disabled for
scaffold installation and packaging checks.

```sh
npm ci --ignore-scripts
npm run test:unit
npm run typecheck
npm test
npm run pack:check
```

`npm test` remains provider-extension-free: it does not start child agents or
load the provider extension. It runs the parser, engine, fake-bus adapter,
foreground service/host adapter, source/store, manifest/tarball, and strict
typecheck suites. The separately required provider artifact gate fails clearly
unless a tarball is supplied:

```sh
PI_SUBAGENTS_TARBALL=/path/to/pi-subagents.tgz \
PI_SUBAGENTS_TARBALL_SHA256=<optional-reviewed-sha256> \
npm run test:provider-artifact
```

That smoke gate packs this consumer, creates a temporary clean fixture outside
the repository, installs both tarballs without lifecycle scripts or a lockfile,
loads their installed public exports through Jiti, and executes the real adapter
over a fake event bus. It proves public artifact resolution and request/response
compatibility at the exported seam; it does not instantiate the provider
extension handler. There is no committed provider artifact or path. CI runs
this gate against SHA-256-pinned 0.36.0 and 0.37.0 registry tarballs.

The companion real-extension gate uses the same tarball variables:

```sh
PI_SUBAGENTS_TARBALL=/path/to/pi-subagents.tgz \
PI_SUBAGENTS_TARBALL_SHA256=<optional-reviewed-sha256> \
npm run test:provider-extension-e2e
```

It loads the packed manifest-declared Workflow and provider extensions into a
real Pi session, dispatches one leaf through the real delegation handler to a
test-owned faux-provider child process, and verifies exact result delivery,
branch pointers, terminal audit state, and shutdown. It makes no network model
calls. This gate is green against both supported provider releases.

## Research

- [Research and evidence index](research/README.md)
- [Exact-checkout `pi-subagents` comparison][comparison]
- [Claude Code Dynamic Workflows synthesis](research/claude-code-workflows.md)
- [Build contract](PLAN.md)

[comparison]: research/pi-subagents-comparison.md

The research documents describe observed reference behavior and earlier staged
alternatives. Where they present unresolved choices, the fixed decisions in
this README and `PLAN.md` now govern this project.

## License

[MIT](LICENSE)
