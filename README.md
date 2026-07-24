# pi-subagents-workflows

`pi-subagents-workflows` is a planned add-on for
[`pi-subagents`](https://github.com/nicobailon/pi-subagents). It will provide a
strict JSON workflow definition format, a deterministic foreground scheduler,
and a Pi tool/command adapter while leaving child-agent execution and policy in
`pi-subagents`.

**Status: strict restricted IR v1 parser, sequential/barriered-parallel/item-local
pipeline execution, and the public delegation-v2 leaf adapter implemented.**
The package identity, public IR and engine types, immutable definition parser,
shared workflow semaphore, typed aligned execution seam, provider adapter,
no-op extension entry point, tests, and CI exist. The Workflow tool/command and
published npm package do not exist yet. The adapter is artifact-tested against
reviewed provider commit `f936daa`, but a runtime `pi-subagents` dependency
cannot be added until that provider seam is published. See
[PLAN.md](PLAN.md) for the TDD and release contract.

## Current branches and identity

- `feat/build-workflow-extension` preserves the research and pre-code contract.
- `chore/establish-pi-subagents-workflows` contains the identity scaffold.
- `feat/foreground-workflow-ir-v1` is the current consumer branch.
- The provider branch is `feat/add-workflow-delegation-v2` in
  `pi-subagents`, rebased onto current upstream before feature edits.

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

## Provider adapter

`createPiSubagentsLeafAdapter({ events, cwd, context? })` is exported from the
package root. It loads only the public `pi-subagents/delegation` subpath at
runtime, requires protocol version 2, defaults to fresh context, and leaves
model, thinking, skill, artifact, and other authority policy to the installed
provider. Each adapter returns a `leafRunner` for `executeWorkflow` and an
idempotent `dispose()` method. Missing or malformed v2 providers reject with
`PiSubagentsV2UnavailableError`; there is no delegation-v1 fallback.

The adapter shares one response listener and one update listener per event bus,
uses exact owned-attempt cancellation tuples, defensively validates untrusted
provider payloads, and exposes only engine terminal/progress values—not raw
provider DTOs or metadata.

## What must land in pi-subagents first

A foreground release still depends on publishing the reviewed delegation-v2
seam in `pi-subagents`, which provides:

- concurrent owned single-agent dispatch;
- stable logical `ownerRunId` / `nodeId` identity with a fresh `requestId` for
  each dispatch attempt;
- literal text and schema-validated structured terminal values;
- requested/effective thinking and model information;
- detailed input, output, cache, cost, and turn usage;
- explicit duplicate-node rejection and exact correlated cancellation;
- at-most-once terminal delivery; and
- strict v1 compatibility without changing model-facing tool behavior.

The provider branch must first be rebased onto current upstream and its
baseline failures classified. A v2-capable provider release or RC is required
before this add-on pins a final dependency range.

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
become typed `provider_contract_violation` failures. Every reported usage field
is capped per leaf at
`floor(Number.MAX_SAFE_INTEGER / definition.limits.maxCalls)`; integer usage
fields must still be safe integers, and reported turns/tool calls must still
respect their leaf limits. This ensures that at most `maxCalls` accepted usages
cannot overflow later aggregation. Accepted usage and `leaf_terminal` events
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
8. Add the public `pi-subagents` `LeafRunner` adapter. **Implemented and green
   against the reviewed provider artifact; dependency publication remains
   blocked upstream.**
9. Add the foreground Pi tool and command adapter.
10. Pass packed-package, security, provider-matrix, Node 24 Ubuntu/Windows, and
    real-extension release gates.
11. Only then open a separately reviewed daemon design phase.

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

`npm test` remains provider-free and runs the unit parser, engine, adapter fake
bus, manifest/tarball contracts, and strict typecheck. The separately required
provider artifact gate fails clearly unless a tarball is supplied:

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
extension handler. There is no committed provider artifact or path. The real
cross-extension Pi integration suite remains a Phase 14 gate because the
Workflow tool/command is not implemented.

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
