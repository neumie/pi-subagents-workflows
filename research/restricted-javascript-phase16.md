# Restricted JavaScript Phase 16: Runtime Dependency Disposition

**Decision date:** 2026-07-31

**Status:** **COMPLETE — REJECTED (no accepted runtime candidate)**

Phase 16 evaluated the exact QuickJS/WASM families and bounded published-package set enumerated in this record and the dated [expanded candidate screen](restricted-javascript-candidate-screen.md). A later supplemental investigation also rebuilt the synchronous `quickjs-emscripten@0.32.0` wrapper against exact Bellard QuickJS 2026-06-04 with fixed imported memory; that [custom candidate](restricted-javascript-bellard-2026-custom-reproduction.md) passed local builder identity, fixed-memory, clean non-OOM teardown, and concurrent-promise seams but reproduced the persistent-object OOM teardown abort from wrapper issue #257. The gate therefore remains rejected: no reviewed artifact satisfied dependency provenance, licensing policy, memory-safety posture, concurrent deferred-promise behavior, final child launch posture, and clean packed cross-platform acceptance together.

This decision preserves strict JSON IR v1 and the existing foreground product. It adds no production runtime dependency, JavaScript export, Pi route, or provider authority.

## Evidence labels

This record uses the repository's canonical labels:

- **Official-doc** — upstream documentation, package metadata, issue/PR state, or the accepted project contract.
- **Inspected-source** — exact package tarballs, source commits, WASM imports, build scripts, and repository code inspected directly.
- **Disk-observed** — commands and runtime behavior observed locally or in linked hosted runs.
- **Inference** — a bounded conclusion derived from the cited evidence.
- **Proposed Pi policy** — the project decision or reopening requirement based on that evidence.

## Gate result

| Phase 16 requirement | Result | Evidence |
| --- | --- | --- |
| Exact package, engine, WASM, imports, and installed-file identity | Partial | `quickjs-wasi@3.2.0` was fully pinned and whole-package verified. The custom Bellard build pinned source, patches, toolchain, and byte-reproducible outputs, but remained unpublished and did not reach packed whole-package acceptance. |
| No install-time native build or lifecycle authority | Pass for the merged alternative proof | `quickjs-wasi@3.2.0` has no runtime dependencies or install lifecycle hooks. The custom candidate was a local build, not an adoptable published runtime package. |
| Multiple host-created promises settle independently with explicit job pumping | Candidate-specific | `quickjs-wasi@3.2.0` and the custom Bellard build passed. `quickjs-wasm@0.0.5` failed deterministically. |
| Infinite loop, recursion, OOM, abort, cancellation, output, and teardown isolation | Candidate-specific failure | The merged `quickjs-wasi` proof passed its source and clean-packed three-OS suites. The custom Bellard build interrupted CPU and contained recursion but aborted `JS_FreeRuntime` after persistent-object OOM. |
| Exact final child posture: empty cwd and narrow Node read permissions | Fail | The custom candidate passed a local permissioned identity child, but its fail-fast OOM stop occurred before clean-packed three-OS launch acceptance. The merged fixture still launches plain Node from its root. |
| Applicable advisory and memory-safety review | Fail | The custom source review found Worker issue #527 unreachable through the exposed embedding, but its OOM defect and additional unresolved low-memory/Wasm32 reports prevented closure. Other incumbent engines were missing relevant fixes or retained unresolved reports. |
| Complete license and third-party notices | Fail | The custom output required wrapper, Bellard, complete Emscripten, and musl notices; its disposable bundle omitted musl. The two strongest published alternatives also omitted required standalone evidence. |
| One exact candidate passes every gate | **Fail** | No candidate survived all stop rules. |

## Candidate dispositions

### `quickjs-wasi@3.2.0` / QuickJS-NG `v0.15.1`

**Disposition: rejected as a production dependency; retain functional evidence.**

