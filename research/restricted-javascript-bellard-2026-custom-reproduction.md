# Custom Bellard QuickJS 2026-06-04 runtime reproduction

**Decision date:** 2026-07-31

**Disposition:** **REJECTED — persistent-object OOM teardown failed**

This record covers a new disposable candidate evaluated after the bounded
published-package Phase 16 screen closed. It does not amend that screen, approve
a dependency, or expose a production JavaScript route.

The candidate rebuilt the synchronous `quickjs-emscripten@0.32.0` FFI around the
official Bellard QuickJS 2026-06-04 release with one host-created, fixed 64 MiB
WASM memory. Local builder identity, fixed-memory instantiation, clean non-OOM
runtime/context teardown, and independent concurrent deferred promises passed.
The proof then stopped at the agreed containment gate: after an OOM with a
persistent guest object, `JS_FreeRuntime` aborted because its GC object list was
not empty. This
matches open wrapper issue
[#257](https://github.com/justjake/quickjs-emscripten/issues/257).

No generated artifact, custom wrapper patch, runtime dependency, export, or Pi
route from this investigation was added to the package.

## Evidence labels

- **Official-doc** — upstream release, issue, pull-request, or license material.
- **Inspected-source** — exact source, patch, build command, or binary structure
  inspected directly.
- **Disk-observed** — local command or runtime behavior observed under the exact
  proof configuration.
- **Inference** — bounded conclusion from cited evidence.
- **Proposed Pi policy** — project disposition based on the evidence.

## Exact builder identity

| Input | Exact identity |
| --- | --- |
| Wrapper | `quickjs-emscripten` tag `v0.32.0`, commit `df4efb9ef2cb25c417ecb57986da462d11b244ed` |
| Engine | official `quickjs-2026-06-04.tar.xz` |
| Engine archive SHA-256 | `b376e839b322978313d929fd20663b11ba58b75df5a46c126dd19ea2fa70ad2a` |
| Engine `LICENSE` SHA-256 | `598fd7fc928e4350abce36e337ba5a1346923c5c692f5be92c3d8e29ddd7c18d` |
| Node | `v24.18.0` |
| Yarn | `4.0.2` |
| Emscripten | `5.0.1` |
| Builder image | `emscripten/emsdk@sha256:c89732ef63a56de5a96395c5a8c1c7904f7420131a045406e6fedc4cbe1cc198` |
| Build | release, synchronous, separate-file WASM, `-Oz`, LTO, Closure, no Asyncify |

**Disk-observed:** a from-clean-source second build reapplied every patch and
reproduced both output files byte-for-byte:

| Output | Bytes | SHA-256 |
| --- | ---: | --- |
| `emscripten-module.wasm` | 510,631 | `7d14ac942d7cf027bc71036635e54bea87517dcc0732bd4cab170e8e0e8b886a` |
| `emscripten-module.mjs` | 9,932 | `81aa1c36e7a7431fdd7401f1d5002cd21fb48790221576574b4861ec1e5313cc` |

The disposable build used four recorded patches:

| Patch purpose | SHA-256 |
| --- | --- |
| Node 24 ESM code-generator compatibility (`import.meta.url`, built-in `node:fs`) | `1f397714f9f7badfb7a7afaa04e27bb0ce88a2cfa7c41d35b026a474095808af` |
| Bellard `JS_BOOL` compatibility and PR #266 `js_malloc` ownership fix | `72b2d7f22d7c78bf5b4c6fd196cd778e742d6d29e7d1f9c56522797865668ed4` |
| 64 MiB initial memory, imported memory, and disabled memory growth | `bfade9c965f58126fb94129f45be23679b7c86c9b40c956b166c98b38ed87539` |
| PR #266 Emscripten large-block allocator mode | `fc05e5a2c77fec19ac285d810d099cb99958824449f342d8a803688045108967` |

**Inference:** the minimal Node 24 build-tool edits are part of this candidate's
provenance. They are not upstream `v0.32.0` behavior.

## Gates that passed before the stop

### Fixed memory and synchronous posture

**Disk-observed:** the WASM imports exactly one unshared memory. Its declared
minimum and maximum are both 1,024 WebAssembly pages (64 MiB):

- a 1,023-page memory was rejected as smaller than the declared initial size;
- a 1,024-page memory with a 1,025-page maximum was rejected as exceeding the
  module maximum;
- shared memory was rejected due a shared-state mismatch;
- a caller-owned 1,024/1,024-page memory instantiated successfully; and
- `memory.grow(1)` threw `RangeError`.

`QTS_BuildIsAsyncify()` and `QTS_BuildIsDebug()` both returned zero. The build
had no pthread flags or shared memory. A fresh constructor produced a distinct
WASM module, runtime, context, and memory for each run.

### Concurrent deferred promises

**Disk-observed:** the focused Node 24 suite passed both concurrency cases. Two
host-created deferred promises were simultaneously outstanding
(`maximumActive: 2`), settled in reverse order, and were advanced by explicit,
one-job-at-a-time bounded pending-job pumping. Guest `Promise.all` returned the
source-ordered value:

```json
[
  {"label":"slow","value":"SLOW"},
  {"label":"fast","value":"FAST"}
]
```

A separate `Promise.allSettled` case rejected one capability and resolved the
other without resolver corruption. All deferred handles became terminal and
runtime/context teardown passed.

### Early runtime and permission posture

**Disk-observed:** the pre-OOM containment slice passed these local Node 24
checks:

- a permissioned child launched with `shell: false`, dedicated protocol stdio,
  an empty cwd, a package-root read allowance, and no write, subprocess, or
  worker-thread permission;
- the child environment normalized to only `__CF_USER_TEXT_ENCODING` on macOS;
- the restricted guest exposed none of `process`, `require`, `fetch`,
  `WebAssembly`, `Worker`, or `SharedArrayBuffer`;
- infinite guest CPU interrupted after 1,001 checks, then evaluated `1 + 1`;
- deep recursion produced a bounded stack-overflow error; and
- both paths disposed their context and runtime and exited without an orphan.

These local observations are not clean-packed or three-OS acceptance.

## Stop-gate failure: persistent-object OOM

The candidate included both allocator changes associated with upstream
quickjs-emscripten PR
[#266](https://github.com/justjake/quickjs-emscripten/pull/266): wrapper-owned
property-name storage used `js_malloc`, and Bellard's small-block allocator was
disabled under Emscripten so `JS_SetMemoryLimit` accounting used host
allocations. Those changes did not fix issue #257.

**Disk-observed:** a minimized three-process matrix isolated the failure:

| Case | Evaluation | Context disposal | Runtime disposal |
| --- | --- | --- | --- |
| Persistent array, no OOM | completed | `ok` | `ok` |
| One transient 64 MiB string allocation under a 4 MiB limit | `InternalError: out of memory` | `ok` | `ok` |
| Persistent array grown until OOM under a 4 MiB limit | `Aborted(OOM)` host throw | `ok` | abort |

The final case emitted:

```text
Aborted(OOM)
Aborted(Assertion failed: list_empty(&rt->gc_obj_list),
  at: ../../vendor/quickjs/quickjs.c,2464,JS_FreeRuntime)
```

Removing the runtime memory limit after the host OOM throw succeeded but did
not make teardown safe. The same invariant failed in the permissioned child
containment harness: the host OOM throw entered checked cleanup, context
disposal succeeded, and runtime disposal asserted before a recovery expression
could run.

**Official-doc:** issue #257 reports the same `JS_FreeRuntime` assertion after
OOM when a persistent guest object exists and remains open. Workflows
necessarily retain arrays, objects, functions, and promises across capability
calls, so the persistent-object precondition cannot be excluded by the v1 API.

**Proposed Pi policy:** this is unreliable teardown under the Phase 16 stop
rules. The candidate is rejected. Abort, cancellation escalation, output-limit,
clean-pack, and hosted Ubuntu/macOS/Windows slices were intentionally not used
to override or dilute the earlier failure.

## Advisory disposition

**Inspected-source:** Bellard issue
[#527](https://github.com/bellard/quickjs/issues/527) affects the native
`os.Worker` path in `quickjs-libc.c`. The reviewed wrapper interface does not
register the native `os` module, initialize QuickJS-libc handlers, run its poll
loop, or expose a Worker constructor. The artifact also lacks pthread/shared
memory support.

**Inference:** the issue's runtime prerequisites are not reachable through this
reviewed embedding with high source-level confidence;
`QTS_BuildIsAsyncify()==0` is corroborative, not the security boundary.
Binary-level dead-code/call-graph closure was not completed after the OOM stop.
Open low-memory reports #528–#533 and Wasm32 allocation reports #535/#536 also
remained unresolved investigation items. They are untrusted reports, not
accepted findings, but the candidate cannot claim advisory closure.

## License and notice disposition

**Inspected-source:** wrapper, Bellard QuickJS, and exact published wrapper
runtime packages are MIT licensed. The generated output also contains
Emscripten runtime glue and linked musl components.

**Proposed Pi policy:** an adoptable distributable binary candidate must preserve
at least these complete, verbatim texts:

1. quickjs-emscripten MIT license;
2. Bellard QuickJS MIT license;
3. the complete Emscripten 5.0.1 root `LICENSE`, including its embedded Node
   notice; and
4. Emscripten's exact `system/lib/libc/musl/COPYRIGHT`.

The disposable builder captured only the first three and therefore failed that
project notice gate. It also did not preserve an OCI SBOM mapping the image
digest to public source or a verbose link map identifying final archive members.
No packed artifact was accepted.

## Final disposition

1. **Proposed Pi policy:** reject this custom artifact; it failed the OOM and
   checked-teardown gate even after the relevant PR #266 allocator changes.
2. **Proposed Pi policy:** retain hashes and behavior as negative evidence only;
   do not retain or merge the disposable binary fixture.
3. **Proposed Pi policy:** an unpublished local custom build does not satisfy
   the configured release-age/published-package adoption policy independently
   of its technical failure.
4. **Proposed Pi policy:** Phase 17 and every production restricted-JavaScript
   route remain blocked. Strict JSON IR v1 remains the only executable workflow
   language.

## Primary sources

- [Bellard QuickJS official releases](https://bellard.org/quickjs/)
- [Bellard QuickJS release commit `3d5e064`](https://github.com/bellard/quickjs/commit/3d5e064e9dd67c70f7962836505a7fa067bf0a4e)
- [`quickjs-emscripten` `v0.32.0`](https://github.com/justjake/quickjs-emscripten/tree/v0.32.0)
- [`quickjs-emscripten` issue #257](https://github.com/justjake/quickjs-emscripten/issues/257)
- [`quickjs-emscripten` PR #266](https://github.com/justjake/quickjs-emscripten/pull/266)
- [Bellard QuickJS issue #527](https://github.com/bellard/quickjs/issues/527)
- [Emscripten 5.0.1 license](https://github.com/emscripten-core/emscripten/blob/5.0.1/LICENSE)
- [Emscripten 5.0.1 musl notice](https://github.com/emscripten-core/emscripten/blob/5.0.1/system/lib/libc/musl/COPYRIGHT)
