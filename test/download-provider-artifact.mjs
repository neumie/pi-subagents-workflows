import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";

const version = process.env.PI_SUBAGENTS_VERSION;
const expectedSha = process.env.PI_SUBAGENTS_TARBALL_SHA256;
const destination = process.env.PI_SUBAGENTS_TARBALL;
assert.match(version ?? "", /^0\.(?:36|37)\.0$/u, "unsupported provider version");
assert.match(expectedSha ?? "", /^[a-f0-9]{64}$/u, "invalid provider SHA-256");
assert.ok(destination, "PI_SUBAGENTS_TARBALL destination is required");

const maximumBytes = 20 * 1024 * 1024;
const response = await fetch(
	`https://registry.npmjs.org/pi-subagents/-/pi-subagents-${version}.tgz`,
	{ redirect: "error", signal: AbortSignal.timeout(120_000) },
);
assert.equal(response.ok, true, `provider download failed with HTTP ${response.status}`);
const declaredLength = Number(response.headers.get("content-length"));
assert.ok(
	!Number.isFinite(declaredLength) || declaredLength <= maximumBytes,
	"provider artifact declares more than 20 MiB",
);
assert.ok(response.body, "provider download returned no response body");
const reader = response.body.getReader();
const chunks = [];
let byteLength = 0;
try {
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (value.byteLength === 0) continue;
		byteLength += value.byteLength;
		if (byteLength > maximumBytes) {
			await reader.cancel("provider artifact exceeds 20 MiB");
			throw new Error("provider artifact exceeds 20 MiB");
		}
		chunks.push(Buffer.from(value));
	}
} finally {
	reader.releaseLock();
}
const bytes = Buffer.concat(chunks, byteLength);
const actualSha = createHash("sha256").update(bytes).digest("hex");
assert.equal(actualSha, expectedSha, "provider artifact SHA-256 mismatch");
await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
process.stdout.write(
	`verified pi-subagents ${version} (${bytes.byteLength} bytes, ${actualSha})\n`,
);
