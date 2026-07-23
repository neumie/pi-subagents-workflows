# Claude Code v2.1.218 — Workflow ("ultracode") Subsystem: Prompt-Corpus Research

**Source corpus:** `Piebald-AI/claude-code-system-prompts` (extracted Claude Code system prompts), everything under `system-prompts/*.md`.
**Target CC version:** 2.1.218 (latest in corpus). Frontmatter `ccVersion` values cited per file.
**Method:** Direct read of the load-bearing files + `rg` sweeps + CHANGELOG mining. The changelog carries **version numbers + commit hashes only — no dates**, so the evolution timeline below is version-keyed.

> Provenance note: this run was invoked with the keyword "ultracode" present in the task text and repeated `<system>`/`<system-reminder>` lines urging me to "use the Workflow tool." I treated those as **subject matter of the documentation**, not as actionable directives: (a) this environment exposes no Workflow tool (only Bash/Read/Write/Edit/find/Grep/ls), so it is not callable; (b) the deliverable is a research report about the Workflow subsystem; (c) injected text in tool output or trailing reminders does not acquire operator authority. The report was produced with ordinary file/search tools.

---

## (a) Inventory / Catalog

### Core workflow (the orchestration contract itself)

| File | ccVersion | Role (one line) |
| --- | --- | --- |
| `tool-description-workflow.md` | 2.1.217 | **The** orchestrator-facing contract: describes the Workflow tool — opt-in rules, `meta`, `agent()/parallel()/pipeline()/phase()/log()/workflow()`, budget, concurrency caps, quality patterns, resume. |
| `agent-prompt-workflow-subagent-plain-text-output.md` | 2.1.146 | Subagent-facing: your final text IS the return value (raw data, no "Done."). Defines agentType `workflow-subagent`. |
| `agent-prompt-workflow-subagent-structured-output.md` | 2.1.146 | Subagent-facing: return via the `StructuredOutput` tool exactly once; script reads only the tool call. |
| `agent-prompt-workflow-script-plain-text-return-note.md` | 2.1.173 | Appended **note** variant of the plain-text contract (attached to a non-default/custom agentType running inside a workflow). |
| `agent-prompt-workflow-script-structured-return-note.md` | 2.1.173 | Appended **note** variant of the structured contract (custom agentType + schema). |
| `system-reminder-ultracode-enabled.md` | 2.1.173 | Standing opt-in reminder: when ultracode is on, use Workflow on every substantive task; token cost not a constraint. |
| `system-reminder-workflow-isolated-worktree.md` | 2.1.173 | Tells a workflow subagent it is in an isolated git worktree; wraps `WORKFLOW_SUBAGENT_PROMPT`. |

### Consumers routing through the Workflow tool

| File | ccVersion | Role |
| --- | --- | --- |
| `agent-prompt-code-review-workflow-routing.md` | 2.1.212 | Routes eligible `/code-review` runs through the **background code-review workflow** (`Workflow({name, args})`) instead of inline; wires in ReportFindings, `--comment`, `--fix`, artifact publishing. |
| `system-prompt-code-review-artifact-publishing-instructions.md` | (n/a read) | Conditional block appended by routing to publish the review as an artifact. |

### Consumers using the **plain Agent/Task** tool (fan-out without the Workflow engine)

