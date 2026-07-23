# pi-workflows

Deterministic multi-agent orchestration for [Pi](https://github.com/earendil-works/pi-mono) — a port of Claude Code's `Workflow` tool.

**Status: not implemented.** Repo scaffold only.

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
return results.flat().filter(Boolean).filter(f => f.verdict?.isReal)
```

- `agent(prompt, opts)` — spawn a subagent; with `schema` it returns a validated object instead of text
- `parallel(thunks)` — barrier: run concurrently, await all
- `pipeline(items, ...stages)` — each item flows through all stages independently, no barrier between them
- `phase(title)` / `log(msg)` — progress grouping and narration
- `args` — value passed in at invocation

Why a script rather than a prompt: fan-out, retries and verification passes happen the same way every run, and the orchestration itself costs no tokens.

## Prior art on this machine

`~/.pi/workflows/` already exists from an earlier prototype — `model-tiers.json` maps `small`/`medium`/`big` to codex models, and `projects/<name>/runs/*.log` holds run logs. Reuse both if the shape still fits.

## Open decisions

1. **Engine** — how `agent()` spawns work:
   - pi SDK in-process (`createAgentSession()` per call) — per-agent model/thinking, forced structured output, live events for a progress tree
   - `pi -p --mode json` subprocess per call — hard isolation, easy per-agent cwd/worktree, ~1s startup each
   - drive [`pi-subagents`](https://github.com/neumie/pi-subagents) — least new code, but its API is model-facing rather than programmatic
2. **v1 scope** — core (phases, pipeline, schema, journal + resume, progress widget, background run) vs full parity (+ worktree isolation, token budget, nested `workflow()`, custom agent types, saved named workflows)
3. **Packaging** — extension registering a `workflow` tool plus a `/workflows` progress view, per the pi extension API (`pi.registerTool`, `pi.registerCommand`, `ctx.ui.setWidget`)

## License

MIT
