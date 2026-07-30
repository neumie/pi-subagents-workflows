import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Intrinsics, QuickJS } from "quickjs-wasi";
import { capDefinedWasmMemory } from "./cap-wasm-memory.mjs";

const mode = process.argv[2];
assert.ok(["identity", "globals", "concurrency", "bridge", "cpu", "oom", "abort", "stack", "cancel", "cancel-silent", "cancel-flood", "cancel-exit"].includes(mode), "unsupported proof mode");
if (["cancel-silent", "cancel-flood"].includes(mode)) process.on("SIGTERM", () => {});
if (mode === "cancel-exit") process.exit(0);

const identity = JSON.parse(await readFile(new URL("./runtime-identity.json", import.meta.url), "utf8"));
const wasm = await readFile(new URL(import.meta.resolve("quickjs-wasi/quickjs.wasm")));
const sourceWasmSha256 = createHash("sha256").update(wasm).digest("hex");
assert.equal(wasm.byteLength, identity.wasm.sourceBytes, "source WASM byte length mismatch");
assert.equal(sourceWasmSha256, identity.wasm.sourceSha256, "source WASM digest mismatch");
const maximumLinearMemory = mode === "oom" ? 4 * 1024 * 1024 : identity.wasm.maximumLinearMemory;
const cappedWasm = capDefinedWasmMemory(wasm, maximumLinearMemory);
const cappedWasmSha256 = createHash("sha256").update(cappedWasm).digest("hex");
if (maximumLinearMemory === identity.wasm.maximumLinearMemory) {
  assert.equal(cappedWasm.byteLength, identity.wasm.cappedBytes, "capped WASM byte length mismatch");
  assert.equal(cappedWasmSha256, identity.wasm.cappedSha256, "capped WASM digest mismatch");
}
const module = await WebAssembly.compile(cappedWasm);

const forbiddenGlobalNames = [
  "ArrayBuffer",
  "Atomics",
  "BigInt",
  "Buffer",
  "Bun",
  "Date",
  "Deno",
  "FinalizationRegistry",
  "Function",
  "Map",
  "Proxy",
  "Reflect",
  "RegExp",
  "Set",
  "SharedArrayBuffer",
  "WeakMap",
  "WeakRef",
  "WeakSet",
  "WebAssembly",
  "WebSocket",
  "XMLHttpRequest",
  "console",
  "crypto",
  "eval",
  "fetch",
  "module",
  "performance",
  "print",
  "process",
  "require",
];
const restrictedIntrinsics = Intrinsics.EVAL | Intrinsics.JSON | Intrinsics.PROMISE;
const lockdownSource = `(() => {
  const constructors = [
    Function,
    (async function () {}).constructor,
    (function* () {}).constructor,
    (async function* () {}).constructor,
  ];
  for (const constructor of constructors) {
    Object.defineProperty(constructor.prototype, "constructor", {
      value: undefined,
      writable: false,
      enumerable: false,
      configurable: false,
    });
  }
  for (const name of ${JSON.stringify(forbiddenGlobalNames)}) {
    Object.defineProperty(globalThis, name, {
      value: undefined,
      writable: false,
      enumerable: false,
      configurable: false,
    });
  }
  Object.defineProperty(Math, "random", {
    value: undefined,
    writable: false,
    enumerable: false,
    configurable: false,
  });
})()`;

async function createRestrictedVm(options = {}) {
  const vm = await QuickJS.create({
    ...options,
    wasm: module,
    intrinsics: restrictedIntrinsics,
  });
  vm.evalCode(lockdownSource, "runtime-lockdown.js").dispose();
  return vm;
}

async function proveIdentity() {
  const packageJson = JSON.parse(await readFile(new URL(import.meta.resolve("quickjs-wasi/package.json")), "utf8"));
  const lifecycleNames = ["preinstall", "install", "postinstall", "prepare"];
  assert.equal(packageJson.name, identity.package.name);
  assert.equal(packageJson.version, identity.package.version);
  const vm = await createRestrictedVm();
  assert.equal(vm.versions["quickjs-wasi"], identity.package.version);
  assert.equal(vm.versions.quickjs, identity.engine.version);
  const report = {
    package: {
      name: packageJson.name,
      version: packageJson.version,
      license: packageJson.license,
      runtimeDependencies: Object.keys(packageJson.dependencies ?? {}).length,
      lifecycleScripts: lifecycleNames.filter((name) => Object.hasOwn(packageJson.scripts ?? {}, name)),
      lockIntegrity: identity.package.npmIntegrity,
    },
    engine: { name: identity.engine.name, version: vm.versions.quickjs },
    posture: identity.posture,
    hostEnvironmentKeys: Object.keys(process.env).sort(),
    wasm: {
      sourceBytes: wasm.byteLength,
      sourceSha256: sourceWasmSha256,
      cappedBytes: cappedWasm.byteLength,
      cappedSha256: cappedWasmSha256,
      maximumLinearMemory,
    },
    imports: WebAssembly.Module.imports(module)
      .map(({ module: namespace, name, kind }) => ({ module: namespace, name, kind }))
      .sort((left, right) => {
        const leftKey = `${left.module}.${left.name}.${left.kind}`;
        const rightKey = `${right.module}.${right.name}.${right.kind}`;
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      }),
  };
  vm.dispose();
  return report;
}