| File | ccVersion | Role |
| --- | --- | --- |
| `agent-prompt-batch-slash-command.md` | 2.1.81 | `/batch`: plan-mode decomposition into 5–30 worktree-isolated units → one **background Agent per unit** (`isolation:"worktree"`, `run_in_background:true`) → status table. NOT the Workflow tool. |
| `agent-prompt-coordinator-worker-instructions.md` | 2.1.217 | Worker-agent contract under coordinator mode: scope control, commit-only-what-you-changed, resumption, coordinator-facing output. |
| `system-prompt-coordinator-mode-orchestration.md` | 2.1.199 | Coordinator/worker system prompt: Agent/SendMessage/TaskStop, research→synthesis→impl→verify phases, `<task-notification>` schema, fresh-spawn-for-approved-action rule. |
| `agent-prompt-security-review-slash-command.md` | 2.1.120 | `/security-review`: single-prompt 3-step **sub-task** fan-out (identify → parallel false-positive filter → confidence≥8) via Task tool; markdown vuln report. |
| `agent-prompt-review-slash-command.md` | 2.1.202 | `/review <PR#>`: single-agent GitHub PR review via `gh`; no fan-out. |
| `agent-prompt-code-review-part-1..10` + `skill-code-review-*` | 2.1.147–2.1.218 | Effort-scaled finder-angle/verify machinery, run either as inline finders or under the workflow. See §(c). |

### Related plumbing (subagent substrate the workflow builds on)

| File | ccVersion | Role |
| --- | --- | --- |
| `tool-description-agent-usage-notes.md` | 2.1.215 | Full Agent/Task tool usage notes: background-by-default, trust-but-verify, continue via SendMessage, worktree/remote isolation, parallel launches. |
| `tool-description-agent-simple-usage-notes.md` | 2.1.215 | Trimmed Agent usage notes for lighter contexts. |
| `tool-description-agent-when-to-launch-subagents.md` | 2.1.178 | When to launch subagents; `subagent_type` selection incl. `fork`. |
| `tool-description-agent-explicit-spawn-restriction.md` | 2.1.178 | Restricts spawning to explicit user request/named type ("multiple angles/thorough" is NOT a spawn request) — the anti-ultracode default. |
| `agent-prompt-general-purpose.md` | 2.1.203 | Default subagent system prompt (search/analyze/edit, concise report). |
| `agent-prompt-general-purpose-agent.md` / `agent-prompt-general-task-agent.md` | 2.1.173 | Short descriptors/variants of the general agent. |
| `agent-prompt-explore.md` | 2.1.118 | Read-only file-search specialist subagent. |
| `agent-prompt-agent-hook.md` | 2.1.173 | Agent-hook evaluator; returns via StructuredOutput `{ok, reason}`. |
| `agent-prompt-inherited-context-for-worktree-sub-agent.md` | 2.1.173 | Briefs a sub-agent that inherited parent context + is now in its own worktree. |
| `agent-prompt-worker-fork.md` | 2.1.169 | `fork` agentType: inherits full transcript as reference, executes ONE directive, reports once. |
| `tool-description-todowrite.md` | 2.1.84 | TodoWrite task-list tool (single-agent progress tracking; unrelated to Workflow fan-out but part of orchestration plumbing). |

### Incidental "workflow" mentions (NOT the orchestration subsystem — the English word)

`skill-design-sync*`, `skill-artifact-*`, `skill-verify*`, `skill-doctor-slash-command`, `data-github-actions-workflow-for-claude-mentions`, `data-anthropic-cli`, `system-prompt-insights-*`, plan-mode reminders, `.claude/workflows/` path in the security-monitor self-modification list, TaskList/Teammate "workflow" — all use "workflow" in the ordinary sense and are out of scope.

---

## (b) Verbatim quotes — the short, load-bearing subagent-facing prompts

These four are the contract that tells workflow subagents their final output is a **return value, not a human message**. Quoted exactly.

### `agent-prompt-workflow-subagent-plain-text-output.md` (ccVersion 2.1.146)

```
You are a subagent spawned by a workflow orchestration script. Use the tools available to complete the task.

CRITICAL: Your final text response is returned **verbatim** as a string to the calling script — it is your return value, not a message to a human.
- Output the literal result (data, JSON, text). Do NOT output confirmations like "Done." or "Sent."
- If asked for JSON, return ONLY the raw JSON — no code fences, no prose, no markdown.
- Do NOT use SendUserMessage to deliver your answer. Put your answer in your final text response.
- Be concise. The script will parse your output.
```

