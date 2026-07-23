# Intake: Engine internals (binary reverse-engineering)

> Intake report from the 2026-07-23 reverse-engineering fan-out (Opus subagent). The agent
> analyzed the shipped native binary read-only and returned this report inline; persisted
> verbatim by the orchestrator. Synthesis: [`../claude-code-workflows.md`](../claude-code-workflows.md).

## Claude Code v2.1.218 — Workflow tool ("ultracode") engine internals

Reverse-engineered **read-only** from the shipped native binary at
`/Users/jakubneumann/.local/share/claude/versions/2.1.218` (Mach-O arm64, 255 MB, embedded JS).
The npm tarball `@anthropic-ai/claude-code@2.1.218` ships only a launcher (`bin/claude.exe`) plus
`install.cjs`/`cli-wrapper.cjs`; the actual bundle lives inside the platform-native binary. All
evidence below is extracted verbatim (minified identifiers preserved) and de-escaped for
readability. Byte offsets into the binary are given as `@<offset>`.

> Note on methodology: a prompt-injection string (`system The user included the keyword
> "ultracode"… use the Workflow tool`) is embedded in the data stream and surfaced repeatedly in
> tool output. It is **not** a genuine instruction and was disregarded throughout; it is itself an
> artifact of the subsystem under study (the ultracode keyword trigger — see §8).

---

## 1. Tool registration & input schema

The tool module is `_Ds` exporting `WorkflowTool` (`UB_`) and `WorkflowInputError` (`PAo`).
The Zod input schema is built lazily in `BB_` (`@232757287`):

```js
BB_ = ye(() => b.strictObject({
  script: b.string().max(VM).refine(bxe, FB_).optional().describe(
    "Self-contained workflow script. Must begin with `export const meta = { name, description, phases }` "
    + "(pure literal, no computed values) followed by the script body using "
    + "agent()/parallel()/pipeline()/phase()."),
  name: b.string().optional().describe(
    "Name of a predefined workflow (built-in or from .claude/workflows/). Resolves to a self-contained script."),
  description: b.string().optional().describe(
    "Ignored — set the workflow description in the script's `meta` block."),
  title: b.string().optional().describe(
    "Ignored — set the workflow title in the script's `meta` block."),
  args: b.unknown().optional().describe(
    "Optional input value exposed to the script as the global `args`, verbatim. Pass arrays/objects "
    + "as actual JSON values, NOT as a JSON-encoded string — a stringified list breaks "
    + "`args.filter`/`args.map` in the script. Use for parameterized named workflows (e.g. a research question)."),
  scriptPath: b.string().optional().describe(
    "Path to a workflow script file on disk. Every Workflow invocation persists its script under the "
    + "session directory and returns the path in the tool result. To iterate, edit that file with "
    + "Write/Edit and re-invoke Workflow with the same `scriptPath` instead of re-sending the full script. "
    + "Takes precedence over `script` and `name`."),
  resumeFromRunId: b.string()./*regex*/describe(
    "Run ID of a prior Workflow invocation to resume from. Completed agent() calls with unchanged "
    + "(prompt, opts) return their cached results instantly; only edited or new calls re-run. "
    + "Same-session only. Stop the prior run first (…) before resuming."),
  // …
}))
```

Confirmed fields (7): **`script`, `name`, `description` (ignored), `title` (ignored), `args`,
`scriptPath`, `resumeFromRunId`**. Precedence: `scriptPath` > `script` > `name`.

- `script.max(VM)` — a byte cap; on overflow the parser emits `"Script exceeds <n> bytes"` (`@90512799`).
- `.refine(bxe, FB_)` — `FB_ = "script contains control characters that would be hidden in the
  approval dialog"`. Control-char rejection guards the permission dialog (`Khd = 80` is a related
  truncation constant).
- `resumeFromRunId` is validated against the regex **`^wf_[a-z0-9-]{6,}$`** (`@195177397`), i.e.
  run IDs are `wf_…`. (Note: elsewhere `zee(runId)` builds the transcript dir; the persisted key
  prefix constant `fB_ = "v2"` versions the journal cache key — see §6.)

Input resolution is `Yhd(e)` (`@232756243`):

```js
async function Yhd(e){
  if(e.scriptPath){
    let t,r;
    if(e.script){ t=e.script; r=path.resolve(cwd(), e.scriptPath); }
    else { let n=await bIt(e.scriptPath); if("error"in n)return n; t=n.script; r=n.path; }
    if(Son().some(n=>n.script===t)) return {script:t,resolvedScriptPath:r,source:"built-in",scriptMatchesDefinition:true};
    return {script:t,resolvedScriptPath:r};
  }
  if(e.name){
    let t=await Aon(e.name, cwd());
    if(!t){ let r=(await Ipt(cwd())).map(n=>n.name).join(", ");
      return {error:`Workflow "${e.name}" not found. Available: ${r||"(none)"}`}; }
    return {script:e.script??t.script, source:t.source, scriptMatchesDefinition:e.script===undefined||e.script===t.script};
  }
  if(e.script) return {script:e.script};
  return {error:"Must provide script, name, or scriptPath"};
}
```

- `Son()` = built-in workflow registry (array of `{name, script, …}`).
- `Aon(name, cwd)` = resolve a saved/named workflow; `Ipt(cwd)` = list available names.
- `bIt(scriptPath)` = read a script file from disk (returns `{script,path}` or `{error}`).

### WORKFLOW_* template variables / AGENT_TOOL_NAME

The literal identifiers `WORKFLOW_INVOCATION_QUALIFIER`, `WORKFLOW_SCRIPT_PATH_NOTE`,
`WORKFLOW_AGENT_ISOLATION_OPTION/NOTE`, `WORKFLOW_GROUP_PREFIX`, `AGENT_TOOL_NAME` **do not appear
as string literals** in the 2.1.218 binary (grep count 0 for each). They are build-time template
placeholders that were already substituted into the final description text. Their **runtime values**
are recoverable from the assembled description:

