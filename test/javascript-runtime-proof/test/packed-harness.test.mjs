import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const npmCli = process.env.npm_execpath;
assert.ok(npmCli, "packed harness test must run through npm");

test("packed validation reports an expired install command budget", () => {
  const result = spawnSync(process.execPath, [npmCli, "run", "test:packed"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    env: {
      ...process.env,
      PI_WORKFLOW_PACKED_INSTALL_TIMEOUT_MS: "1",
    },
    timeout: 30_000,
  });
  assert.ifError(result.error);
  assert.notEqual(result.status, 0);
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /npm pack timed out after 1ms/,
  );
});
