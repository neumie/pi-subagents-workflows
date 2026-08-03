# Changelog

All notable changes to `pi-subagents-workflows` are documented here. This
project follows Semantic Versioning while it is pre-1.0; minor releases may
change public contracts with migration notes.

## [0.1.1] - Unreleased

### Added

- A strict, duplicate-key-rejecting JSON workflow IR with bounded arguments,
  limits, templates, references, outputs, and result selection.
- Deterministic sequential, barriered-parallel, and item-local pipeline
  execution with workflow-wide fair concurrency and source-ordered outcomes.
- A public delegation-v2 adapter for `pi-subagents >=0.36.0 <0.39.0`, including
  exact request correlation, cancellation, progress backpressure, structured
  output, typed failures, and fail-closed bus poisoning.
- The foreground `pi_workflow` model tool and `/pi-workflow` user command for
  inline, saved, and capability-gated path definitions.
- Strict definition provenance and bounded, inspection-only foreground audit
  records with immutable publication and incomplete-run reporting.
- Packed-package and real Pi/provider-extension acceptance for
  `pi-subagents` 0.36.0 and 0.37.0 across Pi 0.81.0, 0.82.1, and 0.83.0 on
  Node 24 Ubuntu and Windows.

### Fixed

- Accept the optional lowercase SHA-256 `launchContractDigest` emitted by newer
  delegation-v2 providers while preserving fail-closed rejection of malformed
  metadata and every other unknown terminal field.

### Restricted JavaScript

- Preserve a non-production, three-OS `quickjs-wasi@3.2.0` runtime proof under
  `test/` as functional and lifecycle evidence only.
- Complete Phase 16 with no accepted runtime candidate; production JavaScript
  dependencies, exports, and Pi routes remain deferred until a future exact
  candidate passes the documented reopening gates.
- Record the rejected custom Bellard QuickJS 2026-06-04 reproduction: local
  fixed-memory, byte-reproducible-build, clean non-OOM teardown, and concurrent
  deferred-promise seams passed, but persistent-object OOM aborted checked
  runtime teardown.

### Security

- Treat workflow definitions, prompts, outputs, provider events, filesystem
  state, stored JSON, and rendered text as untrusted at every boundary.
- Reject unsafe links, observable pathname replacement, malformed UTF-8,
  duplicate JSON keys, exotic DTO values, oversized records, and ambiguous
  provider identities.
- Apply and verify protected Windows audit DACLs limited to the current user,
  `SYSTEM`, and local Administrators before writing audit data, with a bounded
  30-second PowerShell budget for slow Windows hosts.
- Pin GitHub Actions and downloaded provider artifacts to reviewed immutable
  digests.

### Compatibility and limits

- Requires Node.js 24 or newer and Pi
  `@earendil-works/pi-coding-agent >=0.81.0 <0.84.0`; packed real-session
  compatibility is verified at 0.81.0, 0.82.1, and 0.83.0.
- Ships raw TypeScript package exports that Pi and consumers load through Jiti.
- Runs only in the foreground. Audit files are inspection records, not replay,
  resume, adoption, daemon, cache, or exactly-once state.
- Child agents retain the authority of the installed `pi-subagents`
  configuration; this package is not a sandbox.
- Windows ACL guarantees require trusted process launch state and a trusted
  `SystemRoot`. Path checks are static/observable and pathname-based, not
  handle-pinned against an active principal mutating ancestors.

[0.1.1]: https://github.com/neumie/pi-subagents-workflows/releases/tag/v0.1.1
