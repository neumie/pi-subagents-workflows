# Research Brief: Claude Code Dynamic Workflows / Workflow tool / "ultracode" multi-agent orchestration

> Mirror of the authoritative run output at
> `.pi-subagents/artifacts/outputs/b5f4263a/ecosystem`. See that file for the full brief.

Scope: everything public about Claude Code's **Workflow tool** (public product name: **dynamic workflows**) and the **ultracode** opt-in, as of Claude Code v2.1.218 (July 2026). Every claim is sourced inline. Primary sources (Anthropic docs, Anthropic blog, the shipped `@anthropic-ai/claude-code` CHANGELOG, the Agent SDK reference, and the Piebald-extracted system prompt) are preferred; community/secondary sources are marked as such; rumor/speculation is flagged.

Naming (public sources conflate three things):

- **Workflow tool** — internal tool name in Claude Code's system prompt and the Agent SDK (`Workflow`); executes a JS orchestration script.
- **Dynamic workflows** — the public/product name for the same capability (docs, blog).
- **ultracode** — an *opt-in* in two forms: a **prompt keyword** (one task) and an **/effort setting** (`/effort ultracode`, whole session = `xhigh` + auto-orchestration). Not the engine; not a model effort level. (<https://code.claude.com/docs/en/workflows>, <https://www.developersdigest.tech/blog/ultracode-effort-level-explained>)

---

## 1. Timeline / rollout

- **May 28, 2026 — v2.1.154 — shipped with Claude Opus 4.8, as a research preview.** Release tag dated 2026-05-28 (<https://github.com/anthropics/claude-code/releases/tag/v2.1.154>); Opus 4.8 news lists "Dynamic workflows … research preview" (<https://www.anthropic.com/news/claude-opus-4-8>); feature blog dated May 28 (<https://claude.com/blog/introducing-dynamic-workflows-in-claude-code>).
- **June 2, 2026** — deep-dive blog "A harness for every task" (<https://claude.com/blog/a-harness-for-every-task-dynamic-workflows-in-claude-code>).
- **Trigger keyword renamed `workflow` → `ultracode` at v2.1.160 (breaking).** Docs: "Before v2.1.160 the literal trigger keyword was `workflow`" (<https://code.claude.com/docs/en/workflows>). Confirmed: <https://cc.bruniaux.com/guide/workflows/dynamic-workflows/>.
- **"Now generally available"** per the feature blog (exact GA version/date not pinned in primary sources; the "was flag-gated, now default on paid plans" narrative is **secondary**: <https://www.my2cents.ai/deep-dive/claude-code-workflows-research-preview/>). Disable switch: `CLAUDE_CODE_DISABLE_WORKFLOWS=1` / `disableWorkflows: true`.
- Key CHANGELOG milestones (<https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md>): v2.1.178 keyword restyle + monorepo save; v2.1.186 `f` filter + schema-loop fix; v2.1.196 `/deep-research` "unverified"; v2.1.202 "Dynamic workflow size" setting + OTel `workflow.run_id/name`; **v2.1.203 `ultracode` /effort + `--effort ultracode` + Large-workflow warning**; v2.1.208 save-dialog `CLAUDE_CONFIG_DIR`; **v2.1.210 keyword no longer fires on non-human input**; v2.1.216 symlink-save fix; v2.1.217 subagent concurrency caps; **v2.1.218 `/deep-research` manual-only**.

## 2. Official documentation

Canonical: <https://code.claude.com/docs/en/workflows>. Requires **v2.1.154+**; all paid plans + API + Bedrock/Google Agent Platform/Microsoft Foundry; Pro toggles it in `/config`. Bundled `/deep-research`. `/workflows` live UI (phases → agents; `p` pause, `x` stop, `s` save). Subagents run in `acceptEdits`, inherit the tool allowlist. Save to `.claude/workflows/` (shared) or `~/.claude/workflows/` (personal); project wins on clash; `args` global for input. Limits: ≤16 concurrent, 1,000 total per run; resumable **within the same session only**. Size guideline (small<5/medium<15/large<50, advisory) + Large-workflow warning (>25 agents or >1.5M tokens).
**Agent SDK exposes the Workflow tool — yes** (v0.3.149+): inputs `script`/`name`/`scriptPath`/`args`/`resumeFromRunId`; output `status:"async_launched"` + `taskId`/`runId`/`transcriptDir`/`scriptPath`/`error`. `applyFlagSettings({ ultracode: true })` (v2.1.203+). Keyword only opts in on `origin:{kind:"human"}`. (<https://code.claude.com/docs/en/agent-sdk/typescript>)

## 3. How it works (Workflow tool system prompt, Piebald v2.1.217 — <https://github.com/Piebald-AI/claude-code-system-prompts/blob/main/system-prompts/tool-description-workflow.md>)

Background JS orchestration; returns a task ID, `<task-notification>` on completion. Explicit-opt-in gate built into the tool. Script is **JS not TS**; `Date.now()/Math.random()/new Date()` throw (deterministic resume). Hooks: `agent(prompt,opts)` (schema→validated object, `.filter(Boolean)`, `isolation:'worktree'`, `agentType`, `effort`, `model`), `pipeline()` (default, no barrier), `parallel()` (barrier), `log()`, `phase()`, `args`, **`budget` (the "+500k" hard ceiling: `budget.total/spent()/remaining()`, `agent()` throws once spent==total)**, `workflow()` (nested, one level). Caps: `min(16,cpuCores−2)` concurrent, 1,000 total, 4,096 items/call. Resume via `resumeFromRunId` + `journal.jsonl`. Quality patterns: adversarial verify, perspective-diverse verify, judge panel, loop-until-dry, multi-modal sweep, completeness critic.

## 4. UX

Enable: `ultracode` keyword (highlighted, purple shimmer v2.1.178+) / `/effort ultracode` / `claude --effort ultracode`. Dismiss keyword: `Option/Alt+W`. Keyword works only in human-typed input (not `-p`/scheduled/webhook since v2.1.210). "+500k" → `budget.total` (tool prompt only, **not** public docs). Saved workflows become `/<name>` commands; **no registry — sharing = commit `.claude/workflows/`**. Bundled: `/deep-research`. Relates to: subagents (worker primitive), skills/slash-commands (can call Workflow; saved workflows become commands), agent teams (different model), hooks/plugins/MCP (reachable by agents).

## 5. Ecosystem / community

Piebald-AI tracks the prompt (best mechanical source) + ships tweakcc (unlocks unreleased features). Anthropic primary comms = 2 blogs + Opus 4.8 news; **no primary staff X/Twitter threads located**; "multi-agent research system lineage" **unconfirmed**. SDK re-implementation gist: <https://gist.github.com/harsha-gouru/6c854a284f7aecd6134a57d616750c8a>. Deep-dives: alexop.dev, engineered.at, BSWEN, Build This Now, cc.bruniaux.com, dreaming.press, developersdigest, ClaudeWorld, InfoQ.

## 6. Criticisms / limitations

Docs limits: no mid-run input, no fs/shell from script, session-only resume, higher token cost. Bugs: **#64194** — 44 agents / ~2M tokens to read files a `git clone` (~1k tokens) would fetch (<https://github.com/anthropics/claude-code/issues/64194>); **#70498** — not rate-limit-aware, 429s drop agents mid-run (<https://github.com/anthropics/claude-code/issues/70498>). Community: HN "burning tokens without knowing if results are correct" (<https://news.ycombinator.com/item?id=48311705>); Reddit "convoluted default flow" (<https://www.reddit.com/r/ClaudeCode/comments/1rjl2rp/>). Anthropic mitigations: size guideline (v2.1.202), warning (v2.1.203), origin-gating (v2.1.210), concurrency caps + `--max-budget-usd` (v2.1.217), skills opt-in (v2.1.215/2.1.218).

## 7. Conflicts / extensions

"+500k" hard ceiling and `min(16,cpuCores−2)` and 4,096-item cap are in the **tool prompt, not the public docs**. Keyword-rename at v2.1.160 (docs-confirmed). GA-gating history and staff-tweet/research-lineage claims are **unverified/secondary**.

See the authoritative output file for the complete sources list and residual-risks section.
