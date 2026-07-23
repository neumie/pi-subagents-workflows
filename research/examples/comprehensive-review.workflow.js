export const meta = {
  name: 'comprehensive-review',
  description: 'PR #466 — start edit session from a source branch: fan out 6 area reviewers, adversarially verify contentious findings, synthesize one ranked report',
  phases: [
    { title: 'Review', detail: 'one Opus agent per area', model: 'opus' },
    { title: 'Verify', detail: 'adversarial re-check of contentious findings', model: 'opus' },
    { title: 'Synthesize', detail: 'one agent → final ranked report', model: 'opus' },
  ],
}
const SCOPE_BRIEF = `
# Scope brief — PR #466 "feat: start edit session from a source branch"
## What's being reviewed (DIFF scope)
- Repo: ~/projects/contember/webmaster (monorepo; called "nua"/"nuasite").
- Branch: feat/edit-different-branch. Base: main. Merge-base: e84b9c8e9a7e1ccc526a8efe179fda6e0a8483ab.
- Diff to review: \`git diff e84b9c8e9a7e1ccc526a8efe179fda6e0a8483ab..HEAD\` (17 files, +282/-30, 2 commits).
- CI is GREEN (build, lint, test all pass) — do NOT run tests/build yourself; you may check CI if needed.
## The feature
Lets a user seed a NEW edit session from an existing git branch instead of from main, behind a new
\`editFromBranch\` feature flag. CRUCIAL INVARIANT (stated in code comments): picking a source branch ONLY
changes the session's STARTING CONTENT — the publish/diff base MUST stay \`main\`. A reviewer should verify
nothing in this change alters the publish or diff base.
## Files in scope, grouped
Frontend (React Router v7 SSR app):
- app/components/session/branch-start-popover.tsx  (NEW — popover: branch picker + free-text fallback)
- app/components/session/versions-sidebar.tsx       (wires popover behind flag; shows session.sourceBranch badge)
- app/pages/project/overview.tsx                    (StartNewSessionButton wires popover behind flag)
Feature flag:
- packages/api/feature-flags.ts                     (adds editFromBranch, default disabled)
Worker RPC + DI:
- packages/worker/src/routes/app/handlers/project-handler.ts  (startSession takes optional sourceBranch, flag-gated; NEW app.project.listBranches RPC, flag-gated)
- packages/worker/src/container.ts                   (injects featuresCheckerFacade into AppProjectRpcFactory)
Buresh DO + services (the edit-session engine; see buresh/CLAUDE.md, packages/worker/CLAUDE.md):
- packages/worker/src/model/buresh/buresh-project-do.ts                       (startEditSession(presetId, sourceBranch?))
- packages/worker/src/model/buresh/internal/services/edit-initializer.ts      (threads sourceBranch; retry path)
- packages/worker/src/model/buresh/internal/services/session-service.ts       (threads sourceBranch; SessionDetails.sourceBranch; createSessionWithGit options refactor)
- packages/worker/src/model/buresh/internal/git/git-workspace-manager.ts      (createWorktree now: git fetch origin <sourceBranch> then worktree add ... origin/<sourceBranch>)
Storage / DB (Durable Object SQLite via kysely; D1-style migrations):
- packages/worker/src/model/buresh/internal/adapters/db/types.ts             (source_branch on SessionTable + EditInitTable)
- packages/worker/src/model/buresh/internal/storage/edit-init-repository.ts  (persist/read source_branch)
- packages/worker/src/model/buresh/internal/storage/session-repository.ts    (persist/read source_branch)
- packages/worker/src/model/buresh/migrations/2026-06-18-100000-add-session-source-branch.ts  (NEW — ALTER TABLE add source_branch)
- packages/worker/src/model/buresh/migrations/index.ts                       (registers migration; explicit list for esbuild bundling)
Tests:
- packages/worker/tests/cases/project-handler.test.ts          (factory dep + startEditSession assertion)
- packages/worker/tests/cases/project-handler-parity.test.ts   (factory dep)
## Project conventions (calibrate to THIS bar)
- Test framework: \`bun test\`; tests live in packages/worker/tests/cases/*.test.ts. DI mocks use a \`trapProxy<T>(name)\` helper (throws if an unmocked dep is touched). This is a production-grade worker — RPC handlers are expected to have unit tests for new behavior and gating.
- Typecheck: \`bun run ts:build\` (NOT npx tsc). Lint: biome (single quotes, no semicolons, tabs, width 150). No \`as\`/@ts-ignore/any allowed in this repo.
- Docs culture: root docs/ dir + per-package CLAUDE.md; code uses JSDoc on load-bearing methods. There is NO formal external API-doc requirement for internal RPCs — judge docs by: are load-bearing comments correct and is the new flag/behavior discoverable. Don't invent a docs bar the repo doesn't hold.
- Auth/ACL model: RPC handlers authorize a project via requireAuthorizedProject(adminApiClient, session, {slug}, fragment). Feature gating via featuresCheckerFacade.getForOrganization(session.activeOrganizationId).isFeatureEnabled('flag'). Feature flags are per-organization, default disabled, defined in packages/api/feature-flags.ts (zod).
- Git ops execute INSIDE a sandbox via sandbox.exec([...argv]) / sandbox.execOrFail([...argv]) — ARRAY argv, no shell interpolation. Auth tokens injected via gitAuthArgs(token). createWorktree gets { sourceBranch?, token? }.
- DO migrations are forward-only, listed EXPLICITLY in migrations/index.ts (not import.meta.glob) so plain wrangler/esbuild can bundle the worker.
## Notes / focus (known-risk territory — verify, don't assume; these are starting points, not a checklist; own your whole area)
- GIT COMMAND CONSTRUCTION: sourceBranch is user input validated only as z4.string().min(1).max(255) (no charset/format restriction). It flows into argv: \`git fetch origin <sourceBranch>\` and \`git worktree add -b session/<id> <workdir> origin/<sourceBranch>\`. No shell is used (array argv), so classic shell injection is out — but consider git ARGUMENT injection (a value starting with \`-\` parsed as a flag, e.g. \`--upload-pack\`), ref ambiguity, and whether \`origin/<sourceBranch>\` can be coerced into something unintended. Decide if the min/max-only validation is sufficient.
- AUTHZ / FLAG GATING: startSession only checks editFromBranch WHEN sourceBranch is present (no-branch path unchanged); listBranches ALWAYS checks the flag (throws NotFoundError when disabled, BadRequestError on bad/missing repo). Verify org-scoping is correct and that a user can't seed from a branch of a repo they shouldn't reach (note: branches come from the project's own configured repositoryUrl via an installation token).
- listBranches uses githubInstallationApiFactory.getBranches, which calls Octokit repos.listBranches WITHOUT pagination (GitHub returns ~30 by default). Repos with >30 branches will silently truncate the picker list — assess impact (there is a free-text fallback in the UI).
- INVARIANT: publish/diff base must remain main. Confirm sourceBranch only affects worktree start-point, not any publish/merge/diff logic.
- RETRY PATH: editInitRepo.resetForRetry then doInitialize(..., record.sourceBranch ?? undefined). Confirm a retried failed init re-seeds from the SAME source branch and re-fetches it.
- session.source_branch vs edit_init.source_branch both added — confirm both are needed (edit_init copy exists specifically so retry doesn't fall back to main).
- FRONTEND: popover renders BranchPicker only when \`open\`; useRpcQuery('app.project.listBranches') on open; handles loading/error/empty; free-text Start sends trimmed||undefined. The "New version" button markup is DUPLICATED across the flag-on/flag-off branches in versions-sidebar.tsx (simplicity lens). The picker filters client-side; selecting a row just fills the input.
- TESTS: there are NO tests for the new listBranches RPC, nor for the sourceBranch happy-path / flag-disabled rejection in startSession. Only the existing startSession test's assertion was updated.
- TYPE/REFACTOR: session-service.createSessionWithGit's param was renamed channelOptions -> options and widened to { channel?, channelIdentifier?, sourceBranch? }. Check no caller/behavior regressed.
`
const AREA_GUIDANCE = '/home/matej21/.claude/skills/comprehensive-review/references/review-areas.md'
const FINDING_FORMAT = '/home/matej21/.claude/skills/comprehensive-review/references/finding-format.md'
const AGENTS = [
  { key: 'completeness',  label: 'completeness',  sections: ['Completeness'] },
  { key: 'correctness',   label: 'correctness',   sections: ['Correctness'] },
  { key: 'security',      label: 'security',       sections: ['Security'] },
  { key: 'docs',          label: 'docs',           sections: ['Docs'] },
  { key: 'tests',         label: 'tests',          sections: ['Tests'] },
  { key: 'architecture',  label: 'architecture',   sections: ['Architecture', 'Simplicity / pushback'] },
]
const model = 'opus'
const SEV  = ['critical', 'high', 'medium', 'low', 'info']
const CONF = ['high', 'medium', 'low']
const FIX  = ['trivial', 'small', 'medium', 'large']
const PROV = ['introduced', 'pre-existing', 'n/a']
const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reviewed', 'findings'],
  properties: {
    reviewed: { type: 'string', description: 'One line on what you actually read.' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'location', 'severity', 'confidence', 'description', 'proposal', 'fixComplexity', 'provenance'],
        properties: {
          title:       { type: 'string', description: 'One line — what is wrong.' },
          location:    { type: 'string', description: 'path/to/file:line (or range, or several files); "—" only for whole-scope.' },
          severity:    { enum: SEV,  description: 'Impact IN THIS SYSTEM. critical=exploitable/data loss/breaks the feature; high=serious bug in normal use; medium=real but limited blast radius; low=minor nit; info=observation.' },
          confidence:  { enum: CONF, description: 'Is this REAL (not a false positive), independent of severity. Be honest — low confidence triggers the verify pass.' },
          description: { type: 'string', description: 'What is wrong AND why it matters, citing the evidence (the code, the missing case). NEVER paste a secret value — cite file:line + the kind of secret only.' },
          proposal:    { type: 'string', description: 'The concrete fix — what to change.' },
          fixComplexity:{ enum: FIX,  description: 'trivial=one-liner; small=localized; medium=a few places / needs care; large=design change.' },
          provenance:  { enum: PROV, description: 'For a DIFF scope: introduced=this change caused it; pre-existing=already in a touched file. Use n/a only for whole-project scope.' },
        },
      },
    },
    cleanNote: { type: 'string', description: 'If little/nothing wrong, name what you checked and found solid.' },
  },
}
const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'reasoning'],
  properties: {
    verdict:    { enum: ['confirmed', 'refuted', 'adjusted'], description: 'confirmed=holds; refuted=false positive; adjusted=real but wrong severity/confidence.' },
    severity:   { enum: SEV,  description: 'Corrected severity — only when adjusted.' },
    confidence: { enum: CONF, description: 'Corrected confidence — only when adjusted.' },
    reasoning:  { type: 'string', description: 'Evidence from the code.' },
  },
}
const reviewPrompt = (a) => [
  `You are a READ-ONLY code reviewer on a comprehensive review. Area(s): **${a.key}**.`,
  `Read the ${a.sections.map((s) => `"${s}"`).join(' and ')} section(s) of ${AREA_GUIDANCE} — use it as a lens, not a script to confirm.`,
  '',
  'You OWN your area across the whole diff. Hunt for what is wrong — do not just confirm the notes in the brief. The "Notes / focus" are starting points; find the sites the brief did not name.',
  'First run `git diff e84b9c8e9a7e1ccc526a8efe179fda6e0a8483ab..HEAD` to see the change, then READ the surrounding code in the files for context (the diff alone is not enough — open the files).',
  '',
  'Scope brief (do NOT re-derive it):', '"""', SCOPE_BRIEF, '"""', '',
  'Rules: read the code; do NOT edit/fix anything; do NOT run tests or the build (they ran in CI — green; check CI status only if you need the signal).',
  'Calibrate to the project bar in the brief. Do NOT assign finding IDs. If your area is clean, return findings: [] and a cleanNote naming what you checked and found solid.',
  'Every finding cites concrete evidence (file:line, the missing case). Flag uncertainty as low confidence rather than hiding it.',
  'NEVER paste a secret value into a finding — cite file:line + the kind of secret only, and recommend rotation.',
  'Set each finding\'s `provenance`: `introduced` (this change caused it) vs `pre-existing` (already in a touched file). This is a diff scope, so `n/a` should be rare.',
].filter(Boolean).join('\n')
const verifyPrompt = (f, conflict) => [
  'You are an ADVERSARIAL verifier. TRY TO REFUTE the finding by reading the cited code in ~/projects/contember/webmaster. Default to `refuted` if it does not clearly hold.',
  'Open the actual files (and run `git diff e84b9c8e9a7e1ccc526a8efe179fda6e0a8483ab..HEAD` if useful). Watch for the three refute-worthy false-positive classes:',
  '  1) BY-DESIGN behavior reported as a defect — an intentional default, a documented escape hatch, a stated invariant. If working as intended, refute.',
  '  2) MIS-ATTRIBUTED evidence — the issue does not actually appear at the cited file:line (wrong location, stale lines). If the evidence is not there, refute.',
  '  3) JUSTIFIED complexity flagged as over-engineering — an abstraction with a real second caller (e.g. edit_init.source_branch existing for the retry path), generality the brief calls for. If earned here, refute.',
  '', 'Scope brief:', '"""', SCOPE_BRIEF, '"""', '',
  `Finding — area:${f.area} · ${f.title} · ${f.location} · ${f.severity}/${f.confidence}`,
  `description: ${f.description}`, `proposal: ${f.proposal}`,
  conflict ? 'NOTE: another reviewer flagged the same location with a different severity — adjudicate the correct severity.' : '',
].filter(Boolean).join('\n')
phase('Review')
const reviews = await parallel(AGENTS.map((a) => () =>
  agent(reviewPrompt(a), { schema: FINDINGS_SCHEMA, phase: 'Review', label: a.label, model, agentType: 'general-purpose' })
    .then((r) => ({ a, r }))))
