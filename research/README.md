# pi-subagents-workflows research

This directory contains the evidence and synthesis used to understand Claude
Code Dynamic Workflows before building `pi-subagents-workflows`, an add-on for
`pi-subagents`.

**Research scope:** Claude Code v2.1.218, the v2.1.217 Workflow tool prompt,
Pi v0.81.1, and `pi-subagents` v0.35.1 at commit
`67ce1939977bdcdb32048fa0e4d387a48b22b729`.

**Project status:** strict JSON IR v1, foreground orchestration, provider
integration, audit, package gates, and the supported Pi/provider matrices are
implemented and green. Restricted JavaScript remains deferred: Phase 16
completed with no runtime candidate accepted. See the
[build contract](../PLAN.md) and
[Phase 16 disposition](restricted-javascript-phase16.md).

## Start here

- **[Build contract](../PLAN.md)** — current decisions, repository ownership,
  public TDD seams, phases, branch/commit gates, stop rules, and non-goals.
- **[Restricted JavaScript Phase 16 runtime disposition](restricted-javascript-phase16.md)**
  — exact dependency, engine, WASM, licensing, advisory, concurrency, and
  containment evidence; current rejection and reopening criteria. Its
  supporting records retain the
  [expanded candidate screen](restricted-javascript-candidate-screen.md) and
  [`quickjs-wasm` reproduction](restricted-javascript-quickjs-wasm-reproduction.md).
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

The implemented Pi extension executes strict JSON IR v1 and consumes the public
`pi-subagents` delegation-v2 owned-leaf seam. Workflow parsing, scheduling,
typed outcomes, aggregate limits, audit, and Pi tool/command behavior belong to
`pi-subagents-workflows`; child Pi lifecycle and current configured authority
remain with `pi-subagents`.

No production restricted-JavaScript runtime dependency, export, or Pi route
exists. The merged disposable proof remains under `test/` and has no production
authority.
Daemon-safe ownership, durable replay, leases, reconciliation, and adoption
remain later phases blocked on the complete foreground gates. See the
comparison’s
[staged architecture](pi-subagents-comparison.md#staged-architecture), the
[Phase 16 disposition](restricted-javascript-phase16.md), and
[PLAN.md](../PLAN.md).
