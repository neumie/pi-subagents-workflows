# `quickjs-wasm@0.0.5`: Build and Concurrency Reproduction

**Recorded:** 2026-07-31

**Host:** macOS; exact Node.js `v24.18.0`; Linux/amd64 Emscripten container

**Candidate:** npm `quickjs-wasm@0.0.5`

This appendix retains the exact build identity, commands, probe source, and observed output behind the candidate's Phase 16 rejection. It is evidence, not a project dependency or runnable production fixture.

## Identities

| Item | Exact identity |
| --- | --- |
| npm package | `quickjs-wasm@0.0.5` |
| npm integrity | `sha512-EzmFACXcjUmJwf6VAc3CKz1lA5+qoBi+djmdqH/XKB+R7puV+KonmTCtxRIJCqx1giCEElteduoeOiPMPQlFyw==` |
| wrapper source tag commit | `53481b22590098656e283c14ed0cddd6d2ef55d5` |
| Bellard source archive | `quickjs-2026-06-04.tar.xz`, SHA-256 `b376e839b322978313d929fd20663b11ba58b75df5a46c126dd19ea2fa70ad2a` |
| Bellard source `LICENSE` | SHA-256 `598fd7fc928e4350abce36e337ba5a1346923c5c692f5be92c3d8e29ddd7c18d` |
| Emscripten image | `emscripten/emsdk@sha256:af45409f3199d88db4b1b03af0098532c8fb33a375ac257463eeb0a622870d06` |
| Emscripten version | `3.1.74`, commit `1092ec30a3fb1d46b1782ff1b4db5094d3d06ae5` |
| published `jseval.wasm` | 880,174 bytes, SHA-256 `d3ea9a8860a865268dfff4048adbc91b7938145c5d3df31b0e0c5ae6be1d586f` |
| rebuilt `jseval.wasm` | 880,174 bytes, same SHA-256; `cmp` returned success |

The seven-file npm package has no `LICENSE` or `NOTICE` file. The tagged wrapper repository and Bellard source archive contain MIT license texts; that fact does not change the directly observed npm payload omission.

## Clean reproduction recipe

The successful run used the following equivalent clean recipe. The npm age overrides are process-local and apply only to this disposable evidence directory.

```sh
set -euo pipefail

ROOT=/tmp/quickjs-wasm-phase16-reproduction
SOURCE="$ROOT/source"
CANDIDATE="$ROOT/candidate"
IMAGE='emscripten/emsdk@sha256:af45409f3199d88db4b1b03af0098532c8fb33a375ac257463eeb0a622870d06'
NODE="$HOME/.nvm/versions/node/v24.18.0/bin/node"

rm -rf "$ROOT"
mkdir -p "$CANDIDATE"

git clone https://github.com/petersalomonsen/quickjs-rust-near.git "$SOURCE"
git -C "$SOURCE" checkout --detach 53481b22590098656e283c14ed0cddd6d2ef55d5

curl -fsSLo "$ROOT/quickjs-2026-06-04.tar.xz" \
  https://bellard.org/quickjs/quickjs-2026-06-04.tar.xz
printf '%s  %s\n' \
  b376e839b322978313d929fd20663b11ba58b75df5a46c126dd19ea2fa70ad2a \
  "$ROOT/quickjs-2026-06-04.tar.xz" | shasum -a 256 -c -
tar -xJf "$ROOT/quickjs-2026-06-04.tar.xz" -C "$SOURCE/quickjslib"

(
  cd "$CANDIDATE"
  env npm_config_before= npm_config_min_release_age=0 \
    npm pack quickjs-wasm@0.0.5 --ignore-scripts
  tar -xzf quickjs-wasm-0.0.5.tgz
)

docker pull --platform linux/amd64 "$IMAGE"
docker run --rm --platform linux/amd64 \
  -v "$SOURCE:/src" -w /src/quickjslib \
  "$IMAGE" bash ./build.sh

wc -c \
  "$SOURCE/quickjslib/jseval.wasm" \
  "$CANDIDATE/package/jseval.wasm"
shasum -a 256 \
  "$SOURCE/quickjslib/jseval.wasm" \
  "$CANDIDATE/package/jseval.wasm"
cmp \
  "$SOURCE/quickjslib/jseval.wasm" \
  "$CANDIDATE/package/jseval.wasm"

"$NODE" --version
```

Observed identity output:

```text
Building with emcc (Emscripten gcc/clang-like replacement + linker emulating GNU ld) 3.1.74 (1092ec30a3fb1d46b1782ff1b4db5094d3d06ae5)
880174 source/quickjslib/jseval.wasm
880174 candidate/package/jseval.wasm
d3ea9a8860a865268dfff4048adbc91b7938145c5d3df31b0e0c5ae6be1d586f  source/quickjslib/jseval.wasm
d3ea9a8860a865268dfff4048adbc91b7938145c5d3df31b0e0c5ae6be1d586f  candidate/package/jseval.wasm
v24.18.0
```

## Concurrent-settlement probe

The probe was run from a disposable package with only exact `quickjs-wasm@0.0.5` installed using `--ignore-scripts`:

```sh
mkdir -p /tmp/quickjs-wasm-phase16-reproduction/probe
cd /tmp/quickjs-wasm-phase16-reproduction/probe
printf '%s\n' \
  '{"private":true,"type":"module","dependencies":{"quickjs-wasm":"0.0.5"}}' \
  > package.json
env npm_config_before= npm_config_min_release_age=0 \
  npm install --ignore-scripts --no-audit --no-fund
```

Save the following as `concurrency-probe.mjs` in that directory:

```js
import { createQuickJS } from "quickjs-wasm";

const vm = await createQuickJS();
vm.setMemoryLimit(8 * 1024 * 1024);
let active = 0;
let maximumActive = 0;
const settlement = [];
vm.hostFunctions.delay = async (params) => {
  const id = vm.getObjectPropertyValue(params, "id");
  const ms = vm.getObjectPropertyValue(params, "ms");
  active += 1;
  maximumActive = Math.max(maximumActive, active);
  await new Promise((resolve) => setTimeout(resolve, ms));
  active -= 1;
  settlement.push(id);
  return vm.allocateJSstring(id);
};

const pending = vm.evalSource(`
  (async () => JSON.stringify(await Promise.all([
    env.callHostAsync({ function_name: "delay", id: "slow", ms: 60 }),
    env.callHostAsync({ function_name: "delay", id: "fast", ms: 10 })
  ])))()
`);
await vm.waitForPendingAsyncInvocations();
const result = vm.getPromiseResult(pending);
vm.freeValue(pending);
console.log(JSON.stringify({
  expected: '["slow","fast"]',
  result,
  maximumActive,
  settlement,
}));
```

Run command:

```sh
for n in 1 2 3; do
  printf 'probe-run=%s ' "$n"
  ~/.nvm/versions/node/v24.18.0/bin/node concurrency-probe.mjs
done
```

All three fresh processes produced the same result:

```text
probe-run=1 clock get time 0
{"expected":"[\"slow\",\"fast\"]","result":"\"fast\"","maximumActive":2,"settlement":["fast","slow"]}
probe-run=2 clock get time 0
{"expected":"[\"slow\",\"fast\"]","result":"\"fast\"","maximumActive":2,"settlement":["fast","slow"]}
probe-run=3 clock get time 0
{"expected":"[\"slow\",\"fast\"]","result":"\"fast\"","maximumActive":2,"settlement":["fast","slow"]}
```

`clock get time 0` is unsolicited wrapper stdout and is retained verbatim above. `maximumActive: 2` and settlement order `fast`, `slow` establish that the host calls overlapped. The scalar guest result establishes that their promise resolvers were not independently preserved.

## Source correlation

**Inspected-source:** tagged [`quickjslib/wasmlib.c`](https://github.com/petersalomonsen/quickjs-rust-near/blob/53481b22590098656e283c14ed0cddd6d2ef55d5/quickjslib/wasmlib.c#L190-L205) creates `JSValue resolving_funcs[2]` in `call_host_async()` and passes that array's pointer to the asynchronous host import. Tagged [`quickjslib/js/quickjs.js`](https://github.com/petersalomonsen/quickjs-rust-near/blob/53481b22590098656e283c14ed0cddd6d2ef55d5/quickjslib/js/quickjs.js#L82-L100) retains the pointer across `await`, then invokes the exported promise callback. The wrapper waits for all outstanding host invocations, so serializing the host calls would violate the required concurrent workflow semantics rather than fix resolver ownership.

This source lifetime defect independently supports the runtime observation. Bellard issue #527 is not used as a rejection ground for this exact artifact because Worker reachability was not established and the product would prohibit workers.

## Disposition

The reproducible engine byte identity resolves the initial provenance question. It does not resolve the bridge failure. `quickjs-wasm@0.0.5` therefore fails the mandatory independent concurrent-settlement gate and is rejected. Any patched bridge or repackaged artifact is a new candidate requiring the complete Phase 16 proof.