const all = [], reviewed = []
for (const x of reviews.filter(Boolean)) {
  const { a, r } = x
  reviewed.push({ area: a.key, reviewed: r.reviewed, cleanNote: r.cleanNote || '', count: r.findings.length })
  r.findings.forEach((f, j) => all.push({ ...f, area: a.key, ref: `${a.label}#${j + 1}` }))
}
const byLoc = {}
for (const f of all) (byLoc[f.location] = byLoc[f.location] || []).push(f)
const conflicted = new Set()
for (const loc of Object.keys(byLoc)) {
  const g = byLoc[loc]
  if (loc !== '—' && g.length > 1 && new Set(g.map((x) => x.severity)).size > 1) g.forEach((x) => conflicted.add(x.ref))
}
const isContentious = (f) =>
  f.confidence === 'low' ||
  ((f.severity === 'critical' || f.severity === 'high') && (f.fixComplexity === 'large' || f.fixComplexity === 'medium')) ||
  conflicted.has(f.ref)
const contentious = all.filter(isContentious)
log(`${all.length} findings; ${contentious.length} contentious → adversarial verify`)
phase('Verify')
const verdicts = await parallel(contentious.map((f) => () =>
  agent(verifyPrompt(f, conflicted.has(f.ref)), { schema: VERDICT_SCHEMA, phase: 'Verify', label: `verify:${f.ref}`, model, agentType: 'general-purpose' })
    .then((v) => ({ ref: f.ref, v }))))