async function proveGlobals() {
  const vm = await createRestrictedVm({ memoryLimit: 4 * 1024 * 1024 });
  const value = vm.evalCode(`(() => {
    const forbidden = {};
    for (const name of ${JSON.stringify(forbiddenGlobalNames)}) {
      forbidden[name] = typeof globalThis[name];
    }
    forbidden["Math.random"] = typeof Math.random;
    return {
      case: "globals",
      required: {
        JSON: typeof JSON,
        Math: typeof Math,
        Promise: typeof Promise,
      },
      forbidden,
      dynamicConstructors: {
        functionConstructor: typeof (() => {}).constructor,
        asyncFunctionConstructor: typeof (async () => {}).constructor,
        generatorFunctionConstructor: typeof (function* () {}).constructor,
        asyncGeneratorFunctionConstructor: typeof (async function* () {}).constructor,
      },
    };
  })()`, "globals.workflow.js");
  const report = vm.dump(value);
  value.dispose();
  vm.dispose();
  return report;
}

function validateBridgeJson(value, depth = 0, state = { entries: 0 }) {
  if (depth > 16) throw new Error("frame_too_deep");
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return;
  if (Array.isArray(value)) {
    for (const child of value) {
      state.entries += 1;
      if (state.entries > 1_000) throw new Error("frame_has_too_many_entries");
      validateBridgeJson(child, depth + 1, state);
    }
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (["__proto__", "prototype", "constructor"].includes(key)) {
      throw new Error("frame_contains_dangerous_key");
    }
    state.entries += 1;
    if (state.entries > 1_000) throw new Error("frame_has_too_many_entries");
    validateBridgeJson(child, depth + 1, state);
  }
}

async function proveBridgeRejection() {
  const vm = await QuickJS.create({
    wasm: module,
    memoryLimit: 4 * 1024 * 1024,
  });
  const returnHandles = [];
  const bridge = vm.newFunction("bridge", (frameHandle) => {
    if (!frameHandle.isString) throw new Error("frame_must_be_string");
    const text = frameHandle.toString();
    if (Buffer.byteLength(text, "utf8") > 1_024) throw new Error("frame_too_large");
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("frame_is_not_json");
    }
    validateBridgeJson(parsed);
    const result = vm.newString("ok");
    returnHandles.push(result);
    return result;
  });
  vm.setProp(vm.global, "bridge", bridge);
  bridge.dispose();
  const result = vm.evalCode(`
    (() => {
      let proxyTrapCount = 0;
      const proxy = new Proxy({}, {
        get() { proxyTrapCount += 1; throw new Error("proxy get"); },
        ownKeys() { proxyTrapCount += 1; throw new Error("proxy ownKeys"); },
      });
      const cyclic = {};
      cyclic.self = cyclic;
      const capture = (value) => {
        try { return bridge(value); }
        catch (error) { return error.message; }
      };
      const errors = [
        capture(cyclic),
        capture(proxy),
        capture("{"),
        capture("x".repeat(2048)),
        capture('{"__proto__":{}}'),
      ];
      return {
        validResult: bridge('{"value":[1,true,null]}'),
        errors,
        proxyTrapCount,
      };
    })()
  `, "bridge.workflow.js");
  const report = vm.dump(result);
  result.dispose();
  for (const handle of returnHandles) handle.dispose();
  vm.dispose();
  return { case: "bridge", ...report };
}

async function proveConcurrency() {
  const vm = await createRestrictedVm({
    memoryLimit: 32 * 1024 * 1024,
  });
  const settlementOrder = [];
  const promises = [];
  let active = 0;
  let maximumActive = 0;

  const hostAgent = vm.newFunction("agent", (promptHandle) => {
    const prompt = promptHandle.toString();
    const deferred = vm.newPromise();
    promises.push(deferred);
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    const delay = prompt === "slow" ? 60 : 10;
    setTimeout(() => {
      const value = vm.newString(prompt);
      deferred.resolve(value);
      value.dispose();
      active -= 1;
      settlementOrder.push(prompt);
      vm.executePendingJobs();
    }, delay);
    return deferred.handle;
  });
  vm.setProp(vm.global, "agent", hostAgent);
  hostAgent.dispose();

  const pending = vm.evalCode(`
    (async () => {
      const result = await Promise.all([agent("slow"), agent("fast")]);
      return {
        result,
        processVisible: typeof process !== "undefined",
        requireVisible: typeof require !== "undefined",
      };
    })()
  `, "concurrency.workflow.js");
  vm.executePendingJobs();
  const settled = await vm.resolvePromise(pending);
  pending.dispose();
  assert.ok("value" in settled, "guest promise rejected");
  const guest = vm.dump(settled.value);
  settled.value.dispose();
  for (const deferred of promises) deferred.handle.dispose();

  const report = {
    runtime: {
      package: "quickjs-wasi",
      packageVersion: vm.versions["quickjs-wasi"],
      engine: "quickjs-ng",
      engineVersion: vm.versions.quickjs,
    },
    result: guest.result,
    settlementOrder,
    maximumActive,
    processVisible: guest.processVisible,
    requireVisible: guest.requireVisible,
  };
  vm.dispose();
  return report;
}

