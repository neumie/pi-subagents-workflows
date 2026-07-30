const WASM_PAGE_BYTES = 64 * 1024;

function decodeU32(bytes, offset) {
  const start = offset;
  let value = 0;
  let multiplier = 1;
  for (let index = 0; index < 5; index += 1) {
    if (offset >= bytes.length) throw new Error("truncated unsigned LEB128");
    const byte = bytes[offset++];
    value += (byte & 0x7f) * multiplier;
    if (value > 0xffff_ffff) throw new Error("oversized unsigned LEB128");
    if ((byte & 0x80) === 0) {
      if (encodeU32(value).byteLength !== offset - start) {
        throw new Error("non-canonical unsigned LEB128");
      }
      return { value, next: offset };
    }
    multiplier *= 128;
  }
  throw new Error("oversized unsigned LEB128");
}

function encodeU32(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new TypeError("u32 value is out of range");
  }
  const bytes = [];
  do {
    let byte = value % 128;
    value = Math.floor(value / 128);
    if (value !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (value !== 0);
  return Uint8Array.from(bytes);
}

function concat(chunks) {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export function capDefinedWasmMemory(source, maximumBytes) {
  const bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0 || maximumBytes % WASM_PAGE_BYTES !== 0) {
    throw new TypeError("maximumBytes must be a positive whole number of WASM pages");
  }
  if (bytes.byteLength < 8 || bytes[0] !== 0x00 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d || bytes[4] !== 0x01 || bytes[5] !== 0x00 || bytes[6] !== 0x00 || bytes[7] !== 0x00) {
    throw new Error("unsupported WASM header");
  }

  const maximumPages = maximumBytes / WASM_PAGE_BYTES;
  const chunks = [bytes.subarray(0, 8)];
  let offset = 8;
  let memorySections = 0;

  while (offset < bytes.byteLength) {
    const sectionStart = offset;
    const id = bytes[offset++];
    const size = decodeU32(bytes, offset);
    const payloadStart = size.next;
    const payloadEnd = payloadStart + size.value;
    if (payloadEnd > bytes.byteLength) throw new Error("truncated WASM section");

    if (id !== 5) {
      chunks.push(bytes.subarray(sectionStart, payloadEnd));
      offset = payloadEnd;
      continue;
    }

    memorySections += 1;
    let cursor = payloadStart;
    const count = decodeU32(bytes, cursor);
    cursor = count.next;
    if (count.value !== 1) throw new Error("expected exactly one defined WASM memory");
    const flags = decodeU32(bytes, cursor);
    cursor = flags.next;
    if (flags.value !== 0) throw new Error("expected an uncapped, unshared wasm32 memory");
    const minimum = decodeU32(bytes, cursor);
    cursor = minimum.next;
    if (cursor !== payloadEnd) throw new Error("unexpected WASM memory section fields");
    if (minimum.value > maximumPages) throw new Error("WASM minimum exceeds requested maximum");

    const payload = concat([
      encodeU32(1),
      encodeU32(1),
      encodeU32(minimum.value),
      encodeU32(maximumPages),
    ]);
    chunks.push(Uint8Array.of(id), encodeU32(payload.byteLength), payload);
    offset = payloadEnd;
  }

  if (memorySections !== 1) throw new Error("expected exactly one WASM memory section");
  return concat(chunks);
}