const vByRef = {}
for (const x of verdicts.filter(Boolean)) vByRef[x.ref] = x.v
const kept = [], dismissed = []
for (const f of all) {
  const v = vByRef[f.ref]
  if (v && v.verdict === 'refuted')  { dismissed.push({ ...f, reason: v.reasoning }); continue }
  if (v && v.verdict === 'adjusted') { kept.push({ ...f, severity: v.severity || f.severity, confidence: v.confidence || f.confidence, verifyNote: v.reasoning }); continue }
  kept.push({ ...f, verifyNote: v ? v.reasoning : null })
}
phase('Synthesize')
const report = await agent([
  'You are the SYNTHESIS step of a comprehensive code review of PR #466 ("start edit session from a source branch").',
  `Read ${FINDING_FORMAT} and produce the "Synthesized report" markdown format defined there from the data below.`,
  'Dedupe across areas (same location + same root cause → one finding; keep the higher severity; union the proposals; note which areas raised it).',
  'Assign IDs (<AREA>-<n>, per-area counter; prefixes COMP/CORR/SEC/DOCS/TEST/ARCH/SIMP). Rank worst-first (severity, then confidence). Flag any finding the verify pass adjusted.',
  'This is a DIFF scope: lead with "Findings — introduced by this change", then a separate "Pre-existing (in touched files)" section.',
  'Include "Reviewed and clean" (from reviewed[]), a "Coverage" note (areas reviewed AND, honestly, what was NOT reviewed — e.g. no e2e of the real sandbox/git fetch, generated client untouched, frontend not run in a browser), and a short "Considered and dismissed" (from dismissed[]). Keep details tight.',
  '', 'Scope brief:', SCOPE_BRIEF,
  '', 'KEPT (JSON):', JSON.stringify(kept),
  '', 'DISMISSED (JSON):', JSON.stringify(dismissed),
  '', 'REVIEWED (JSON):', JSON.stringify(reviewed),
  '', 'Return ONLY the final markdown report.',
].join('\n'), { phase: 'Synthesize', label: 'synthesize', model, agentType: 'general-purpose' })
return report
