# pi-subagents-workflows research

This directory contains the evidence and synthesis used to understand Claude
Code Dynamic Workflows before building `pi-subagents-workflows`, a planned
add-on for `pi-subagents`.

**Research scope:** Claude Code v2.1.218, the v2.1.217 Workflow tool prompt,
Pi v0.81.1, and `pi-subagents` v0.35.1 at commit
`67ce1939977bdcdb32048fa0e4d387a48b22b729`.

**Project status:** research and the build contract are complete; implementation
has not started. The approved choices are restricted JSON IR, current
`pi-subagents` authority, a phased full foreground build, and the final
repository/package name `pi-subagents-workflows`. See the
[build contract](../PLAN.md).

## Start here

- **[Build contract](../PLAN.md)** — current decisions, repository ownership,
  public TDD seams, phases, branch/commit gates, stop rules, and non-goals.
- **[Claude Dynamic Workflows and `pi-subagents`: exact-checkout comparison](pi-subagents-comparison.md)**
  — implementation-boundary comparison, reuse matrix, contribution map,
  observed test baseline, authority profiles, staged sequence, and release gates.
- **[Claude Code Dynamic Workflows: Reverse-Engineered Architecture and Pi Port Implications](./claude-code-workflows.md)**
  — authoritative Claude synthesis, including runtime semantics, UX,
  persistence, security, Pi feasibility, roadmap, unresolved questions, and the
  pre-implementation decision checklist.
- **[Comprehensive-review workflow example](examples/comprehensive-review.workflow.js)**
  — the original generated workflow analyzed in the synthesis. It is research
  evidence, not the selected executable definition format.

## Primary evidence

- **[Engine internals](_intake/engine-internals.md)** — read-only reverse
  engineering of the shipped v2.1.218 binary.
- **[Prompt corpus](_intake/prompt-corpus.md)** — extracted Workflow and
  workflow-subagent contracts plus version evolution.
- **[Local artifacts](_intake/local-artifacts.md)** — redacted, read-only
  observations of run records, journals, transcripts, jobs, and daemon state.
- **[Public ecosystem](_intake/ecosystem.md)** — official documentation,
  releases, product posts, and qualified secondary reports.

## Evidence policy

The synthesis ranks evidence in this order: shipped binary and observed
artifacts, extracted prompt contracts, official documentation, then secondary
reports. Inference and proposed Pi policy are labeled explicitly. Saved
definitions are kept distinct from session-scoped run records, and unresolved
implementation details remain unresolved rather than being filled in by
analogy.

Source material was treated as untrusted data. No secret values are reproduced.
The local-artifact review found a credential embedded in persistent
configuration; rotate it and remove historical copies before reusing that
environment.

## Implementation boundary

No Pi extension has been implemented. The selected foreground target is a
trusted extension executing strict JSON IR and consuming a public
`pi-subagents` delegation-v2 owned-leaf seam. Workflow parsing, scheduling,
typed outcomes, aggregate limits, and Pi tool/command behavior belong to
`pi-subagents-workflows`; child Pi lifecycle and current configured authority
remain with `pi-subagents`.

Public delegation v1 is insufficient for release because it is single-flight,
text-only, active-context plumbing without detailed usage. The provider v2 seam
must land first. Daemon-safe ownership, durable replay, leases, reconciliation,
and adoption are a later phase blocked on a fully green foreground release.
See the comparison’s
[staged architecture](pi-subagents-comparison.md#staged-architecture) for the
research path and [PLAN.md](../PLAN.md) for the final build contract.
