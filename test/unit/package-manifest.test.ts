import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const repositoryUrl = "https://github.com/neumie/pi-subagents-workflows";
const manifestPath = new URL("../../package.json", import.meta.url);

interface PackageManifest {
  name?: string;
  version?: string;
  description?: string;
  license?: string;
  type?: string;
  engines?: Record<string, string>;
  keywords?: string[];
  repository?: { type?: string; url?: string };
  homepage?: string;
  bugs?: { url?: string };
  files?: string[];
  exports?: Record<string, string>;
  scripts?: Record<string, string>;
  pi?: { extensions?: string[] };
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  devDependencies?: Record<string, string>;
  bundledDependencies?: string[];
  bin?: unknown;
}

function loadManifest(): PackageManifest {
  return JSON.parse(readFileSync(manifestPath, "utf8")) as PackageManifest;
}

test("package manifest establishes the pi-subagents-workflows identity", () => {
  const manifest = loadManifest();

  assert.equal(manifest.name, "pi-subagents-workflows");
  assert.equal(manifest.version, "0.1.0");
  assert.equal(
    manifest.description,
    "Strict JSON workflow orchestration for pi-subagents and the Pi coding agent",
  );
  assert.equal(manifest.license, "MIT");
  assert.equal(manifest.type, "module");
  assert.deepEqual(manifest.engines, { node: ">=24" });
  assert.deepEqual(manifest.keywords, [
    "pi-package",
    "pi",
    "pi-coding-agent",
    "pi-subagents",
    "workflows",
    "ai",
    "agents",
  ]);
  assert.deepEqual(manifest.repository, {
    type: "git",
    url: `${repositoryUrl}.git`,
  });
  assert.equal(manifest.homepage, repositoryUrl);
  assert.deepEqual(manifest.bugs, { url: `${repositoryUrl}/issues` });
  assert.doesNotMatch(JSON.stringify(manifest), /(?:^|[^-])pi-workflows(?:[^-]|$)/);
});

test("package exposes only stable barrels and one scaffold Pi extension", () => {
  const manifest = loadManifest();

  assert.deepEqual(manifest.exports, {
    ".": "./src/index.ts",
    "./ir": "./src/ir/index.ts",
    "./engine": "./src/engine/index.ts",
  });
  assert.deepEqual(manifest.pi, {
    extensions: ["./src/extension/index.ts"],
  });
  assert.deepEqual(manifest.files, ["src", "README.md", "PLAN.md", "LICENSE"]);

  for (const path of [
    ...Object.values(manifest.exports ?? {}),
    ...(manifest.pi?.extensions ?? []),
    ...(manifest.files ?? []),
  ]) {
    assert.ok(
      existsSync(new URL(`../../${path.replace(/^\.\//, "")}`, import.meta.url)),
      `declared package path does not exist: ${path}`,
    );
  }
});

test("host imports are optional wildcard peers with exact development pins", () => {
  const manifest = loadManifest();
  const hostPackage = "@earendil-works/pi-coding-agent";

  assert.deepEqual(manifest.dependencies, undefined);
  assert.deepEqual(manifest.optionalDependencies, undefined);
  assert.deepEqual(manifest.peerDependencies, { [hostPackage]: "*" });
  assert.deepEqual(manifest.peerDependenciesMeta, {
    [hostPackage]: { optional: true },
  });
  assert.deepEqual(manifest.devDependencies, {
    [hostPackage]: "0.81.0",
    "@types/node": "24.13.3",
    typescript: "5.9.3",
  });
  assert.equal(manifest.bin, undefined);
  assert.deepEqual(manifest.bundledDependencies, undefined);

  const dependencySections = [
    manifest.dependencies,
    manifest.optionalDependencies,
    manifest.peerDependencies,
    manifest.devDependencies,
  ];
  for (const dependencies of dependencySections) {
    for (const [name, specifier] of Object.entries(dependencies ?? {})) {
      assert.notEqual(name, "pi-subagents");
      assert.doesNotMatch(
        specifier,
        /^(?:file|link|git|git\+|github:)|(?:^|[\\/])\.\.?(?:[\\/]|$)|^[~/]/i,
        `prohibited dependency specifier for ${name}: ${specifier}`,
      );
    }
  }

  assert.deepEqual(manifest.scripts, {
    "test:unit": "node --experimental-strip-types --test test/unit/*.test.ts",
    typecheck: "tsc --noEmit",
    test: "npm run test:unit && npm run typecheck",
    "pack:check": "npm pack --dry-run --ignore-scripts",
  });
  assert.equal("install" in manifest.scripts, false);
  assert.equal("preinstall" in manifest.scripts, false);
  assert.equal("postinstall" in manifest.scripts, false);
});

test("dry-run tarball contains only declared source and documentation", () => {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(
    npm,
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    {
      cwd: new URL("../..", import.meta.url),
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const reports = JSON.parse(result.stdout) as Array<{
    files: Array<{ path: string }>;
  }>;
  assert.equal(reports.length, 1);

  const packedFiles = reports[0]?.files.map(({ path }) => path).sort();
  assert.ok(packedFiles);
  assert.deepEqual(packedFiles, [
    "LICENSE",
    "PLAN.md",
    "README.md",
    "package.json",
    "src/engine/index.ts",
    "src/extension/index.ts",
    "src/index.ts",
    "src/ir/index.ts",
  ]);
  assert.equal(packedFiles.some((path) => /workflow.*\.js$/i.test(path)), false);
});