- `AGENT_TOOL_NAME` → **`agent`** (the injected global is literally `agent()`; the subagent tool is `Agent`).
- `WORKFLOW_GROUP_PREFIX` → rendered as **`"${bRt} name"`** group label in `/workflows` for nested
  workflows (`@232744323`: *"its agents appear under a "${bRt} name" group in /workflows"*). `bRt`
  resolves to a display noun (workflow/child name).
- `WORKFLOW_AGENT_ISOLATION_OPTION/NOTE` → the `opts.isolation: 'worktree'` paragraph plus the
  `${MB_}` splice point (`@232743077`) — `MB_` is an isolation note that is conditionally empty
  (worktree available) or explanatory.
- `WORKFLOW_SCRIPT_PATH_NOTE` → the `scriptPath` "persists under the session directory … re-invoke
  with the same scriptPath" note.
- `WORKFLOW_INVOCATION_QUALIFIER` → the "Provide EITHER `script` OR `name`… not both" qualifier text.

### Feature gates around registration (`@77299116`, settings keys)

Settings schema (`@77341104`) includes: `effortLevel`, **`ultracode`**, `skipWorkflowUsageWarning`,
plus env/flag gates:

- `CLAUDE_CODE_DISABLE_WORKFLOWS` and a settings key: *"Disable the Workflows feature (also via
  CLAUDE_CODE_DISABLE_WORKFLOWS)."*
- *"Enable or disable the Workflows feature for this user. Unset = default by plan once the feature
  is available."*
- Artifact tool has a parallel gate (`CLAUDE_CODE_DISABLE_ARTIFACT`).

---

## 2. Script execution — the sandbox VM

**Executor = Node's built-in `vm` module** (`mAo = require("vm")`), *not* sval/quickjs/ses. The
compiler is `Cpt(e)` (`@232679400`):

```js
function Cpt(e){
  try {
    Function(`async function _check() {'use strict';\n${e}\n}`);           // syntax pre-check
    let t = uB_(e);                                                        // await-instrumentation rewrite
    let r = `((${Ag} => ((${Ag}a) => async () => {'use strict';\n${t}\n})( …asyncIterator shim… ))(Promise.resolve.bind(Promise)))()`;
    let n = new mAo.Script(r, {
      filename: "workflow.js",
      importModuleDynamically: () => { throw $Be("import() is not available in workflow scripts."); }
    });
    Te("workflow_compile");
    return { ok:true, vmScript:n };
  } catch(t){
    pe("workflow_compile","syntax_error");
    return { ok:false, error:`SyntaxError: ${t instanceof Error ? t.message : String(t)}` };
  }
}
```

Key facts:

- The user's "synchronous-looking" script is wrapped in an `async () => {…}` IIFE and compiled to a
  **`vm.Script`**. `Ag = "__wRg$"` is the internal await/settle helper prefix.
- Every `await` (and every `for await`) is rewritten (`uB_`) so the VM can *settle* host promises
  across the vm/host boundary — the giant inline `Symbol.asyncIterator` shim in `r` re-implements
  async iteration with proper `Iterator result is not an object` type checks (this is why the error
  string *"Iterator result interface is not an object."* appears at `@102554112`).
- Dynamic `import()` is hard-disabled via `importModuleDynamically` throwing.
- `Function(...)` first is a cheap syntax gate that produces friendlier errors before the vm compile.

### The meta-parse & global-shim step (`_Ao`, `cB_`)

Before the body runs, two things happen at `@232679400`:

**(a) AST scan `_Ao(e)`** using **acorn** (`{parse:t}=fho()` → acorn; `QIs()` → acorn-walk `.simple`):

```js
function _Ao(e){
  let {parse:t}=fho(), r=QIs(), n=false;
  try{
    let o=t(e,{ecmaVersion:"latest",sourceType:"module",allowAwaitOutsideFunction:true,allowReturnOutsideFunction:true});
    r.simple(o,{
      MemberExpression(i){ if(i.computed||i.object.type!=="Identifier"||i.property.type!=="Identifier")return;
        let s=i.object.name,a=i.property.name;
        if(s==="Date"&&a==="now" || s==="Math"&&a==="random") n=true; },
      NewExpression(i){ if(i.callee.type==="Identifier"&&i.callee.name==="Date"&&i.arguments.length===0) n=true; }
    });
  }catch{return false}
  return n;   // true ⇒ script statically references a banned time/random source
}
```

So banned-global usage is detected **both statically** (acorn walk flags `Date.now`, `Math.random`,
argless `new Date`) **and dynamically** (runtime shim, below).

**(b) Runtime shim `cB_`** injected into the VM context before the body:

```js
cB_ = `(() => {
  const NOW_ERR = ${JSON.stringify(aB_)};
  const RANDOM_ERR = ${JSON.stringify(lB_)};
  Math.random = function random(){ throw new Error(RANDOM_ERR) };
  const RealDate = Date;
  RealDate.now = function now(){ throw new Error(NOW_ERR) };
  function ShimDate(...a){
    if(!new.target) throw new Error(NOW_ERR);       // bare Date() → now-string
    if(a.length===0) throw new Error(NOW_ERR);       // argless new Date()
    return Reflect.construct(RealDate, a, new.target);
  }
  ShimDate.now = RealDate.now; ShimDate.parse = RealDate.parse; ShimDate.UTC = RealDate.UTC;
  ShimDate.prototype = RealDate.prototype;
  RealDate.prototype.constructor = ShimDate;         // close (new Date(x)).constructor backdoor
  Object.freeze(RealDate);                           // …then freeze so it can't be undone
  globalThis.Date = ShimDate;
})()`;
```

