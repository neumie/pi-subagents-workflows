# Restricted JavaScript Phase 16: Expanded Candidate Screen

**Snapshot:** 2026-07-31

**Scope:** the ten published package stacks named below, complementing the three primary family analyses in the [Phase 16 disposition](restricted-javascript-phase16.md). This is a bounded, dated screen—not a claim about every JavaScript engine package that exists or may later be published.

A candidate is rejected when one evidenced stop rule applies. A wrapper cannot rehabilitate a rejected underlying engine/runtime lineage without replacing and reproving that dependency.

## Exact candidate matrix

| Candidate | Exact npm integrity | Evidenced stop reason |
| --- | --- | --- |
| `@blue-quickjs/quickjs-runtime@0.4.2` + `@blue-quickjs/quickjs-wasm@0.4.2` | runtime: `sha512-ky+H5mQx/nK4K7A9HQu17uDnv5zhqgd07hIKqDJSOJK2GO7sMqVkMFkiqfJ+6pUWoKultgXqRmtpe7t228psgQ==`; WASM: `sha512-miBnG9qWqFyZEP5kOQ9aF6tY5qUZcMMJfuClIQZlF/DDLoGlNgekNIRJM+vdnb7RW562WaIyKgGtNMCN/FxDJw==` | The documented manifest-locked ABI is a `host_call` interface; published evidence does not establish host-created deferred promises, independently overlapping settlement, and explicit pending-job pumping. |
| `@wasmagent/kernel-quickjs@1.2.9` | `sha512-tPR34b0F+UjAvO5uWmb67iNTrN7dk0g6scNDAuNzQviZRX+PQOqRpCBkdujshF+aTM5We1jZg7zN/0iH23uIzA==` | Declares broad peer ranges `quickjs-emscripten >=0.29.0`, `quickjs-emscripten-core >=0.29.0`, and `@jitl/quickjs-wasmfile-release-sync >=0.29.0`; it does not identify one exact engine/WASM selection and therefore fails the exact-artifact gate. |
| `@mikrojs/quickjs@0.17.0` | `sha512-wmCgk7/nbQE8dsa00Jc7F5Iwn0XaZKiWoAlbfjzP/98+ZE4mCX2JgwitA2EO9Kes+K1N/yb0YbPKRE7ZUcTCGw==` | Declares `postinstall: node postinstall.js` and packages QuickJS-NG source/CMake integration; violates the no-install-lifecycle/native-build gate. |
| `@gorules/quickjs-wasm32-wasi@0.6.1` + `@gorules/quickjs@0.6.1` | WASI: `sha512-Nld5UmBfC7g7CDXEssYwkoTGAysLaWL3iXcg6C45wTR48Zo/U9EQJ/IeX94skLzC1aA6ITkk9noWXQcbYquFTg==`; host: `sha512-yuJfDu9a3e63k4Kg+TinoXBq4Z3ExXdECRywRMMVQ2hUEmfetv86PhvvjjLsO0gJ/mIss4NY0fInt4NQKWyVXQ==` | The Node host declares N-API targets and native platform packages. The WASI package alone is not a complete Node host for the planned bridge. |
| `quickjs-wasi-reactor@0.14.0` | `sha512-ZnQPo3iryanl2JgJ+kf/cJ3sBpQTArKZo3Cak0xisaEzQWcOPCLMzat+DUv7vY1JALNmOUBRJKZUzt3U5NaSjQ==` | Published metadata identifies a QuickJS-NG WASI reactor but does not pin the exact engine commit or establish fixed memory, interruption, and independently settling deferred-host-call behavior. |
| `@sebastianwessel/quickjs@3.1.0` | `sha512-ljpJyk02VbctmsRMedczsjMcRfgeZSwvBsAY9G8f5VWWPjpX1kuJ5zqJ0FtYqX0yRCMzYd3ASkLegLgz695Yhw==` | Depends on `quickjs-emscripten-core` and packages QuickJS-NG sync/Asyncify wasmfiles; inherits the rejected lineage. |
| `quickjs-emscripten-sync@1.11.0` | `sha512-6U4tQomzCUEFHU2wN8hN/vxGhmfjQ5UtALx4xmcgMlVunHzHCZZT6OkSTSkGG9TLxXPoATnoFRin7MbpITK6+w==` | Has an explicit `quickjs-emscripten` peer dependency; a synchronous facade does not replace the rejected underlying runtime. |
| `@langchain/quickjs@1.0.0` | `sha512-QdNWVK8Ydi3+knzO6FfX/2WRoPd5ClJIuyGxNwvGiSUmPshQA1XQ9tXvWIQmZ2VLuxpkM2GqEeGWYq/KENJIpA==` | Depends on `quickjs-emscripten@^0.32.0` and `@jitl/quickjs-ng-wasmfile-release-asyncify@^0.32.0`; inherits the rejected engine and uses the forbidden Asyncify path. |
| `quickjs-wasm@0.0.5` | `sha512-EzmFACXcjUmJwf6VAc3CKz1lA5+qoBi+djmdqH/XKB+R7puV+KonmTCtxRIJCqx1giCEElteduoeOiPMPQlFyw==` | Provenance was independently reconstructed, but the exact published bridge failed independent concurrent settlement. See the [retained reproduction](restricted-javascript-quickjs-wasm-reproduction.md). |
| `@openexam/runtime-wasi@0.1.0` | `sha512-VSDpfXI0HTLHHOqJrJpiO1lbfOeaTr2iBz2YTpWDljLg/E8pEMEAWQerwtitEYsAX7UOZaZBHfSr/ATMdjuiMg==` | Directly depends on `quickjs-emscripten@^0.32.0`; inherits the rejected lineage. |

