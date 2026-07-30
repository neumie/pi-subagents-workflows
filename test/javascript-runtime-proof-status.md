# Disposable JavaScript runtime proof status

This branch-only fixture evaluates `quickjs-wasi@3.2.0` as an alternative runtime candidate through functional, packaging, process-lifecycle, and cross-platform tests.

It does **not** amend the Phase 15 contract, satisfy the complete Phase 16 gate, approve a production dependency, or expose a JavaScript execution route through the package or Pi extension. The production package manifest, exports, dependencies, and `src/` tree remain unchanged.

The temporary workflow runs the source and clean-packed fixture under exact Node.js 24.18.0 on Ubuntu 24.04, macOS 14, and Windows Server 2022. Results from this branch are evidence about this disposable candidate only.