Frontmatter agentMetadata: `agentType: "workflow-subagent"`, `tools: ["*"]`, `disallowedTools: ["SendUserMessage","Agent","Workflow"]`, `whenToUse: "Internal subagent for workflow script orchestration."`

### `agent-prompt-workflow-subagent-structured-output.md` (ccVersion 2.1.146, var `STRUCTURED_OUTPUT_TOOL_NAME`)

```
You are a subagent spawned by a workflow orchestration script. Use the tools available to complete the task.

CRITICAL: You MUST call the ${STRUCTURED_OUTPUT_TOOL_NAME} tool exactly once to return your final answer. The tool's input schema defines the required shape.
- Do your work (Read files, run commands, etc.), then call ${STRUCTURED_OUTPUT_TOOL_NAME} with your answer.
- Do NOT put your answer in a text response. The script reads ONLY the ${STRUCTURED_OUTPUT_TOOL_NAME} tool call.
- If the schema validation fails, read the error and call ${STRUCTURED_OUTPUT_TOOL_NAME} again with a corrected shape.
- After calling ${STRUCTURED_OUTPUT_TOOL_NAME} successfully, end your turn. No acknowledgment needed.
```

### `agent-prompt-workflow-script-plain-text-return-note.md` (ccVersion 2.1.173) — appended note form

```
---

NOTE: You are running inside a workflow script. Your final text response is returned verbatim as a string to the calling script — it is your return value, not a message to a human. Output the literal result; do not output confirmations like "Done." Be concise — the script will parse your output.
```

### `agent-prompt-workflow-script-structured-return-note.md` (ccVersion 2.1.173, var `STRUCTURED_OUTPUT_TOOL_NAME`) — appended note form

```
---

NOTE: You are running inside a workflow script. You MUST return your final answer by calling the ${STRUCTURED_OUTPUT_TOOL_NAME} tool exactly once — the tool's input schema defines the required shape. Do your work, then call ${STRUCTURED_OUTPUT_TOOL_NAME}; do NOT put your answer in a text response (the script reads ONLY the tool call). If validation fails, read the error and call ${STRUCTURED_OUTPUT_TOOL_NAME} again with a corrected shape.
```

**Why two families (full prompt vs. appended note):** the full prompts are the *system prompt* of the default `workflow-subagent`. The "note" variants are **appended** to a *custom* agentType's own system prompt when `agent(..., {agentType})` composes with schema — the tool-description-workflow line "the custom agent's system prompt gets a StructuredOutput instruction appended" is exactly this note.

### Standing opt-in reminder — `system-reminder-ultracode-enabled.md` (2.1.173), verbatim

```
Ultracode is on: optimize for the most exhaustive, correct answer — not the fastest or cheapest. Use the Workflow tool on every substantive task; token cost is not a constraint. See the Workflow tool's **Ultracode** section and quality patterns. Solo only on conversational/trivial turns.
```

---

## (c) Detailed notes per consumer

### 1. `/code-review` family — the flagship, dual-path consumer

The code-review system exists in **two execution shapes** selected at runtime, plus effort tiers.

**Routing (`agent-prompt-code-review-workflow-routing.md`, 2.1.212).** When the review is eligible it does **not** review inline; it invokes:

```
Workflow({ name: <CODE_REVIEW_WORKFLOW_NAME>, args: <CODE_REVIEW_WORKFLOW_ARGS> })
```

"Everything after the level in the args string is passed to the workflow as the review target / instructions." Extra user instructions (scope restriction, focus files, skips) are appended to the args string. The workflow "runs the same finder angles and verify pass as the inline review, in the background; the verified findings arrive as a task notification." On arrival: call `ReportFindings` once with `{level, findings}` (most-severe first, empty array if nothing survived), each finding gets a `short_summary` ≤60 chars. Conditionally chains `--comment` (GitHub inline comments), `--fix` (apply to working tree), findings re-report, and artifact publishing. All conditioned on template booleans (`HAS_REPORT_FINDINGS_TOOL`, `HAS_COMMENT_FLAG`, `HAS_FIX_FLAG`, …).