## Source mapping

The exact versioned registry documents below expose each package's integrity, scripts, dependency graph, and published README:

- [`@blue-quickjs/quickjs-runtime@0.4.2`](https://registry.npmjs.org/@blue-quickjs%2fquickjs-runtime/0.4.2) and [`@blue-quickjs/quickjs-wasm@0.4.2`](https://registry.npmjs.org/@blue-quickjs%2fquickjs-wasm/0.4.2)
- [`@wasmagent/kernel-quickjs@1.2.9`](https://registry.npmjs.org/@wasmagent%2fkernel-quickjs/1.2.9)
- [`@mikrojs/quickjs@0.17.0`](https://registry.npmjs.org/@mikrojs%2fquickjs/0.17.0)
- [`@gorules/quickjs-wasm32-wasi@0.6.1`](https://registry.npmjs.org/@gorules%2fquickjs-wasm32-wasi/0.6.1) and [`@gorules/quickjs@0.6.1`](https://registry.npmjs.org/@gorules%2fquickjs/0.6.1)
- [`quickjs-wasi-reactor@0.14.0`](https://registry.npmjs.org/quickjs-wasi-reactor/0.14.0)
- [`@sebastianwessel/quickjs@3.1.0`](https://registry.npmjs.org/@sebastianwessel%2fquickjs/3.1.0)
- [`quickjs-emscripten-sync@1.11.0`](https://registry.npmjs.org/quickjs-emscripten-sync/1.11.0)
- [`@langchain/quickjs@1.0.0`](https://registry.npmjs.org/@langchain%2fquickjs/1.0.0)
- [`quickjs-wasm@0.0.5`](https://registry.npmjs.org/quickjs-wasm/0.0.5)
- [`@openexam/runtime-wasi@0.1.0`](https://registry.npmjs.org/@openexam%2fruntime-wasi/0.1.0)

Additional inspected source:

- **Inspected-source:** immutable Blue parent commit `6235f09a5597e437aa994c5f2bc3bfca2171015e` pins `vendor/quickjs` to `e22bd9620a8600e1fde82adfd2952f81eb8d66d9`: [pinned repository tree](https://github.com/bluecontract/blue-quickjs/tree/6235f09a5597e437aa994c5f2bc3bfca2171015e).
- **Inspected-source:** `quickjs-wasm@0.0.5` source tag `53481b22590098656e283c14ed0cddd6d2ef55d5`: [tagged source](https://github.com/petersalomonsen/quickjs-rust-near/tree/quickjs-wasm-v0.0.5).

## Result

None of these ten dated package stacks clears every mandatory Phase 16 gate. This finding is time-bounded and package-bounded. A changed version, newly published fixed artifact, or newly discovered package is a new candidate and requires a fresh exact screen rather than inheriting this rejection.