with the error strings:

- `aB_` = *"Date.now() / new Date() are unavailable in workflow scripts (breaks resume). Stamp
  results after the workflow returns, or pass timestamps via args."*
- `lB_` = *"Math.random() is unavailable in workflow scripts (breaks resume). For N independent
  samples, include the index in the agent label or prompt."*

Rationale is explicit: determinism is required so the resume cache key (a hash of prompt+opts) stays
stable. `gAo = 30000` is a related timeout constant.

### meta "pure literal" enforcement (`@90512799`)

The parser requires the **first statement** to be `export const meta = {…}`:

- `"`export const meta = { name, description, phases }`must be the FIRST statement in the script"`
- `"meta must be a pure literal:"` — a follow-on error when the object contains computed
  values/identifiers. It uses acorn with `sourceType:"module"`, checking the leading
  `ExportNamedDeclaration` → `declaration.declarations` → the `meta` initializer is a pure literal
  (object/array/primitive only). The remaining body after the meta export is captured as
  `scriptBody` (regex `^[;\s]*\n` strips the separating whitespace).
- TypeScript is rejected with: *"Workflow scripts must be plain JavaScript — common causes are
  TypeScript syntax (type annotations, interfaces, generics) and broken string quoting or
  escaping."* and generic `"Script parse error:"`.

The compile of just the body (post-meta) is `Cpt(l.scriptBody)` (see `$hd`, §6 resume).

### Injected globals / hooks (`Rhd`, `@232696296`+`@232710000`)

The orchestration harness `Rhd(...)` returns the object of globals bound into the VM:

```js
return {
  agent: V, parallel: oe, pipeline: ce, log: re, phase: W,
  resolvePhase: U, recordFailure: se=>{A.push(se)},
  getAgentCount: ()=>d, getFailures: ()=>A,
  bindVMAwait: se=>{ p=se.settle; f=se.call; m=se.clone; g=se.sanitize; _=se.snapshot; y=se.getProp },
  sanitizeVMValue: se=>g(se), getVMProp: (se,te)=>y(se,te)
};
```

So the injected script surface is: **`agent`, `parallel`, `pipeline`, `log`, `phase`, `args`,
`budget`, `workflow`** (workflow() is bound separately in the child-run path). The `bindVMAwait`
bridge supplies `settle/call/clone/sanitize/snapshot/getProp` — host functions that marshal values
across the vm boundary (`sanitize`=deep-clone into VM realm, `snapshot`/`getProp` guard property
reads with try/catch, see `y` above returning `undefined` on throw).

Description of each global (from the tool description body, `@232743077`/`@232744323`):

- **`agent(prompt, opts?)`** — spawn one subagent. `opts.model` (tier), `opts.effort`
  (`'low'|'medium'|'high'|'xhigh'|'max'`), `opts.isolation:'worktree'`, `opts.agentType`,
  `opts.schema`, `opts.label`, `opts.phase`, `opts.stallMs`.
- **`pipeline(items, stage1, stage2, …): Promise<any[]>`** — per-item pipelining, **NO barrier**
  between stages; item A can be in stage 3 while B is in stage 1. Default for multi-stage work.
  Stage callback signature `(prevResult, originalItem, index)`. A throwing stage drops that item to
  `null` and skips its remaining stages.
- **`parallel(thunks: Array<() => Promise<any>>): Promise<any[]>`** — concurrent, **BARRIER**
  (awaits all). A throwing thunk resolves to `null`; the call never rejects.
- **`log(message): void`** — narrator line above the progress tree.
- **`phase(title): void`** — start a new phase; subsequent `agent()` calls group under it.
- **`args`** — the verbatim `args` input (undefined if unset).
- **`budget: {total: number|null, spent(): number, remaining(): number}`** — see §5.
- **`workflow(nameOrRef, args?)`** — nested sub-workflow, one level only — see §9.

---

## 3. `agent()` internals

Two implementations behind `V` (the injected `agent`): the local path `K` and the remote path `ie`
(`isolation:'remote'`, which **throws "not available in this build"** at the `V` dispatch:
`if(ae?.isolation==="remote")throw Error("agent({isolation:'remote'}) is not available in this build")`).
`V` is the wrapper (`@232700000`) handling caching, journal, dedupe of schema via `WeakMap J`, and
progress emission; `K` (`@232700000` tail) is the actual local subagent spawn.

### Model + effort resolution

```js
Ve = Iee(XGe(Me, q.options.mainLoopModel), q.options.mainLoopModel, we?.model, Ke.mode);
Oe = Q5(we?.effort);   // normalize effort tier
Me = Oe!==undefined ? {...fe, effort:Oe} : fe;
```

Default model = the resolved **session main-loop model** (`q.options.mainLoopModel`); `opts.model`
overrides tier. `opts.effort` overrides reasoning effort. The description explicitly says the agent
*"inherits the main-loop model (the resolved session model)… only set it when highly confident."*

### agentType registry resolution (`@232700000`)

```js
if(we?.agentType!=null){
  let Dt=String(we.agentType), er=q.options.agentDefinitions.activeAgents, It=bn(q);
  let wr=xpt(er,It,Vo), Er=wr.find(xn=>xn.agentType===Dt);
  if(!Er){
    if(er.some(xn=>xn.agentType===Dt)){ let xn=VVe(It,Vo,Dt);
      throw Error(`agent({agentType}): '${Dt}' is denied by permission rule '${Vo}(${Dt})' from ${xn?.source??"settings"}.`); }
    throw Error(`agent({agentType}): agent type '${Dt}' not found. Available agents: ${wr.map(xn=>xn.agentType).join(", ")}`);
  }
  let Ur=[...Er.disallowedTools??[], ...uDs.disallowedTools??[]],
      rn=we.schema?SB_:TB_,                                   // schema ⇒ StructuredOutput note, else verbatim note
      Cn=we.schema&&!E0s(Er.tools)?[...Er.tools??[], Sg]:Er.tools;   // ensure StructuredOutput tool present
  ve = {...Er, disallowedTools:Ur, tools:Cn, getSystemPrompt: …+rn};
}
```