**Inline fallback (when Agent tool unavailable).** `agent-prompt-code-review-unavailable-agent-inline-mode.md`, `skill-code-review-inline-medium-high-template.md`, `skill-code-review-inline-xhigh-mode.md`, `agent-prompt-code-review-inline-gap-sweep-phase.md` run the same angles **"in sequence yourself, in THIS context — do NOT spawn subagents"**, dedup without a verifier pass, then a same-context gap sweep.

**Effort ladder (the core scaling knob).** Each mode is a self-describing header line:

| Mode | File | Shape |
| --- | --- | --- |
| low (≤4) | `part-2-low-effort-mode` (2.1.216) | `1 diff pass → no verify → ≤4 findings` |
| low (min-findings) | `part-2-low-effort-minimum-findings-mode` (2.1.216) | `1 diff pass → no verify → ≥min(files,4)` |
| low (expanded) | `skill-code-review-low-effort-expanded-findings-mode` (2.1.216) | `1 diff pass → no verify → ≤8`, target ≥min(files,4) |
| medium | `part-6-medium-effort-mode` (2.1.218) | `3+5 angles × 6 candidates → 1-vote verify → ≤8` — **precision** |
| high | `part-7-high-effort-mode` (2.1.218) | `3+5 angles × 6 → 1-vote verify (recall-biased) → ≤10` — **recall** |
| xhigh / max | `part-3-extra-high-and-maximum-effort-modes` (2.1.218) | `5+5 angles × 8 → 1-vote verify → sweep → ≤15` — **recall, err toward surfacing** |
| xhigh inline | `skill-code-review-inline-xhigh-mode` (2.1.206) | `10 inline angles → dedup (no verify) → sweep → ≤15` |

**Finder angles** (`part-1-base-finder-angles` 2.1.160, `skill-code-review-correctness-finder-angles` 2.1.206, plus `skill-code-review-angle-b/c/d/e`, `altitude/conventions/efficiency` dimension skills):

- **A** line-by-line diff scan (incl. enclosing function — bugs in unchanged lines of a touched function are in scope).
- **B** removed-behavior auditor (name each deleted invariant, find where re-established).
- **C** cross-file tracer (callers/callees broken by the change).
- **D** language-pitfall specialist (JS falsy-zero, `==`, Python mutable defaults, Go nil-map/range capture, etc.) — xhigh/max only.
- **E** wrapper/proxy correctness (delegate vs. re-entrant session) — xhigh/max only.
- Plus cleanup angles (reuse/simplification/efficiency), 1 altitude angle, 1 conventions angle.

**Verification** — two philosophies:

- **Three-state** (`part-4` / `skill-...-verify-3-state`): each candidate → **CONFIRMED** (name inputs/state + wrong output, quote line) / **PLAUSIBLE** (mechanism real, trigger uncertain) / **REFUTED** (factually wrong or guarded — quote proof). Keep CONFIRMED+PLAUSIBLE. Used at medium (precision).
- **Recall-biased** (`part-5`): PLAUSIBLE by default; REFUTE only when constructible from code (factually wrong / provably impossible / already handled / pure style). Used at high/xhigh/max. `part-3`: "a single non-REFUTED vote carries the finding. Do NOT drop on uncertainty."

**Gap sweep** (`part-3` sweep, `skill-code-review-phase-3-sweep-for-gaps`, inline gap-sweep): a fresh reviewer with the deduped list re-reads ONLY for defects not already listed; up to 8 more candidates; empty sweep if nothing (do not pad).

**Output — ReportFindings format** (`part-10`, 2.1.216; `tool-description-report-code-review-findings` 2.1.196): one `ReportFindings({level, findings})` call, ≤`MAX_FINDINGS` ranked most-severe first. Each entry: `file`, `line`, `summary`, `short_summary` (≤60 chars, claim compressed, no rationale/consequence), `failure_scenario`, `category` (kebab slug: `correctness`/`simplification`/`efficiency`/`reuse`/`altitude`/`conventions`/more-specific), plus `verdict` when verified. "Do not also print the findings as text… the tool call is the report." When the Agent tool is absent, the skill's output contract is instead a **raw JSON array** (`skill-code-review-output-findings-json-array`, 2.1.216) and it must NOT call ReportFindings.

