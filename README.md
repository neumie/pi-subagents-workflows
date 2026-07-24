# pi-subagents-workflows

`pi-subagents-workflows` is a planned add-on for
[`pi-subagents`](https://github.com/nicobailon/pi-subagents). It will provide a
strict JSON workflow definition format, a deterministic foreground scheduler,
and a Pi tool/command adapter while leaving child-agent execution and policy in
`pi-subagents`.

**Status: initial package and Pi extension scaffold.** The package identity,
stable empty barrels, no-op extension entry point, tests, and CI exist. The JSON
IR, workflow engine, provider adapter, Workflow tool/command, and published npm
package do not exist yet. See [PLAN.md](PLAN.md) for the TDD and release
contract.

## Current branches and identity

- `feat/build-workflow-extension` preserves the research and pre-code contract.
- `chore/establish-pi-subagents-workflows` contains the identity scaffold.
- `feat/foreground-workflow-ir-v1` is the next planned consumer branch.
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

## What must land in pi-subagents first

A foreground release depends on a published delegation-v2 seam in
`pi-subagents` that provides:

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

The exact grammar will be frozen by parser tests before implementation. This
illustrative JSON shows the intended restricted shape: explicit references and
templates, ordered steps, bounded output modes, and one final-result reference.
It is not executable today.

```json
{
  "version": 1,
  "id": "review-topic",
  "args": {
    "topic": { "type": "string" }
  },
  "limits": {
    "concurrency": 2,
    "maxTurns": 12
  },
  "steps": [
    {
      "type": "agent",
      "id": "draft",
      "agent": "researcher",
      "phase": "Draft",
      "prompt": {
        "template": "Research {{topic}}",
        "values": {
          "topic": { "ref": "arg", "name": "topic" }
        }
      },
      "output": { "mode": "text" }
    },
    {
      "type": "parallel",
      "id": "checks",
      "phase": "Check",
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
          "output": { "mode": "text" }
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
          "output": { "mode": "text" }
        }
      ]
    }
  ],
  "result": { "ref": "step", "stepId": "checks" }
}
```

IR v1 will support sequential `agent` steps, barriered `parallel` cohorts, and
true item-local `pipeline` stages. Unknown fields, implicit string references,
forward or invalid references, missing template values, unsupported policies,
and malformed schemas or limits will fail parsing.

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
8. Add the public `pi-subagents` `LeafRunner` adapter.
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

`npm test` runs the unit manifest/tarball contract and strict typecheck. There
are no integration or end-to-end suites yet because the IR, engine, provider
adapter, and Workflow tool/command are not implemented.

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