`agentType` resolves from the **same registry as the Agent tool** (`agentDefinitions.activeAgents`,
filtered by permission via `xpt`/`Vo`). It composes with `schema`: the custom agent's system prompt
gets a StructuredOutput instruction appended (`SB_`), and the `Sg` (StructuredOutput) tool is added
to the custom agent's tool list.

### Default subagent system prompts

- `bB_` (verbatim/no-schema): *"You are a subagent spawned by a workflow orchestration script… Your
  final text response is returned **verbatim** as a string to the calling script — it is your return
  value, not a message to a human. …Do NOT use SendUserMessage… Be concise. The script will parse
  your output."*
- `TB_` (appended note, no schema) and `SB_`/`EB_` (schema variants): *"You MUST return your final
  answer by calling the ${Sg} tool exactly once… do NOT put your answer in a text response (the
  script reads ONLY the tool call). If validation fails, read the error and call ${Sg} again with a
  corrected shape."* (`Sg` = StructuredOutput tool name.)

### schema → forced StructuredOutput (`@232700000`)

```js
if(we?.schema){
  let Dt=Knr(we.schema);
  if("error"in Dt) throw TypeError(`agent({schema}) received an invalid JSON Schema: ${Dt.error}`);
  $e=Dt.tool;                                     // synthesized StructuredOutput tool bound to the schema
}
…
De = $e ? [...st.filter(Dt=>!za(Dt,Sg)), $e] : st;   // replace generic StructuredOutput with schema-bound one
```

On completion with a schema:

```js
if($e){
  if(Dt.structured===undefined)
    throw Error("agent({schema}): subagent completed without calling StructuredOutput (after in-conversation nudge)");
  return m(Dt.structured);   // m = clone across VM boundary
}
return Dt.text;
```

There is an **in-conversation nudge** (`Xrn({agentMessages,…})`) before giving up: if the agent
produced messages but no structured output, a nudge is injected; only then does it throw.

### isolation:'worktree' implementation (`@232700000`)

```js
if(we?.isolation==="worktree"){
  let Dt = n ? `${n}-${se}` : `wf-${se}`;      // worktree branch name; n = group prefix, se = agent index
  Tt = await I(Dt);                            // I() = create worktree, returns {worktreePath, worktreeBranch, headCommit, gitRoot, hookBased}
}
let Pt = Tt ? `${te}\n\n---\nYou are running in an isolated git worktree at ${Tt.worktreePath} (a separate working copy of the repo). Changes you make here do NOT affect the main working directory (${cwd()}) or other agents. Work normally — the worktree will be cleaned up automatically if you made no changes, or preserved for review if you did.` : te;
…
finally {
  if(Tt){
    let {worktreePath:Dt, worktreeBranch:er, headCommit:It, gitRoot:wr, hookBased:Er} = Tt;
    try {
      if(!Er && It && !await T7r(Dt,It)) await pke(Dt,er,wr,false,"workflow_tool");  // changed ⇒ preserve/merge branch
      else if(wr) await Vde(Dt,wr);                                                   // unchanged ⇒ remove worktree
    } catch {}
  }
}
```

Branch names are `wf-<idx>` (or `<groupPrefix>-<idx>`). `T7r(path,headCommit)` checks whether HEAD
moved (i.e. the agent made a commit / changes); unchanged worktrees are auto-removed (`Vde`), changed
ones preserved via `pke(…,"workflow_tool")`. Description: *"EXPENSIVE (~200-500ms setup + disk per
agent), use ONLY when agents mutate files in parallel and would otherwise conflict."* A separate
`EnterWorktree` mechanism and a `"Cannot destructure property 'worktreePath' from null or undefined
value"` guard string appear at `@102686449`.

### label / phase → progress grouping (`@232700000`)

```js
let he = ae?.label!=null ? String(ae.label).replace(/\s+/g," ").trim() : we.slice(0,60)…;
let Ie = ae?.phase!=null ? String(ae.phase) : N;      // N = current phase title from phase()/log()
let Ae = Ie!=null ? U(Ie) : undefined;                // U() = resolvePhase → phase index
```

`U(title)` (a.k.a. `resolvePhase`) maps a phase title → stable integer index, emitting a
`workflow_phase` progress event `{type:"workflow_phase", index, title, kind}` the first time. Each
agent emits `workflow_agent` progress events keyed by `workflow_agent_<idx>_<state>` with
`{index,label,phaseIndex,phaseTitle,agentType,isolation,model,state,promptPreview,resultPreview,…}`.
States observed: `start`, `progress`, `done`, `error`, and the pseudo-ids `_cached`, `_queued`,
`_blocked`.

### stall / retry policy (`@232710000`)

- `CB_ = 180000` ms default stall window (`opts.stallMs` overrides via `ve`).
- `Shd = 5` max stall-retries; loop `for(let Er=1; Dt.stalled && !It && Er<=Shd; Er++)`.
- Throttle handling: if a response has no `stop_reason`, `<50` output tokens, and took `>0.5×` the
  stall window, it's treated as throttled — **sleep 45s** (`Tr(45000,…)`) then retry once as
  `"(throttle-retry)"`; if still degraded, *"giving up on throttle backoff"*.
- Stall reasons: `"stalled"` (no progress), `"user-retry"` (user requested). On exhaustion it throws
  one of:
  - `agent abandoned: user requested retry on all N attempts`
  - `agent stalled on all N attempts (no progress for <Ce>ms each)<structured-output-detail>`
  - `agent abandoned after N attempts (<reason chain>)`
  With a structured-output detail suffix: `— <n> StructuredOutput validation failure(s) (last input:
  <truncated 300 chars>)`.