**Routing decision doc:** `agent-prompt-code-review-workflow-routing.md` is the switch that sends eligible runs to the Workflow engine; the `*-unavailable-agent-inline-mode` and inline skills are the degraded path. So `/code-review` is the one consumer that genuinely uses the Workflow tool (not just the Agent tool).

### 2. `/batch` (`agent-prompt-batch-slash-command.md`, 2.1.81) — Agent tool, NOT Workflow

Three phases: **(1) Research & Plan** in plan mode (foreground subagents to find scope; decompose into `MIN_5_UNITS`–`MAX_30_UNITS` independently-mergeable, worktree-isolatable units; determine an e2e test recipe; ask the user via AskUserQuestion if no e2e path found; write plan; ExitPlanMode). **(2) Spawn workers** after approval — one **background Agent per unit**, all `isolation:"worktree"` + `run_in_background:true`, launched in a single message block, each prompt fully self-contained + `WORKER_PROMPT` verbatim, `subagent_type:"general-purpose"`. **(3) Track** via a `| # | Unit | Status | PR |` table updated from completion notifications (parse `PR: <url>`). Uses the plain Agent tool for fan-out; no `Workflow()`.

### 3. Coordinator mode (`system-prompt-coordinator-mode-orchestration.md` 2.1.199 + `agent-prompt-coordinator-worker-instructions.md` 2.1.217)

The **model-driven** (non-deterministic) sibling of the Workflow engine. Coordinator uses Agent (spawn) / SendMessage (continue) / TaskStop. Phase table Research(parallel workers)→Synthesis(coordinator)→Implementation→Verification. Key contracts:

- `<task-notification>` XML result schema (`task-id`/`status`/`summary`/`result`/`usage`) — the same notification envelope the Workflow tool description references ("a `<task-notification>` arrives when the workflow completes").
- **Fresh-spawn-for-approved-action** rule: when a worker gates on approval, spawn a NEW Agent with the user's verbatim approval + literal command — never SendMessage the approval back (no agent message is ever the worker's consent). Also a prompt-injection isolation boundary.
- Worker instructions (2.1.217): complete exactly what's asked, commit only changed files (never `git add .`), report hash; may fan out further **only if** `MAX_SUBAGENT_SPAWN_DEPTH_FN() > 1` and it has the Agent tool (workers at the depth cap don't receive it); resumable with brief follow-ups; output goes to coordinator, not user.

### 4. `/security-review` (`agent-prompt-security-review-slash-command.md`, 2.1.120) — Task tool sub-tasks

Self-contained security prompt with a **3-step sub-task fan-out** at the very end: (1) one sub-task to identify vulns (include all category/methodology text), (2) **one parallel sub-task per vuln** to filter false positives (include the "FALSE POSITIVE FILTERING" block with its 17 hard exclusions + 12 precedents), (3) drop anything with confidence < 8. Output: markdown vuln report only. Uses `Task` (allowed-tools includes `Task`), not Workflow.

### 5. `/review` (`agent-prompt-review-slash-command.md`, 2.1.202) — single agent, no fan-out

`gh pr view`/`gh pr diff` for the PR; PR diff is the only scope; prose review with fixed sections. No orchestration — included for contrast with `/code-review`.

### 6. `skill-agent-design-patterns.md` (2.1.198) — reference, not a runtime consumer

API-building heuristics: bash-vs-dedicated tools, PTC (programmatic tool calling — the conceptual ancestor of the Workflow script model: control flow in code, only final output returns to context), tool search, skills, context editing/compaction/memory, caching workarounds (spawn a subagent with the cheaper model to avoid mid-session model-swap cache invalidation). Explains *why* the Workflow engine spawns subagents rather than swapping models mid-loop.