async function proveCpuInterrupt() {
  let interruptChecks = 0;
  const vm = await createRestrictedVm({
    memoryLimit: 4 * 1024 * 1024,
    interruptHandler: () => ++interruptChecks > 1_000,
  });
  const started = performance.now();
  let outcome = "completed";
  try {
    vm.evalCode("while (true) {}", "infinite.workflow.js").dispose();
  } catch (error) {
    outcome = error?.message === "interrupted" ? "interrupted" : `error:${error?.message}`;
    error?.dispose?.();
  }
  const elapsedMs = performance.now() - started;
  vm.dispose();
  return { case: "cpu", outcome, interruptChecks, elapsedMs };
}

async function proveOom() {
  const vm = await createRestrictedVm({
    memoryLimit: 2 * 1024 * 1024,
  });
  let outcome = "completed";
  try {
    vm.evalCode(`
      globalThis.persistent = [];
      while (true) persistent.push("x".repeat(4096));
    `, "oom.workflow.js").dispose();
  } catch (error) {
    outcome = /out of memory/i.test(error?.message) ? "out_of_memory" : `error:${error?.message}`;
    error?.dispose?.();
  }
  const postOomValue = vm.evalCode("1 + 1", "post-oom.workflow.js").consume((handle) => handle.toNumber());
  const wasmMemoryBytes = vm._getMemory().buffer.byteLength;
  vm.dispose();
  return { case: "oom", outcome, postOomValue, wasmMemoryBytes, maximumLinearMemory };
}

async function forceRuntimeAbort() {
  const vm = await createRestrictedVm({
    memoryLimit: 4 * 1024 * 1024,
  });
  vm._getExports().qjs_eval(0x7fff_ffff, 1, 0x7fff_ffff, 0);
}

async function proveStackTrap() {
  const vm = await createRestrictedVm({
    memoryLimit: 4 * 1024 * 1024,
  });
  const started = performance.now();
  let outcome = "completed";
  try {
    vm.evalCode("function recurse() { return 1 + recurse(); } recurse();", "stack.workflow.js").dispose();
  } catch (error) {
    outcome = /maximum call stack/i.test(error?.message)
      ? "stack_overflow"
      : error instanceof WebAssembly.RuntimeError
        ? "wasm_trap"
        : `error:${error?.message}`;
    error?.dispose?.();
  }
  const elapsedMs = performance.now() - started;
  vm.dispose();
  return { case: "stack", outcome, elapsedMs };
}

async function waitSilentlyForCancellation() {
  setInterval(() => {}, 1_000);
  await new Promise(() => {});
}

async function floodUntilCancellation() {
  process.stdout.write("x".repeat(128 * 1024));
  setInterval(() => {}, 1_000);
  await new Promise(() => {});
}

async function waitForCancellation() {
  const vm = await createRestrictedVm({
    memoryLimit: 4 * 1024 * 1024,
  });
  const pending = [];
  const hostAgent = vm.newFunction("agent", () => {
    const deferred = vm.newPromise();
    pending.push(deferred);
    return deferred.handle;
  });
  vm.setProp(vm.global, "agent", hostAgent);
  hostAgent.dispose();
  const result = vm.evalCode("(async () => agent())()", "cancel.workflow.js");
  vm.executePendingJobs();
  process.on("SIGTERM", () => {});
  process.stdout.write("READY\n");
  setInterval(() => {}, 1_000);
  await new Promise(() => {});
  result.dispose();
  for (const deferred of pending) deferred.handle.dispose();
  vm.dispose();
}

if (mode === "cancel") {
  await waitForCancellation();
} else if (mode === "cancel-silent") {
  await waitSilentlyForCancellation();
} else if (mode === "cancel-flood") {
  await floodUntilCancellation();
} else if (mode === "abort") {
  await forceRuntimeAbort();
} else {
  const proofByMode = {
    identity: proveIdentity,
    globals: proveGlobals,
    concurrency: proveConcurrency,
    bridge: proveBridgeRejection,
    cpu: proveCpuInterrupt,
    oom: proveOom,
    stack: proveStackTrap,
  };
  const report = await proofByMode[mode]();
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