- **Inspected-source:** npm integrity is `sha512-+7ArUWrc1qCtFLjpNVGI47eGih4TKWg3RSB+FfPFtnfZrKlgvCGUUWbClDalFL7lzNAYH82jrPPHsh3LBkuk7g==`. Wrapper tag commit is `eddbe6d0f16a999f973e015d8f497ee4e9fbf5d0`; its QuickJS-NG gitlink is `fd0a0210b7be00957751871e7e01b8291268fc29`, exactly `v0.15.1`.
- **Inspected-source:** source WASM SHA-256 is `078199ef140ec06f18cf7382cca6a39cae638b2d49dca6bdfd139023abb71db4`; the 64 MiB-capped proof WASM is `1716aece9c92901ecc3afd4edf2e21e21c3bc341632e4353ef18c90f180c44f5`.
- **Official-doc:** the exact engine predates multiple merged memory-safety fixes, including Array length/push UAF `d98ff101…`, iterator-find retention/UAF `947e6b05…`, wasm32-relevant integer-overflow fixes `252209d9…` and `e93cca61…`, and promise-resolution OOM UAF fix PR #1613. QuickJS-NG issue [#1570](https://github.com/quickjs-ng/quickjs/issues/1570) remained open with an async cycle-GC UAF report.
- **Inspected-source:** the published 24-file npm payload contains no standalone `LICENSE`, `NOTICE`, or third-party attribution file while shipping QuickJS-NG, Mbed TLS, and ada-url-derived binaries. **Proposed Pi policy:** reject adoption until exact component licenses and redistribution notices are bundled and reviewed; this is a project gate, not a legal conclusion that remediation is impossible.
- **Disk-observed:** the alternative proof nevertheless passed 22 source tests and 21 clean-packed tests on all three required operating systems at [run 30556164748](https://github.com/neumie/pi-subagents-workflows/actions/runs/30556164748).
- **Proposed Pi policy:** preserve these results as functional and lifecycle evidence only. They do not clear dependency adoption.

### `quickjs-emscripten@0.32.0` with the synchronous QuickJS-NG variant

**Disposition: rejected.**

- **Inspected-source:** the selected QuickJS-NG release-sync variant embeds `v0.12.1`, not a current engine.
- **Official-doc:** [CVE-2026-37630 / GHSA-5m3h-w8g2-q63h](https://github.com/advisories/GHSA-5m3h-w8g2-q63h) specifically identifies QuickJS-NG `v0.12.1` and is classified high severity. The engine also predates the later findings above.
- **Proposed Pi policy:** the Phase 15 candidate cannot pass Phase 16 and is no longer an active candidate.

### `quickjs-emscripten@0.32.0` with Bellard release-sync

**Disposition: rejected despite API fit.**

- **Inspected-source:** the exact variant WASM is 503,134 bytes with SHA-256 `105c3bed22d457e43e3d1c3c1c6959fda62a8fe06f0fc8a985303c3a2be72232`. It imports memory, allowing a trusted host-created `WebAssembly.Memory` with a fixed maximum.
- **Inspected-source:** the synchronous wrapper exposes host-created deferred promises plus explicit pending-job pumping. This API fit does not clear the independent engine and OOM/disposal blockers below.
- **Inspected-source:** the embedded Bellard engine pin `f1139494d18a2053630c5ed3384a42bb70db3c53` predates later upstream fixes for uninitialized array traversal, TypedArray buffer overflows, and a FinalizationRegistry re-entrant-GC UAF.
- **Official-doc:** stock wrapper issues [#255](https://github.com/justjake/quickjs-emscripten/issues/255) and [#257](https://github.com/justjake/quickjs-emscripten/issues/257) report unbounded prebuilt WASM growth and abort-on-disposal after persistent-object OOM. A fixed imported memory contains the first issue but does not update the stale engine.
- **Official-doc:** upstream PR [#266](https://github.com/justjake/quickjs-emscripten/pull/266) updates Bellard QuickJS and allocator behavior, but remained unmerged and unpublished.
- **Proposed Pi policy:** an unreleased custom build is a new candidate requiring its own complete provenance and Phase 16 proof; it does not rehabilitate `0.32.0`.

### Custom synchronous wrapper / Bellard QuickJS `2026-06-04`

**Disposition: rejected after fail-fast OOM teardown failure.**

- **Inspected-source:** the [supplemental reproduction](restricted-javascript-bellard-2026-custom-reproduction.md) used wrapper commit `df4efb9ef2cb25c417ecb57986da462d11b244ed`, official engine archive SHA-256 `b376e839b322978313d929fd20663b11ba58b75df5a46c126dd19ea2fa70ad2a`, and Emscripten 5.0.1 image digest `sha256:c89732ef63a56de5a96395c5a8c1c7904f7420131a045406e6fedc4cbe1cc198`.
- **Disk-observed:** a from-clean rebuild reproduced the 510,631-byte WASM (`7d14ac942d7cf027bc71036635e54bea87517dcc0732bd4cab170e8e0e8b886a`) and 9,932-byte MJS (`81aa1c36e7a7431fdd7401f1d5002cd21fb48790221576574b4861ec1e5313cc`) byte-for-byte.
- **Disk-observed:** the WASM required one unshared fixed 64 MiB imported memory, rejected smaller/larger/shared memories, reported release-sync without Asyncify, and could not grow. The focused Node 24 suite passed clean runtime/context teardown and reverse-settled concurrent host promises.
- **Disk-observed:** the minimized OOM matrix isolated the stop condition. Persistent objects without OOM and transient single-allocation OOM both disposed cleanly; persistent-object OOM emitted `Aborted(OOM)` and then `JS_FreeRuntime` asserted that `rt->gc_obj_list` was not empty.
- **Official-doc:** this reproduces open wrapper issue [#257](https://github.com/justjake/quickjs-emscripten/issues/257) even after applying the relevant ownership and allocator changes from PR [#266](https://github.com/justjake/quickjs-emscripten/pull/266).
- **Inspected-source:** the reviewed wrapper did not register native `os`, expose its Worker constructor, or build with pthread/shared memory; binary-level closure and additional low-memory/Wasm32 issue dispositions were not completed after the earlier stop. **Inference:** Worker issue [#527](https://github.com/bellard/quickjs/issues/527) was not reachable through that reviewed embedding, not proven absent from all binary code.
- **Inspected-source:** the generated output incorporated wrapper, Bellard, Emscripten, and musl components, while the disposable bundle omitted musl and never reached packed acceptance. **Proposed Pi policy:** a distributable candidate must preserve the reviewed complete notices for those components.
- **Proposed Pi policy:** reject and retain documentation only. The local unpublished artifact independently fails the release-age/published-package gate and must not enter production manifests or fixtures.

### `quickjs-wasm@0.0.5` / Bellard QuickJS `2026-06-04`

**Disposition: rejected; closest technical near-survivor.**

- **Inspected-source:** npm integrity is `sha512-EzmFACXcjUmJwf6VAc3CKz1lA5+qoBi+djmdqH/XKB+R7puV+KonmTCtxRIJCqx1giCEElteduoeOiPMPQlFyw==`; source tag commit is `53481b22590098656e283c14ed0cddd6d2ef55d5`.
- **Disk-observed:** source tarball `quickjs-2026-06-04.tar.xz` has SHA-256 `b376e839b322978313d929fd20663b11ba58b75df5a46c126dd19ea2fa70ad2a`.
- **Disk-observed:** rebuilding with exact `emscripten/emsdk:3.1.74` image digest `sha256:af45409f3199d88db4b1b03af0098532c8fb33a375ac257463eeb0a622870d06` produced byte-identical `jseval.wasm`, 880,174 bytes, SHA-256 `d3ea9a8860a865268dfff4048adbc91b7938145c5d3df31b0e0c5ae6be1d586f`. The complete command and output record is retained in the [`quickjs-wasm` reproduction](restricted-javascript-quickjs-wasm-reproduction.md).
- **Inspected-source:** the package provides one fresh fixed-memory instance per run, interrupt and memory limits, and an async host bridge without Asyncify. Its npm tarball contains no license file, although the source repository and Bellard release contain MIT texts.
- **Disk-observed:** the [retained Node 24.18.0 probe](restricted-javascript-quickjs-wasm-reproduction.md#concurrent-settlement-probe) issued concurrent `slow` and `fast` host calls inside guest `Promise.all`. Both host calls overlapped (`maximumActive: 2`) and settled `fast` then `slow`, but the guest result was the scalar `"fast"` instead of `["slow","fast"]`. Three fresh runs produced the same result:

  ```json
  {"expected":"[\"slow\",\"fast\"]","result":"\"fast\"","maximumActive":2,"settlement":["fast","slow"]}
  ```

- **Inspected-source:** `call_host_async()` gives the asynchronous host import a pointer to a stack-local resolving-function array. The published bridge therefore does not establish independent resolver lifetime across overlapping calls.
- **Official-doc:** Bellard issue [#527](https://github.com/bellard/quickjs/issues/527) was also an unresolved post-release Worker UAF report. Worker support is not required by this project, but no accepted non-applicability record was needed because concurrent settlement had already failed.
- **Proposed Pi policy:** reject the published artifact. A bridge fix or fork is a new candidate and must rerun the full gate.

### Expanded published-package screen

**Disposition: no survivor.**

The dated [expanded candidate screen](restricted-javascript-candidate-screen.md) records exact versions, npm integrities, primary-source URLs, and one stop reason for each of ten package stacks: `@blue-quickjs`, `@wasmagent/kernel-quickjs`, `@mikrojs/quickjs`, `@gorules/quickjs`, `quickjs-wasi-reactor`, `@sebastianwessel/quickjs`, `quickjs-emscripten-sync`, `@langchain/quickjs`, `quickjs-wasm`, and `@openexam/runtime-wasi`. None cleared every gate at the 2026-07-31 snapshot. This is a bounded screen, not a claim that no other or future package can exist.

## Final decision

1. **Proposed Pi policy:** Phase 16 is complete with outcome **REJECTED — no accepted runtime candidate in the reviewed set**.
2. **Proposed Pi policy:** Phases 17–29 remain blocked; no restricted-JavaScript production implementation begins from this evidence.
3. **Proposed Pi policy:** the merged `quickjs-wasi` fixture stays in `test/` as reproducible functional evidence and must not be imported, exported, or depended upon by production code.
4. **Proposed Pi policy:** the stale `noKnownApplicableHighCritical: true` proof assertion is removed. Historical reviewed CVEs remain recorded, but the candidate's Phase 16 disposition is explicitly rejected.
5. **Proposed Pi policy:** private repository status does not waive dependency, engine, or eventual redistribution gates.
6. **Proposed Pi policy:** the supplemental custom Bellard build is negative evidence only. Its builder and concurrency successes do not override the earlier persistent-object OOM teardown stop.

## Reopening criteria

A future candidate may reopen Phase 16 only when all of the following are available for one exact artifact:

- a release old enough for the configured npm policy;
- exact package, source, engine, toolchain, WASM, import, and whole-file identities;
- complete wrapper, engine, toolchain, and third-party license/notice evidence;
- no applicable unresolved high/critical advisory or credible reachable memory-safety report;
- independently settling concurrent host promises with explicit bounded job pumping and exact lifetime accounting;
- fixed linear memory, interruption, bounded output, cancellation escalation, and checked reap;
- the approved empty-cwd, sanitized-environment, narrow Node-read launch posture;
- clean packed Node 24 runs on Ubuntu, macOS, and Windows without skip or unexplained retry; and
- independent correctness and security acceptance reviews.

Until then, strict JSON IR v1 remains the only executable workflow language.

## Primary sources

- [QuickJS-NG releases](https://github.com/quickjs-ng/quickjs/releases)
- [QuickJS-NG issue #1570](https://github.com/quickjs-ng/quickjs/issues/1570)
- [quickjs-wasi 3.2.0 source tag](https://github.com/vercel-labs/quickjs-wasi/tree/quickjs-wasi%403.2.0)
- [quickjs-emscripten 0.32.0](https://github.com/justjake/quickjs-emscripten/tree/v0.32.0)
- [Bellard QuickJS official releases](https://bellard.org/quickjs/)
- [quickjs-wasm 0.0.5 source tag](https://github.com/petersalomonsen/quickjs-rust-near/tree/quickjs-wasm-v0.0.5)
- [Expanded dated candidate screen](restricted-javascript-candidate-screen.md)
- [`quickjs-wasm@0.0.5` reproduction](restricted-javascript-quickjs-wasm-reproduction.md)
- [Custom Bellard QuickJS 2026-06-04 reproduction](restricted-javascript-bellard-2026-custom-reproduction.md)
- [Post-merge three-OS proof](https://github.com/neumie/pi-subagents-workflows/actions/runs/30556164748)