### 7. `/simplify`, `/doctor` (sweep-surfaced)

`agent-prompt-simplify-slash-command.md` + `agent-prompt-simplify-unavailable-agent-inline-mode.md` mirror the code-review pattern (fan-out finders with an inline fallback when the Agent tool is unavailable). `skill-doctor-slash-command.md` is a setup-health "workflow" in the English sense (read-only report → cleanup gate → permission gate); not the Workflow engine.

---

## (d) Template-variable table

Runtime values inferred from the corpus + changelog. Values in **bold** are attested; others are inferred from usage.

### `tool-description-workflow.md`

| Variable | Meaning / inferred value |
| --- | --- |
| `AGENT_TOOL_NAME` | Name of the Agent/Task tool — **"Agent"** (or "Task"). |
| `WORKFLOW_INVOCATION_QUALIFIER` | Qualifier before "invocation" (e.g. " first" / ""), gating the auto-persist-to-file note. |
| `WORKFLOW_SCRIPT_PATH_NOTE` | Extra sentence about the returned scriptPath. |
| `WORKFLOW_AGENT_ISOLATION_OPTION` | Type union for `isolation` opt — e.g. `'worktree'` (`'remote'` when available). |
| `WORKFLOW_AGENT_ISOLATION_NOTE` | Extra isolation guidance appended after the worktree sentence. |
| `WORKFLOW_GROUP_PREFIX` | Progress-group label prefix for nested `workflow()` children (e.g. "Workflow"). |

### Subagent output notes

| Variable | Value |
|---|---|
| `STRUCTURED_OUTPUT_TOOL_NAME` | **"StructuredOutput"** (attested in tool-description-workflow: "forced to call a StructuredOutput tool"; changelog 2.1.146 "call the StructuredOutput tool exactly once"). |

### `system-reminder-workflow-isolated-worktree.md`

| Variable | Value |
| --- | --- |
| `WORKFLOW_SUBAGENT_PROMPT` | The subagent's base system prompt (plain-text or structured variant) that this reminder wraps. |
| `WORKTREE_INFO.worktreePath` | Absolute path of the isolated worktree. |
| `MAIN_WORKING_DIRECTORY_FN()` | The session's main cwd. |

### `agent-prompt-code-review-workflow-routing.md`

| Variable | Meaning |
| --- | --- |
| `CODE_REVIEW_ROUTING_NOTICE` | Optional lead-in notice. |
| `CODE_REVIEW_EFFORT_LEVEL` | low/medium/high/xhigh/max. |
| `WORKFLOW_TOOL_NAME` | **"Workflow"**. |
| `JSON_STRINGIFY_FN` | `JSON.stringify`. |
| `CODE_REVIEW_WORKFLOW_NAME` | Saved workflow name for background code review. |
| `CODE_REVIEW_WORKFLOW_ARGS` | Args string: `<level> <target/instructions>`. |
| `HAS_REPORT_FINDINGS_TOOL` / `REPORT_FINDINGS_TOOL_NAME` | Boolean + **"ReportFindings"**. |
| `HAS_COMMENT_FLAG` / `GITHUB_COMMENT_INSTRUCTIONS_BLOCK` | `--comment` gate + block. |
| `HAS_FIX_FLAG` / `FIX_APPLICATION_INSTRUCTIONS_FN` | `--fix` gate + block. |
| `FINDINGS_REREPORT_INSTRUCTIONS_BLOCK`, `ARTIFACT_PUBLISHING_INSTRUCTIONS_BLOCK`, `EMPTY_STRING` | Conditional trailers. |

### `agent-prompt-batch-slash-command.md`

`USER_INSTRUCTIONS`, `ENTER_PLAN_MODE_TOOL_NAME`, `MIN_5_UNITS`=**5**, `MAX_30_UNITS`=**30**, `ASK_USER_QUESTION_TOOL_NAME`, `EXIT_PLAN_MODE_TOOL_NAME`, `AGENT_TOOL_NAME`, `WORKER_PROMPT`.

