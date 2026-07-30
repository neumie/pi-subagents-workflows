import assert from "node:assert/strict";
import test from "node:test";

import { capDefinedWasmMemory } from "../cap-wasm-memory.mjs";

const header = Uint8Array.of(0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00);

function concat(...chunks) {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function memoryModule(payload) {
  return concat(header, Uint8Array.of(5, payload.byteLength), payload);
}

const uncappedMemory = Uint8Array.of(1, 0, 1);

test("adds the exact maximum to one uncapped defined wasm32 memory", async () => {
  const source = memoryModule(uncappedMemory);
  const capped = capDefinedWasmMemory(source, 4 * 64 * 1024);
  assert.deepEqual(capped, memoryModule(Uint8Array.of(1, 1, 1, 4)));
  assert.deepEqual(source, memoryModule(uncappedMemory), "source bytes were mutated");
  await WebAssembly.compile(capped);
});

test("rejects non-canonical unsigned LEB128 encodings", () => {
  const wasm = concat(header, Uint8Array.of(5, 0x83, 0x00), uncappedMemory);
  assert.throws(
    () => capDefinedWasmMemory(wasm, 4 * 64 * 1024),
    /non-canonical unsigned LEB128/,
  );
});

test("rejects modules without exactly one defined memory", () => {
  const importedMemoryPayload = Uint8Array.of(
    1,
    1, 0x6d,
    3, 0x6d, 0x65, 0x6d,
    2,
    0, 1,
  );
  const importedOnly = concat(
    header,
    Uint8Array.of(2, importedMemoryPayload.byteLength),
    importedMemoryPayload,
  );
  assert.throws(
    () => capDefinedWasmMemory(importedOnly, 4 * 64 * 1024),
    /expected exactly one WASM memory section/,
  );

  const duplicate = concat(
    memoryModule(uncappedMemory),
    Uint8Array.of(5, uncappedMemory.byteLength),
    uncappedMemory,
  );
  assert.throws(
    () => capDefinedWasmMemory(duplicate, 4 * 64 * 1024),
    /expected exactly one WASM memory section/,
  );
});

test("rejects pre-capped, shared, memory64, and multiple memories", () => {
  const cases = [
    Uint8Array.of(1, 1, 1, 4),
    Uint8Array.of(1, 3, 1, 4),
    Uint8Array.of(1, 4, 1),
  ];
  for (const payload of cases) {
    assert.throws(
      () => capDefinedWasmMemory(memoryModule(payload), 4 * 64 * 1024),
      /expected an uncapped, unshared wasm32 memory/,
    );
  }
  assert.throws(
    () => capDefinedWasmMemory(memoryModule(Uint8Array.of(2, 0, 1, 0, 1)), 4 * 64 * 1024),
    /expected exactly one defined WASM memory/,
  );
});

test("rejects truncation, trailing fields, and a minimum above the cap", () => {
  assert.throws(
    () => capDefinedWasmMemory(concat(header, Uint8Array.of(5, 4, 1, 0, 1)), 4 * 64 * 1024),
    /truncated WASM section/,
  );
  assert.throws(
    () => capDefinedWasmMemory(memoryModule(Uint8Array.of(1, 0, 1, 0)), 4 * 64 * 1024),
    /unexpected WASM memory section fields/,
  );
  assert.throws(
    () => capDefinedWasmMemory(memoryModule(Uint8Array.of(1, 0, 5)), 4 * 64 * 1024),
    /WASM minimum exceeds requested maximum/,
  );
});

test("rejects invalid caps and malformed headers", () => {
  assert.throws(() => capDefinedWasmMemory(header, 1), /whole number of WASM pages/);
  assert.throws(() => capDefinedWasmMemory(new Uint8Array(8), 64 * 1024), /unsupported WASM header/);
  assert.throws(
    () => capDefinedWasmMemory(concat(header, Uint8Array.of(5, 0x80)), 64 * 1024),
    /truncated unsigned LEB128/,
  );
});