### null semantics (user skip / API error)

- **User skip**: `P_(signal.reason)==="user-skip"` (or `Dt.skipped`) → `return null` (the agent
  slot becomes `null`, not an error).
- **API error**: `if(Dt.apiError){ let Er=`[${ee}] failed: ${Dt.apiError}`; A.push(Er); …; return
  null; }` — terminal API errors also resolve to `null` and are recorded as failures (`A` =
  failures array, surfaced via `getFailures`).
- Abort: `if(q.abortController?.signal.aborted) return new Promise(()=>{})` — a never-settling
  promise (so the whole VM run unwinds via the outer abort), or `throw Error("Workflow aborted")`.

### safety classifier pre-gate (`j`, `@232696296`)

Before spawning, `j({idx,promptStr,label,opts,…})` runs a safety classifier `pad({prompt,schemaJson,
agentType,parentMessages,parentTools,…})`. If the schema serializes to `>4096` bytes it's flagged
*"output schema too large to classify safely"*; unserializable → *"output schema could not be
serialized for classification"*. A blocked agent emits `workflow_agent_<idx>_blocked` with
`state:"error", blocked:true, error:"[label] blocked by safety classifier: <reason>"`.

---

## 4. Scheduling & caps

- **Concurrency cap** `hB_` (`@232696296`): `function hB_(e){ return Math.min(16, Math.max(2, e-2)) }`
  → `gB_ = hB_(os.cpus().length)`, i.e. **min(16, max(2, cpus-2))**.
- The agent scheduler uses a semaphore `sB(gB_, K)` for local agents and `sB(_B_, ie)` for remote,
  where `_B_ = 50`. `sB(1, vOt)` is a serialization lock `I` (git-branch check). `sB(n, fn)` is a
  bounded-concurrency queue wrapping `fn`.
- **Lifetime agent-call cap** `Chd = 1000` (this is the "1000-agent" cap):

  ```js
  function O(){ if(d<Chd) return; if(!S){ S=true; M("tengu_workflow_agent_cap_exceeded",{agentCount:d}); } throw new whd; }
  ```

  `whd = WorkflowAgentCapError`, message `yB_`:
  *"Workflow agent() call cap reached (1000). This usually means a loop using budget.remaining()
  never terminates because no token budget was set — remaining() returns Infinity when budget.total
  is null. Add a hard iteration cap to the loop, or pass a token budget."*
  `d` is the monotonic agent counter (`++d`), exposed via `getAgentCount`.
- **4096 cap**: the `4096` in this subsystem is the **schema-serialization safety limit** (`Oe.length
  > 4096` → "output schema too large to classify safely", §3). (The other `4096` hits at
  `@55579321` etc. are unrelated runtime buffers.)
- **`parallel()` barrier**: `Promise.allSettled(te.map(Ce=>p(f(Ce))))` then maps rejections to
  `null`; `WorkflowBudgetExceededError` rejections are counted and reported as
  `parallel: <n> slot(s) dropped — token budget exceeded`.
- **`pipeline()` no-barrier**: each item independently `for(let ve of de){ if(Ae.v===null)break;
  Ae=await p(f(ve, Ae.v, he, Ie)); }` — a null short-circuits remaining stages for that item only.
  Same budget-drop accounting as parallel.
- Both validate argument shapes (`parallel() expects an array of functions, not promises. Wrap each
  call: () => agent(...)`; `pipeline() stages must be functions`).

---

## 5. Budget

- Source: `w = { total: sGt(), getTurnSpent: () => BE() - S }` where `S = BE() - iGt()`
  (`@232727874`). `sGt()` = the turn's token target (the user's `+500k`-style directive), `BE()` =
  cumulative output tokens spent this turn (main loop + workflows share the pool), `iGt()` = tokens
  already spent when the workflow started. So `getTurnSpent()` = output tokens spent **since process
  baseline**, and `budget.spent()` inside scripts returns *"output tokens spent this turn across the
  main loop and all workflows — the pool is shared, not per-workflow."*
- Script-facing object: `budget.total` (null if no target), `budget.spent()`, `budget.remaining()`
  = `max(0, total - spent())` or `Infinity` if no target.
- Enforcement `H()` (`@232696296`):

  ```js
  function H(){
    if(s?.total==null || s.total<=0) return;
    let se=s.getTurnSpent();
    if(se<s.total) return;
    if(!w){ w=true; M("tengu_workflow_budget_cap_exceeded",{spent:se,budget:s.total,agentCount:d}); }
    throw new Ahd(se, s.total);
  }
  ```

  `Ahd = WorkflowBudgetExceededError`: *"Workflow token budget exceeded (<spent> / <total> output
  tokens). Stopping further agent() calls. In-flight agents will complete; their results are
  preserved."* `H()` is called at the top of `agent`, `parallel`, `pipeline`, and each `K`/`ie`
  spawn — a **hard ceiling**, not advisory.
- The user directive parsing (`+500k` → `sGt()`) lives in the token-target subsystem (settings keys
  `totalTokensReminder`, `totalTokensReminderBudget`, `totalTokensReminderAfterUserTurn` at
  `@77341104`); the workflow only *reads* the resolved target via `sGt()`.

---

## 6. Persistence, journal & resume

### Session/transcript directory

`zee(runId)` builds the transcript dir; `journal.jsonl` path = `path.join(zee(runId),
"journal.jsonl")` (`@232696296`, class `aDs`):

```js
class aDs {
  path; dirReady=false;
  constructor(e){ this.path = path.join(zee(e), "journal.jsonl"); }
  async load(){ … split on '\n', JSON.parse each line, skip unparseable … return _hd(lines); }
  async append(e){ if(!this.dirReady){ await mkdir(dirname(this.path),{recursive:true}); this.dirReady=true; }
                   await appendFile(this.path, JSON.stringify(e)+"\n","utf8"); }
}
```