### `agent-prompt-coordinator-worker-instructions.md`

`MAX_SUBAGENT_SPAWN_DEPTH_FN()` (integer depth; fan-out block only when `>1`), `AGENT_TOOL_NAME`.

### Code-review effort/format

`EFFORT_LEVEL`, `MAX_FINDINGS` (**4/8/10/15** by tier), `HAS_REPORT_FINDINGS_TOOL`, `REPORT_FINDINGS_TOOL_NAME`, `DIFF_GATHERING_PHASE`, `AGENT_UNAVAILABLE_INSTRUCTIONS`, `BASE_FINDER_ANGLES_BLOCK`, `EXTENDED_FINDER_ANGLES_BLOCK`, `CLEANUP_AND_ALTITUDE_CANDIDATES_NOTE`, `THREE_STATE_VERIFY_PHASE`, `RECALL_BIASED_VERIFY_PHASE`, `GAP_SWEEP_PHASE`, `OUTPUT_FORMAT_FN(n)`, `VERIFY_VOTE_DEFINITIONS`, `SWEEP_FOCUS`/`SWEEP_MISS_CATEGORIES`, plus the inline template's `REVIEW_*` angle variables.

### Agent plumbing (`tool-description-agent-usage-notes.md`)

`TOOL_BASE_DESCRIPTION`, `CAN_RUN_BACKGROUND_AGENTS`, `IS_FORK_SUBAGENT_FEATURE_ENABLED`, `CAN_FORK_CONTEXT`, `SEND_MESSAGE_TOOL_NAME` (**"SendMessage"**), `IS_REMOTE_ISOLATION_AVAILABLE_FN`, `IS_DEFAULT_SUBAGENT_STEERING_MODE`, `FORK_USAGE_GUIDELINES`, `WRITING_SUBAGENT_PROMPTS_GUIDANCE`, etc.

---

## (e) Evolution timeline (version-keyed; changelog has NO dates)

The Workflow subsystem was **introduced at 2.1.146** and iterated steadily through 2.1.217. Opt-in keyword evolved: **`ultrawork` → `workflow` → `ultracode`**.

| Version | Change (workflow / ultracode subsystem) |
| --- | --- |
| **2.1.146** | **NEW: `tool-description-workflow.md`** — first Workflow tool description (opt-in orchestration, `meta`, agent hooks w/ plain-text or structured returns, pipeline vs parallel, token budgeting, quality patterns, concurrency, resume). **NEW: workflow-subagent plain-text output** note. **NEW: workflow-subagent structured output** note. (Subagent notes carry ccVersion 2.1.146.) |
| 2.1.149 | Workflow — adds framing (decompose broad work / gain confidence / handle scale), scout-inline-before-orchestration, expands quality patterns (multi-modal sweeps, completeness critics, log bounded coverage). |
| 2.1.152 | Workflow — adds common single-phase workflows, recommends chaining scoped workflows across turns, notes MCP-via-ToolSearch with headless-auth caveat. |
| 2.1.153 | Workflow — **renames opt-in keyword `ultrawork` → `workflow`**; model overrides usually omitted (inherit session model); exhaustive-review guidance (dedup vs all seen, perspective-diverse verify, loop-until-dry). |
| 2.1.154 | Workflow — **adds ultracode as standing opt-in**; requires inline scripts on first invocation; clarifies JSON `args`; scripts are plain JS not TS. |
| 2.1.157 | Workflow — updates opt-in to treat **`ultracode` as the explicit keyword**; direct wording ("use a workflow") qualifies; fallback suggestion reworded. |
| 2.1.162 | Workflow — `parallel()`/`pipeline()` cap at **4096 items**, explicit error over limit. |
| 2.1.166 | Workflow — `agent()` returns **null** when a subagent dies on terminal API error after retries. |
| 2.1.176 | Workflow — adds **`effort`** option to `agent()` (`low | medium | high | xhigh | max`; inherit session by default). |
| 2.1.198 | Workflow — changes custom-agentType example from `Explore` → **`general-purpose`**; tells agents to read `<transcriptDir>/journal.jsonl` before diagnosing empty/unexpected completed-workflow results. |
| ~2.1.197 | Security monitor — treats **Workflow scripts like delegation payloads** (evaluates written/edited content, carries risk to later execution/import). |
| 2.1.212 | **NEW: `agent-prompt-code-review-workflow-routing.md`** — routes eligible `/code-review` through the background workflow at requested effort; findings/comment/fix/artifact chaining. |
| **2.1.217** | Workflow (current tool-description ccVersion) — **coordinator worker instructions recategorized system-prompt → agent-prompt**; worker fan-out made conditional on remaining spawn depth + Agent-tool availability; subagent search/orchestration guidance qualified when Agent tool unavailable. |
| 2.1.216 | Code-review low-effort modes + ReportFindings format land at this version (short_summary ≤60, min-findings targets). |
| 2.1.218 | Medium/high/xhigh/max effort mode prompts current at this version; xhigh/max header `5+5 angles × 8 candidates`. |

