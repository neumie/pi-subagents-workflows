# pi-workflows

Deterministic multi-agent orchestration for
[Pi](https://github.com/earendil-works/pi-mono) — a port of Claude Code's
`Workflow` tool.

**Status: research complete; implementation not started.** Read the
[exact-checkout `pi-subagents` comparison](research/pi-subagents-comparison.md),
the [authoritative Claude research report](research/claude-code-workflows.md),
and the [evidence index](research/README.md) before making implementation
decisions.

## Idea

In Claude’s reference design, a workflow is a plain JavaScript script whose
control flow is deterministic (loops, conditionals, fan-out) while the work
inside each step is model-driven. The following is a conceptual compatibility
sketch; the Pi port has not yet selected trusted-only JavaScript, restricted IR,
or externally contained JavaScript:

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

- `agent(prompt, opts)` — spawn a subagent; with `schema` it returns a
  validated object instead of text
- `parallel(thunks)` — barrier: run concurrently, await all
- `pipeline(items, ...stages)` — each item flows through all stages
  independently, with no barrier between them
- `phase(title)` / `log(msg)` — progress grouping and narration
- `args` — value passed in at invocation

Why a deterministic control plane rather than a prompt: fan-out, retries, and
verification passes happen the same way every run, and the orchestration itself
costs no tokens.

## Prior art on this machine

`~/.pi/workflows/` already exists from an earlier prototype. Its
`model-tiers.json` maps `small`/`medium`/`big` to Codex models, and
`projects/<name>/runs/*.log` holds run logs. Treat both as migration inputs
only: inspect their schemas after the settings and persistence decisions, and
do not reuse the legacy run logs as the Workflow journal or store without an
explicit migration.

## Before implementation

The long-term target is a Pi extension over a trusted workflow supervisor, a
selected script posture (explicitly trusted-only JavaScript, restricted IR, or
a genuinely isolated runner), a workflow store, and transport-neutral
daemon-safe leaf ownership in `pi-subagents`. Public
delegation v1 supports only an optional **adapter-queued, concurrency-one,
text-only, active-context, non-release spike** under current `pi-subagents`
authority; overlapping foreground dispatch is rejected rather than queued by
`pi-subagents`. It is not the long-term leaf boundary or a concurrency-capable
release substrate. See the
[exact-checkout comparison and staged architecture](research/pi-subagents-comparison.md#staged-architecture).

The user must still decide the script trust boundary, current versus hardened
leaf authority, compatibility versus hardened cache semantics, child capability
policy, budgets, worktree behavior, foreground UX, persistence, and Phase 2
detached lifecycle. See the report’s
[decision and preflight checklist](research/claude-code-workflows.md#decision-and-preflight-checklist).

## License

MIT
