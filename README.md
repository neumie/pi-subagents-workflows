# pi-workflows

Deterministic multi-agent orchestration for [Pi](https://github.com/earendil-works/pi-mono) — a port of Claude Code's `Workflow` tool.

**Status: research complete; implementation not started.** Read the [authoritative research report](research/claude-code-workflows.md) and its [evidence index](research/README.md) before making implementation decisions.

## Idea

A workflow is a plain JavaScript script whose control flow is deterministic (loops, conditionals, fan-out) while the work inside each step is model-driven. The script gets a small set of hooks:

```js
export const meta = {
  name: 'review-changes',
  description: 'Review changed files across dimensions, verify each finding',
  phases: [{ title: 'Review' }, { title: 'Verify' }],
}

phase('Review')
const results = await pipeline(
  DIMENSIONS,
  d => agent(d.prompt, { label: `review:${d.key}`, schema: FINDINGS }),
  review => parallel(review.findings.map(f => () =>
    agent(`Adversarially verify: ${f.title}`, { schema: VERDICT })
      .then(v => ({ ...f, verdict: v })))),
)
return {
  requested: DIMENSIONS.length,
  completed: results.filter(value => value !== null).length,
  results,
}
```

- `agent(prompt, opts)` — spawn a subagent; with `schema` it returns a validated object instead of text
- `parallel(thunks)` — barrier: run concurrently, await all
- `pipeline(items, ...stages)` — each item flows through all stages independently, no barrier between them
- `phase(title)` / `log(msg)` — progress grouping and narration
- `args` — value passed in at invocation

Why a script rather than a prompt: fan-out, retries and verification passes happen the same way every run, and the orchestration itself costs no tokens.

## Prior art on this machine

`~/.pi/workflows/` already exists from an earlier prototype — `model-tiers.json` maps `small`/`medium`/`big` to codex models, and `projects/<name>/runs/*.log` holds run logs. Reuse both if the shape still fits.

## Before implementation

Research narrowed the preferred architecture to a Pi extension over a trusted workflow supervisor, an isolated runner or restricted IR, and a new daemon-safe `pi-subagents` leaf interface. Direct Pi SDK/RPC workers remain a fallback prototype, not the primary design.

The user must still decide the script trust boundary, compatibility versus hardened cache semantics, child capability policy, budgets, worktree behavior, foreground UX, persistence, and Phase 2 detached lifecycle. See the report’s [decision and preflight checklist](research/claude-code-workflows.md#decision-and-preflight-checklist).

## License

MIT