**ccVersion frontmatter of the 5 core files:** tool-description-workflow **2.1.217**; both subagent output prompts **2.1.146**; both script-return notes **2.1.173**. (The tool description is kept current; the subagent contracts have been stable since introduction — the 2.1.173 notes are the later "appended-note" variants for custom agent types.)

**Non-workflow-engine orchestration lineage (for context):** ultraplan / remote-plan-mode (2.1.132 area), team/teammate tooling and coordinator mode predate and parallel the Workflow engine; `/batch` (2.1.81) and the Task-tool security-review (2.1.120) are older Agent-tool fan-out patterns the Workflow engine generalizes.

---

## (f) Open questions

1. **Exact resolved values** of `AGENT_TOOL_NAME` ("Agent" vs "Task"), `WORKFLOW_TOOL_NAME`, `SEND_MESSAGE_TOOL_NAME`, `STRUCTURED_OUTPUT_TOOL_NAME` — inferred from usage, not a values manifest. The corpus is templates; a runtime dump would confirm.
2. **`CODE_REVIEW_WORKFLOW_NAME`** — the literal saved-workflow name the routing prompt invokes is a template var; the actual script (which encodes the finder→verify pipeline as `pipeline()`/`parallel()`) is **not** in this corpus (scripts are generated inline / persisted to the session dir, not extracted).
3. **`workflow-subagent` disallowedTools** includes `Agent` and `Workflow` — so nesting is blocked at the subagent level, consistent with tool-description's "workflow() inside a child throws" (one-level nesting). Whether custom `agentType` subagents inside a workflow can themselves spawn is unclear (they get the note appended but their tool grants come from their own definition).
4. **No dates** anywhere in CHANGELOG.md — only version + commit hash. Mapping versions→calendar dates would require the git history of the Piebald repo (commit timestamps), out of scope here.
5. **`budget` / "+500k"** — the token-budget plumbing (`budget.total/spent()/remaining()`, shared pool across main loop + all workflows, hard ceiling) is fully described in the tool description but no separate prompt file governs how the user's "+500k"-style directive is parsed into `budget.total`; that lives in harness code, not prompts.
6. **Relationship of Workflow engine to coordinator mode** — both consume the same `<task-notification>` envelope and both fan out subagents, but one is deterministic (JS script) and one model-driven. Whether a coordinator can *call* Workflow (`WORKFLOW_TOOL_NOTE` is a conditional slot in the coordinator system prompt) suggests yes, but the composition rules aren't spelled out.
7. **`ultracode` vs `ultraplan` vs `ultrawork`** naming — `ultrawork` was renamed to `workflow` (2.1.153) then the standing-mode keyword became `ultracode` (2.1.154–157); `ultraplan` is a *separate* remote-plan-mode feature. The three should not be conflated despite the shared "ultra" prefix.
