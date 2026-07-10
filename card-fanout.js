// card-fanout.js — durable runtime of the card fan-out pipeline (Claude Code Workflow script).
//
// Front-end: fan-out.py parses a work card (guards, deps, Action items, acceptance from
// Done-when) and emits the args this script consumes. Workflow scripts have no filesystem
// access, so that split is structural, not stylistic.
//
// Spine adapted from the plan-fanout-verify pattern (planner splits a request, cheap pinned
// workers execute in parallel, the session model judges each result). Two upgrades:
//   - card lane: when args carry items, the PLAN PHASE IS SKIPPED — the card is the plan
//     (cheaper, and the run converges to the card's rubric instead of a re-plan).
//   - modes: recon (read-only workers, evidence gathering + live-probe plans) vs
//     execute (work + acceptance verdict per item, streamed via pipeline()).
// The bare-request lane (args: {request}) keeps the original plan->execute->verify shape.
//
// Run the SESSION on your strongest model: the planning/verifying agents inherit it, while
// workers are pinned cheap (default 'sonnet', override with args.worker_model).
//
// Launch (Claude Code):
//   Workflow({scriptPath: '<path-to>/card-fanout.js', args: <fan-out.py output>})
//   Workflow({scriptPath: ..., args: {request: 'what to do', mode: 'execute'}})
//
// MIT. https://github.com/m2ai-portfolio/card-fanout

export const meta = {
  name: 'card-fanout',
  description: 'Fan out a work card (items from fan-out.py) or a bare request (planned by the session model): read-only recon, or cheap-worker execution with acceptance verdicts.',
  phases: [
    { title: 'Plan',    detail: 'bare-request lane only: session model splits the request into items' },
    { title: 'Recon',   detail: 'recon mode: one read-only agent per item' },
    { title: 'Execute', detail: 'execute mode: pinned cheap workers do each item in parallel' },
    { title: 'Verify',  detail: 'execute mode: session model judges each result vs its acceptance check' },
  ],
}

// args may arrive as a JSON-encoded string — parse defensively.
let input = args
if (typeof input === 'string') {
  try { input = JSON.parse(input) } catch (e) { input = null }
}
if (!input || typeof input !== 'object') {
  throw new Error('No usable args. Pass fan-out.py output or {request}. Got: ' + JSON.stringify(args).slice(0, 200))
}

const MODE = input.mode === 'execute' ? 'execute' : 'recon'
const CARD = input.card_id || '(ad-hoc request)'
const CARD_PATH = input.card_path || ''
const DONE_WHEN = input.done_when || ''
const WORKER_MODEL = input.worker_model || 'sonnet'
let items = Array.isArray(input.items) ? input.items.filter(i => i && i.detail) : []

// Bare-request lane: no items -> the session model plans.
if (!items.length) {
  const REQUEST = input.request || ''
  if (!REQUEST || REQUEST.includes('<what to build or do>')) {
    throw new Error('Need items (from fan-out.py) or a real {request}.')
  }
  phase('Plan')
  const PLAN_SCHEMA = {
    type: 'object', required: ['items'],
    properties: {
      items: {
        type: 'array', minItems: 1, maxItems: 7,
        items: {
          type: 'object', required: ['title', 'detail', 'acceptance'],
          properties: {
            title: { type: 'string' },
            detail: { type: 'string' },
            acceptance: { type: 'string', description: 'A verifiable check that proves this item is done.' },
          },
        },
      },
    },
  }
  const plan = await agent(
    'Decompose this request into 3 to 7 INDEPENDENT work items that can run in parallel. ' +
    'Each item needs a verifiable acceptance check. Return JSON.\n\nRequest:\n' + REQUEST,
    { label: 'plan', schema: PLAN_SCHEMA },
  )
  items = plan.items.map((it, i) => ({ n: i + 1, ...it }))
  log('planned ' + items.length + ' work items from bare request')
} else {
  log(CARD + ': ' + items.length + ' items from the card (plan phase skipped — the card is the plan)')
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30)