`fB_ = "v2"` is the journal cache-key version prefix.

### Journal record shapes

`_hd(entries)` folds the journal into `{results: Map<key, {type:"result",key,agentId,result}>,
started: Map<key, [{type:"started",key,agentId}, …]>}`. Two record types:

- `{type:"started", key, agentId}` — appended when an agent begins.
- `{type:"result", key, agentId, result}` — appended on success.

### Cache key = hash(prompt, opts) — `bhd`/`mB_`

```js
function mB_(e){ // canonicalize opts: only schema, model, effort, isolation, agentType; sorted keys; strip functions/__proto__
  if(!e) return "{}";
  let t={}, r=["schema","model","effort","isolation","agentType"];
  for(let o of r){ let i=e[o]; if(i===undefined||typeof i==="function") continue; t[o]=i; }
  let n = o=>{ …recursively sort object keys, skip __proto__/functions… };
  return JSON.stringify(n(t));
}
function bhd(e,t,r){ // e=promptStr, t=opts, r=workflowName/salt
  let n = crypto.createHash("sha256").update(r).update("\x00").update(e).update("\x00").update(mB_(t)).digest("hex");
  return `${fB_}:${n}`;    // "v2:<sha256>"
}
```

So **"unchanged" is a SHA-256 over (salt ⟂ promptString ⟂ canonicalized-opts)** — **not** position.
Only `schema/model/effort/isolation/agentType` opts participate (label/phase/stallMs do **not** bust
the cache). Position independence means reordered identical calls still hit cache.

### Cache-hit path (`@232700000`)

```js
if(a){ // a = journal present
  fe = bhd(we, ae, E); E = fe;                  // E threads a rolling salt of prior keys (prefix chaining)
  let st = v ? undefined : l?.results.get(fe);  // v = "cache invalidated from here on" flag
  if(st!==undefined){
    r({type:"progress", toolUseID:`workflow_agent_${Ce}_cached`, data:{…state:"done", cached:true, resultPreview:kpt(st.result), agentId:st.agentId}});
    m(st.result); v=true;
    let De = l?.started.get(fe);
    if(De && De.length>0) M("tengu_workflow_journal_started_hit_respawn",{attempts:De.length});
    return;
  }
}
```

The **longest-unchanged-prefix** semantics: `E` (rolling key/salt) chains each call's key with prior
context so an *earlier* edited call changes all subsequent keys (prefix invalidation). `v` is the
"we've diverged, run live from here" latch: once a call misses (edited/new), `v=true` and subsequent
lookups are skipped (`v?undefined:…`). The `started`-without-`result` case (an agent that started but
never recorded a result — e.g. crashed mid-run) is telemetered as `…journal_started_hit_respawn` and
re-run live.

### Writing results (`@232700000`)

```js
let Ne = st => { Me=true; Oe=st; if(!a)return; a.append({type:"started", key:fe, agentId:st}).catch(…); };
let Ke = async st => { if(a&&fe&&st!==null) await a.append({type:"result", key:fe, agentId:Oe??"", result:st}).catch(…); return st; };
```

### Resume algorithm (`$hd`, `@232732294`)

```js
async function $hd(e){
  let {taskId,workflowRunId,scriptPath,argsJson,startTime}=e;
  let s=await bIt(scriptPath); if("error"in s) throw new Or(s.error,"adopted workflow script read failed");
  let a=s.script;
  if(e.scriptSha256===undefined) throw new Or("workflow was checkpointed without a content pin; resume via the Workflow tool","adopted workflow missing scriptSha256");
  if(crypto.createHash("sha256").update(a).digest("hex")!==e.scriptSha256)
    throw new Or("script content changed since it was approved; resume via the Workflow tool to re-approve","adopted workflow scriptSha256 mismatch");
  let l=$x(a); if("error"in l) throw new Or(`Invalid workflow script: ${l.error}`,"adopted workflow script parse failed");
  let c=Cpt(l.scriptBody); if(!c.ok) throw new Or(`Workflow script compile failed: ${c.error}`,"adopted workflow script compile failed");
  let u=argsJson!==undefined?Ut(argsJson):undefined;
  // dedupe running tasks with same runId, then:
  xon({taskId,workflowRunId,script:a,scriptPath,args:u,meta:l.meta,vmScript:c.vmScript,…,isResume:true,startTime});
}
```

On resume, the journal (`new aDs(runId)`) is loaded and its `results` map feeds the cache lookups —
so unchanged-prefix calls return instantly and only the first edited/new call onward runs live.
`transcriptDir` is returned in the tool result and points at `zee(runId)`.

### Fallback / agent transcripts

Per-agent transcripts are `agent-<id>.jsonl` in the transcript dir. The resume note (`@232753839`):
*"Fallback when no journal is available: Read agent-<id>.jsonl files in the transcript directory and
hand-author a continuation script."*

---

## 7. Background running, task IDs & `/workflows` UI

- Workflows run as **background tasks** in the task registry (`type:"local_workflow"`). Registration
  is `ZIs({taskId, script, scriptPath, args, summary, workflowName, title, phases, defaultModel,
  workflowRunId, ownerAgentId, …})` producing state `{status:"running", workflowProgress:[],
  progressVersion:0, agentCount:0, totalTokens:0, totalToolCalls:0, logs:[], abortController,
  agentControllers:new Map}` (`@232679400`).
