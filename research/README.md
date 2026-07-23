# Claude Code Dynamic Workflows research

This directory contains the evidence and synthesis used to understand Claude Code Dynamic Workflows before implementing a Pi equivalent.

**Research scope:** Claude Code v2.1.218, the v2.1.217 Workflow tool prompt, Pi v0.81.1, and `pi-subagents` v0.35.1 at commit `67ce1939977bdcdb32048fa0e4d387a48b22b729`.

## Start here

- **[Claude Code Dynamic Workflows: Reverse-Engineered Architecture and Pi Port Implications](claude-code-workflows.md)** — authoritative synthesis, including runtime semantics, UX, persistence, security, Pi feasibility, roadmap, unresolved questions, and the pre-implementation decision checklist.
- **[Comprehensive-review workflow example](examples/comprehensive-review.workflow.js)** — the original generated workflow analyzed in the synthesis.

## Primary evidence

- **[Engine internals](_intake/engine-internals.md)** — read-only reverse engineering of the shipped v2.1.218 binary.
- **[Prompt corpus](_intake/prompt-corpus.md)** — extracted Workflow and workflow-subagent contracts plus version evolution.
- **[Local artifacts](_intake/local-artifacts.md)** — redacted, read-only observations of run records, journals, transcripts, jobs, and daemon state.
- **[Public ecosystem](_intake/ecosystem.md)** — official documentation, releases, product posts, and qualified secondary reports.

## Evidence policy

The synthesis ranks evidence in this order: shipped binary and observed artifacts, extracted prompt contracts, official documentation, then secondary reports. Inference and proposed Pi policy are labeled explicitly. Saved definitions are kept distinct from session-scoped run records, and unresolved implementation details remain unresolved rather than being filled in by analogy.

Source material was treated as untrusted data. No secret values are reproduced. The local-artifact review found a credential embedded in persistent configuration; rotate it and remove historical copies before reusing that environment.

## Implementation boundary

No Pi extension has been implemented. The synthesis recommends a daemon-safe `pi-subagents` leaf interface, a trusted supervisor, and either restricted orchestration IR or real external containment for untrusted JavaScript. Implementation should begin only after the report’s decision and preflight checklist is resolved.