if (MODE === 'recon') {
  const RECON_SCHEMA = {
    type: 'object',
    required: ['item', 'surface_status', 'findings', 'live_probe_plan', 'completed_readonly', 'pass', 'requires_human'],
    properties: {
      item: { type: 'integer' },
      surface_status: { type: 'string', enum: ['ready', 'degraded', 'blocked'] },
      findings: { type: 'string', description: 'Observed evidence: paths, timestamps, states. Quote it.' },
      live_probe_plan: { type: 'string', description: 'Exact steps for the main session to run the live/mutating part, or "n/a".' },
      completed_readonly: { type: 'boolean' },
      pass: { type: ['boolean', 'null'] },
      requires_human: { type: 'boolean' },
    },
  }
  const COMMON =
    'You are doing READ-ONLY recon for card ' + CARD + (CARD_PATH ? ' (' + CARD_PATH + ')' : '') + '. ' +
    'ABSOLUTE RULES: mutate nothing — no messages, no missions, no cards, no file writes, no restarts. ' +
    'Reading files, listing processes, read-only HTTP GETs, and read-only SSH inspection are allowed. ' +
    'Prefer dedicated file tools (Glob/Grep/Read) over shell equivalents. Never print secret values. ' +
    'Report concrete evidence (timestamps, paths, exit states), not assumptions. ' +
    'If the item is fully verifiable read-only, verify it and set completed_readonly=true with a real pass/fail.'
  phase('Recon')
  const results = await parallel(items.map(p => () =>
    agent(
      COMMON + '\n\nItem ' + p.n + ' of ' + CARD + ': ' + p.detail +
      (DONE_WHEN ? '\nCard done-when: ' + DONE_WHEN : '') +
      '\n\nReturn structured output. item=' + p.n + '.',
      { label: 'recon:' + p.n + '-' + slug(p.title), phase: 'Recon', model: WORKER_MODEL, schema: RECON_SCHEMA },
    )
  ))
  const done = results.filter(Boolean)
  log(done.length + '/' + items.length + ' recon agents returned; ' +
      done.filter(r => r.completed_readonly && r.pass).length + ' verified pass read-only')
  return { card: CARD, mode: MODE, recon: results }
}

// execute mode: cheap workers execute, session model verifies, streamed per item (no barrier).
const WORK_SCHEMA = {
  type: 'object', required: ['artifact'],
  properties: { artifact: { type: 'string' }, notes: { type: 'string' } },
}
const VERDICT_SCHEMA = {
  type: 'object', required: ['pass', 'reason'],
  properties: { pass: { type: 'boolean' }, reason: { type: 'string' }, fix: { type: 'string' } },
}
const results = await pipeline(
  items,
  (item) => agent(
    'Complete this work item fully and return the finished artifact.\n\n' +
    'Card: ' + CARD + '\nTitle: ' + item.title + '\nDetail: ' + item.detail,
    { label: 'work:' + item.n + '-' + slug(item.title), phase: 'Execute', model: WORKER_MODEL, schema: WORK_SCHEMA },
  ),
  (work, item) => agent(
    'Acceptance check: ' + item.acceptance +
    (DONE_WHEN ? '\nCard done-when: ' + DONE_WHEN : '') +
    '\n\nResult to judge:\n' + work.artifact +
    '\n\nReturn { pass, reason, fix? }. Pass ONLY if the acceptance check is genuinely met.',
    { label: 'verify:' + item.n + '-' + slug(item.title), phase: 'Verify', schema: VERDICT_SCHEMA },
  ).then((verdict) => ({ item: { n: item.n, title: item.title }, work, verdict })),
)

const ok = results.filter(Boolean).filter(r => r.verdict.pass)
const fail = results.filter(Boolean).filter(r => !r.verdict.pass)
log(ok.length + '/' + results.filter(Boolean).length + ' items passed the acceptance verdict')
return {
  card: CARD,
  mode: MODE,
  passed: ok.map(r => r.item.title),
  failed: fail.map(r => ({ title: r.item.title, reason: r.verdict.reason, fix: r.verdict.fix })),
  artifacts: ok.map(r => ({ title: r.item.title, artifact: r.work.artifact })),
}