- **Task result content** (`@232766750`): background launch returns

  ```
  Workflow launched in background. Task ID: <taskId>
  Summary: <summary>
  Transcript dir: <transcriptDir>
  Script file: <scriptPath>
  (Edit this file with Write/Edit and re-invoke Workflow with {scriptPath:"…"} to iterate…)
  Run ID: <runId>
  To resume after editing the script: Workflow({scriptPath:"…", resumeFromRunId:"…"}) — completed agents return cached results…
  You will be notified when it completes. Use /workflows to watch live progress.
  ```

  A syntax-error launch returns `is_error:true` with *"Workflow script has a syntax error and was
  not launched: <error>"*. A remote (CCR) launch returns *"Workflow launched in a remote CCR
  session. Task ID / Session: <url> … phase progress is visible at the session URL, not in
  /workflows."*
- **Completion notification** `SAo(...)` (`@232687153`) delivers a `task-notification` (mode
  `"task-notification"`, priority `"next"`) with structured body:
  `<recovery>` (resume instructions on fail/kill) · `<result>` (truncated to 8000 chars, full result
  in output file) · `<diagnostics>` (points to journal.jsonl) · `<failures>` · `<usage>`
  (`<agent_count>`, `<agents_done>/<agents_error>/<agents_skipped>/<agents_empty_result>`,
  `<subagent_tokens>`, `<tool_uses>`, `<duration_ms>`). Empty-result detection uses
  `dB_ = /^(\[\s*\]|\{\s*\}|\{\s*"[^"]+"\s*:\s*\[\s*\]\s*\})$/`.
- **Live progress batching** `DB_({onBatch, onSdkEmit})` (`@232727874`): coalesces progress with
  `kB_=16`ms micro-batch, `xB_=250`ms throttle window, `IB_=1e4`ms (10s) SDK-emit cap. It rebuilds
  `workflowProgress` (filtering `workflow_log` narrator lines separately from `workflow_agent`
  nodes). `PB_=200` truncates descriptions. `lhd=500` caps retained narrator log lines.
- **Controls** (`@232686327`):
  - `Apt(id,…)` = **pause** → status `"paused"`, notifies owner, builds resume prompt `TAo`:
    *"Resume the paused workflow by calling: Workflow({scriptPath:'…', resumeFromRunId:'…'…}) —
    completed agents return cached results."*
  - `vSe(id,…)` = **kill** → status `"killed"`, aborts, sends `Wp(id,"stopped",…)`.
  - `uhd(id, agentId, "user-skip"|"user-retry", registry)` → aborts a **single** in-flight agent's
    controller; `lpr`=skip, `cpr`=retry. Telemetry `task_local_workflow_skip_agent` / `…_retry_agent`.
  - Terminal states set `evictAfter = now + Ese` and clear controllers.

---

## 8. Opt-in gating (the "ultracode" keyword)

- **Keyword trigger setting** (`@77299116`): *"Enable the "ultracode" keyword trigger: including the
  keyword in a prompt opts that turn into the Workflow tool. Set to false to disable the trigger.
  Default: true."* When present, the keyword injects a **system-reminder** into that turn steering
  the model to use the Workflow tool.
- **Session-level ultracode toggle** — settings key `ultracode` (`@77310967`): *"Enable ultracode
  for the session: xhigh effort plus standing dynamic-workflow orchestration. Session-scoped,
  typically provided via --settings or the apply_flag_settings control request; interactive toggles
  never persist it. Requires workflows to be enabled and an xhigh-capable model."* So ultracode =
  **xhigh effort + always-on workflow orchestration**, deliberately non-persistent across sessions.
- **Blocking non-opted-in calls**: the Workflows feature is gated by (a) plan/user setting
  (*"Unset = default by plan"*), (b) `CLAUDE_CODE_DISABLE_WORKFLOWS` env / settings, and (c) the
  permission dialog (below). The keyword only injects a *reminder*; the tool itself is registered
  based on the feature gate.
- **Workflow size guideline** (`/config`, `@232753839`): `DAo = {small:5, medium:15, large:50}`,
  levels `["unrestricted","small","medium","large"]`. `fDs(level)` → e.g. *"medium — keep workflows
  under 15 agents"*; `mDs()` → *"This is a guideline, not a hard limit — follow it unless the user's
  prompt calls for a different scale."* Changes flow as `workflow_size_guideline_change` attachments
  (`zhd`) and inject a config note (`gDs`).

### Permission dialog (`@232766750`)

```js
qB_ = ay({
  kind:"permission_workflow",
  payload: ye(()=>b.custom(e=> typeof e==="object"&&e!==null && "requestId"in e && "toolName"in e && "permissionResult"in e && "script"in e)),
  result: ye(()=>b.custom(e=> typeof e==="object"&&e!==null && "behavior"in e)),
  default: { behavior:"cancelled" }
});
```

