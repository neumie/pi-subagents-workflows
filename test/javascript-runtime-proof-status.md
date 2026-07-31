# Disposable JavaScript runtime proof status

This standalone fixture evaluates `quickjs-wasi@3.2.0` as an alternative runtime candidate through functional, packaging, process-lifecycle, and cross-platform tests.

Phase 16 completed on 2026-07-31 with outcome **rejected — no accepted runtime candidate**. This exact dependency lacks later QuickJS-NG memory-safety fixes, its published package omits standalone license/notice files required by project adoption policy, and this fixture does not exercise the final empty-cwd/Node-permission launch posture. See the [Phase 16 disposition](../research/restricted-javascript-phase16.md).

The fixture does **not** amend the Phase 15 contract, approve a production dependency, or expose a JavaScript execution route through the package or Pi extension. The production package manifest, exports, dependencies, and `src/` tree remain unchanged.

The path-scoped workflow runs the source and clean-packed fixture under exact Node.js 24.18.0 on Ubuntu 24.04, macOS 14, and Windows Server 2022. Keeping it on `main` preserves reviewable functional evidence without granting it production authority.