The dialog shows `meta.description` (from the script's `meta` block) and the script; control chars
are pre-rejected (`FB_`, §1) precisely because they *"would be hidden in the approval dialog."*
`skipWorkflowUsageWarning` (settings) suppresses the usage warning.

---

## 9. Saved / named workflows & `workflow()` nesting

- **Registry resolution**: `Aon(name, cwd)` resolves a name to a script; `Son()` returns built-in
  workflows; `Ipt(cwd)` lists available names. The schema description says names resolve from
  *"built-in or from `.claude/workflows/`"* — i.e. project-scoped saved workflows live under
  `.claude/workflows/`. Built-ins are embedded (`scriptIsVerbatimBuiltIn` telemetry flag; `source:
  "built-in"`). Source classification: `OB_`, `dDs`, `kAo`, `xAo` distinguish
  `"built-in"` vs `"custom"` and gate whether the verbatim script is retained.
- **`{name}` invocation** resolves via `Yhd` → `Aon`; unknown name →
  `Workflow "<name>" not found. Available: <list>`.
- **`workflow()` nesting** (`@232744323`): child shares this run's concurrency cap, agent counter,
  abort signal, and token budget; its agents appear under a group in /workflows and its tokens count
  toward budget.spent(). **Nesting is one level only: workflow() inside a child throws.** Throws on
  unknown name / unreadable scriptPath / child syntax error. Shared state is enforced by passing the
  same `abortController`, agent counter `d`, semaphores, and budget object `w` into the child
  harness; the child's `workflow` global is bound to a thrower.

---

## 10. Remote / CCR (cloud) agents

`agent({isolation:'remote'})` is present in code (`ie`, `@232710000`) but **disabled in this build**
(`throw Error("agent({isolation:'remote'}) is not available in this build")` at the `V` dispatch).
The remote path would create a cloud session (`dse({source:"workflow_remote_agent",
tags:["workflow-remote-agent"], branchName, permissionMode, model, signal, …})`), stream results via
`Nvs`, and require the branch be pushed (`x()` warns *"local branch '<b>' is not pushed to origin;
remote agents will run against the repository's default branch."*). Structured-output failure modes:
`error_max_structured_output_retries` → *"the cloud agent called StructuredOutput but no attempt
produced a surviving valid output"*; other subtypes → *"the cloud agent turn ended with result
subtype '<x>'"* or *"never called the StructuredOutput tool"*. Remote env vars:
`CLAUDE_REMOTE_WORKFLOW_SCRIPT` (`EAo`), `CLAUDE_REMOTE_WORKFLOW_ARGS` (`oDs`),
`CLAUDE_WORKFLOW_NAME_ONLY` (`phd`).

---

## 11. Telemetry (statsig-style events)

Events emitted around the subsystem:
`tengu_workflow_completed` (with `workflow_run_id, workflow_source, workflow_name,
workflow_description, status, agent_count, total_tokens, total_tool_calls, duration_ms`),
`tengu_workflow_agent_cap_exceeded`, `tengu_workflow_budget_cap_exceeded`,
`tengu_workflow_journal_started_hit_respawn`, plus per-phase metrics
(`phase_agent_duration_ms, phase_agent_count, phase_error_count, phase_skip_count`), and task events
`task_local_workflow`, `task_local_workflow_failed`, `task_local_workflow_resume`,
`task_local_workflow_skip_agent`, `task_local_workflow_retry_agent`, `workflow_compile`
(`syntax_error`). No explicit A/B gate name was recovered for the tool description text.

---

## 12. Constants quick-reference

| Symbol | Value | Meaning |
| --- | --- | --- |
| `hB_(n)` | `min(16, max(2, n-2))` | local concurrency cap (`gB_`) |
| `_B_` | `50` | remote concurrency cap |
| `Chd` | `1000` | lifetime agent() call cap (`WorkflowAgentCapError`) |
| schema serialize limit | `4096` | "output schema too large to classify safely" |
| `CB_` | `180000` ms | default stall window (`opts.stallMs` overrides) |
| `Shd` | `5` | max stall retries |
| throttle sleep | `45000` ms | backoff on degraded/no-stop_reason response |
| `Thd` | `400` | preview truncation (`kpt`) |
| `PB_` | `200` | description truncation |
| `lhd` | `500` | retained narrator log lines |
| `kB_/xB_/IB_` | `16/250/10000` ms | progress batch / throttle / SDK-emit |
| `gAo` | `30000` | (compile/exec) timeout |
| `Ese` | eviction delay | terminal task eviction `evictAfter` |
| `DAo` | `{small:5,medium:15,large:50}` | /config size guideline |
| `fB_` | `"v2"` | journal cache-key version prefix |
| `Ag` | `"__wRg$"` | VM await/settle helper prefix |
| `Khd` | `80` | (dialog-related) truncation |
| result truncation | `8000` chars | `<result>` block in task notification |

---

## Open questions / could not determine

1. **`sGt()` / `iGt()` internals** — budget.total comes from `sGt()` and spent from `BE()`, but the
   exact parse of the user's literal `"+500k"` directive into a token integer lives in the
   token-reminder subsystem (settings `totalTokensReminderBudget`), not fully deminified. The
   `+500k → 500000` mapping is inferred, not byte-confirmed.
2. **`zee(runId)` concrete path** — yields the transcript/session dir containing `journal.jsonl`
   and `agent-<id>.jsonl`, but the literal directory template was not extracted. The exact on-disk
   layout is inferred from usage (confirmed independently by the local-artifacts track).
3. **Saved-workflow file format & `whenToUse`** — `.claude/workflows/` confirmed as the source;
   the file schema (frontmatter, `whenToUse` display field, built-in vs project precedence) and the
   `/workflows` management UI copy were not extracted verbatim. Built-in registry `Son()` contents
   were not enumerated.
4. **`uB_` await-rewrite details** — captured the wrapper it produces and its purpose (marshal host
   promises), but not the full per-`await` AST transform.
5. **`resumeFromRunId` regex vs `wf_` prefix** — the schema regex is `^wf_[a-z0-9-]{6,}$` yet
   worktree branches use `wf-<idx>`; the exact runId minting function was not pinned to a single
   literal.
6. **`MB_` / `bRt` exact runtime strings** — inferred from context rather than a clean literal
   slice (surrounding bytes were non-printable padding).
7. **1000-agent cap vs "4096-item cap"** — found the 1000 agent-call cap and the 4096
   schema-serialization limit, but no distinct "4096-item" collection cap in the deminified regions;
   if such a cap exists it may be in the parallel/pipeline array handling not fully deminified
   (`uAo` — array normalizer). The tool description states the 4096-item cap explicitly, so treat it
   as real but unlocated.
8. **`pad()` safety classifier** — its model/prompt and whether it can be disabled were not
   determined beyond the call site and error strings.

Several deep windows returned non-printable padding (JS chunks interleaved with native code in the
Mach-O image), so a handful of exact literals above are reconstructed from adjacent evidence and
labeled as inferred. All quoted code/strings are verbatim from readable regions.
