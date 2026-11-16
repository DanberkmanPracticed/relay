import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Groups, Run } from '../types'

// A shape name per atom: when Run changes, bump it and older stored values are dropped instead of misread.
const runs = atom({ plugin: 'relay', key: 'runs' } as const, [], { shape: 'runs-4' })
const groups = atom({ plugin: 'relay', key: 'groups' } as const, {}, { shape: 'groups-1' })

const PANE = 'relay'
const TITLE = 'Relay'
// shortcut: percent complete is tokens used over a guessed budget; upgrade if the engine ever reports a real plan size.
const DEFAULT_BUDGET = 600_000
const MIN_BUDGET = 100_000
// An estimate never reads 100% until the agent has actually finished.
const MAX_ESTIMATE = 0.95
// One hue per model family, deep / mid / light (the chat's purple, coral, blue and teal ramps).
export const FAMILY: Record<string, { label: string; ramp: [string, string, string] }> = {
  fable: { label: 'Fable', ramp: ['#534AB7', '#7F77DD', '#AFA9EC'] },
  opus: { label: 'Opus', ramp: ['#993C1D', '#D85A30', '#F0997B'] },
  sonnet: { label: 'Sonnet', ramp: ['#185FA5', '#378ADD', '#85B7EB'] },
  haiku: { label: 'Haiku', ramp: ['#0F6E56', '#1D9E75', '#5DCAA5'] },
  other: { label: 'Other', ramp: ['#5F5E5A', '#888780', '#B4B2A9'] },
}
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

export const familyOf = (model: string): string => {
  const m = /(fable|mythos|opus|sonnet|haiku)/i.exec(model)?.[1]?.toLowerCase()
  return m === 'mythos' ? 'fable' : m ?? 'other'
}

const mix = (a: string, b: string, t: number): string => {
  const ch = (h: string, i: number) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16)
  return '#' + [0, 1, 2].map(i => Math.round(ch(a, i) + (ch(b, i) - ch(a, i)) * t).toString(16).padStart(2, '0')).join('')
}

// The bar's gradient stops: the model picks the hue, effort how deep the bar starts (max = the deep stop).
export function shadesOf(r: Pick<Run, 'model' | 'effort'>): string[] {
  const [deep, mid, light] = (FAMILY[familyOf(r.model)] ?? FAMILY.other!).ramp
  const level = EFFORTS.indexOf(r.effort ?? '')
  return [mix(mid, deep, level < 0 ? 0.5 : level / (EFFORTS.length - 1)), mid, light]
}
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif"

// Which groups the pane already opened itself for in the current burst of agents; emptied when nothing runs.
const autoOpened = new Set<string>()

// A fast agent can step or even finish before agent.spawn's next() returns its id, so its row does not exist yet.
// Those events wait here and are applied when the row is added.
type Early = { tokens: number; model?: string; effort?: string; end?: Run['status'] }
const early = new Map<string, Early>()
const keepEarly = (id: string, change: (old: Early) => Early) => {
  early.set(id, change(early.get(id) ?? { tokens: 0 }))
  // Loops with no agent.spawn (forked skills) never claim theirs: keep only the latest few.
  if (early.size > 100) early.delete(early.keys().next().value as string)
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for the test).

export const fmtTokens = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${Math.round(n)}`

export const modelName = (id: string): string => {
  const m = /(fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2})(?!\d))?/i.exec(id)
  if (!m) return id.replace(/^claude-/, '').replace(/\[.*\]$/, '') || 'model'
  const [, family = '', major = '', minor] = m
  return `${family.charAt(0).toUpperCase()}${family.slice(1).toLowerCase()} ${major}${minor ? '.' + minor : ''}`
}

// By code point, so an emoji is never cut in half.
const clip = (s: string, n: number): string => {
  const cps = Array.from(s)
  return cps.length > n ? cps.slice(0, n - 1).join('') + '…' : s
}
const base = (p: string): string => p.split(/[\\/]/).pop() || p

// A tool call in a few words: "Edit register.tsx", "Bash npm test".
export function brief(e: Record<string, unknown>): string {
  const tool = String(e.tool ?? '').replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '')
  const s = (k: string) => (typeof e[k] === 'string' ? (e[k] as string) : '')
  const arg =
    s('description') ||
    (s('file_path') && base(s('file_path'))) ||
    (s('notebook_path') && base(s('notebook_path'))) ||
    s('pattern') ||
    s('command') ||
    s('query') ||
    s('url') ||
    s('skill')
  return clip(arg ? `${tool} ${redact(arg.replace(/\s+/g, ' '))}` : tool, 60)
}

// The Now line is on screen and in session state, so keys and passwords in a command or URL are masked.
export const redact = (s: string): string =>
  s
    .replace(/((?:authorization|x-api-key|api-key|cookie)\s*[:=]\s*(?:bearer\s+|basic\s+)?)[^\s'"]+/gi, '$1•••')
    .replace(/(\bbearer\s+)[^\s'"]+/gi, '$1•••')
    .replace(/([?&](?:access_token|token|api_key|apikey|key|password|secret|sig)=)[^&\s'"]+/gi, '$1•••')
    .replace(/(--?(?:token|password|api-key|apikey|secret|key)[ =])[^\s'"]+/gi, '$1•••')
    .replace(/\b(sk-|sk_live_|ghp_|gho_|ghs_|github_pat_|xox[abp]-|AKIA)[\w-]{6,}/g, '$1•••')
    .replace(/(:\/\/[^\s:/@]+:)[^\s@/]+@/g, '$1•••@')

// Tokens a run of this session usually takes: the mean of the finished ones, else the default.
// The floor keeps one tiny finished lookup from pushing every other bar to the cap.
export function budgetOf(list: readonly Run[]): number {
  const done = list.filter(r => r.status === 'done' && r.tokens > 0)
  return done.length ? Math.max(MIN_BUDGET, done.reduce((s, r) => s + r.tokens, 0) / done.length) : DEFAULT_BUDGET
}

// The fraction done and whether it is a guess: a finished run and reported steps are not.
// A stopped run keeps where it got to, never a full bar.
export function progressOf(r: Run, budget: number): { ratio: number; isEstimate: boolean } {
  if (r.status === 'done') return { ratio: 1, isEstimate: false }
  if (r.stepTotal) return { ratio: Math.min(1, (r.stepDone ?? 0) / r.stepTotal), isEstimate: false }
  // An easing curve, so a long run keeps moving instead of parking at the cap: one budget reads ≈60%, two ≈82%, three ≈90%.
  return { ratio: MAX_ESTIMATE * (1 - Math.exp(-r.tokens / Math.max(1, budget))), isEstimate: true }
}

const pctText = (p: { ratio: number; isEstimate: boolean }): string =>
  `${p.isEstimate ? '≈' : ''}${Math.round(p.ratio * 100)}%`

// The workflow's own name from its script's meta block, or the saved workflow's name.
export function workflowTitle(e: Record<string, unknown>): string {
  const script = typeof e.script === 'string' ? e.script : ''
  const m = /name\s*:\s*['"`]([^'"`]+)['"`]/.exec(script) ?? /description\s*:\s*['"`]([^'"`]+)['"`]/.exec(script)
  if (m?.[1]) return m[1]
  if (typeof e.name === 'string' && e.name) return e.name
  if (typeof e.scriptPath === 'string' && e.scriptPath) return base(e.scriptPath).replace(/\.[^.]+$/, '').replace(/-wf_[\w-]+$/, '') // saved scripts end in their run id
  return 'Workflow'
}

// ---------------------------------------------------------------------------
// Desktop drawing: every row is one SVG, so nothing wraps.

// Control characters (an ESC in a Bash command) are not allowed in XML and would blank the whole row.
const xml = (s: string): string =>
  s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)

const CSS = `.t{fill:#1f1f1f}.s{fill:#6b6b68}.k{fill:#ecebe8}
@media (prefers-color-scheme: dark){.t{fill:#ececec}.s{fill:#a8a8a4}.k{fill:#2c2c2b}}
.mv{animation:mv 1.6s linear infinite}@keyframes mv{to{transform:translateX(16px)}}
.hd{animation:hd 2.4s ease-in-out infinite}@keyframes hd{50%{opacity:.45}}
.live{animation:hd 2.4s ease-in-out infinite}
@media (prefers-reduced-motion: reduce){.mv,.hd,.live{animation:none}}`

// Gradient, pattern and clip ids from the run's own id, so a row keeps its ids however the list reorders.
const uidOf = (id: string): string => id.replace(/[^\w-]/g, '_')

// A redraw restarts CSS animations; a negative delay from the clock keeps them in phase across redraws.
const phase = (at: number, ms: number) => `animation-delay:-${((at % ms) / 1000).toFixed(3)}s`

export function barSvg(uid: string, W: number, ratio: number, status: Run['status'], at: number, shades: string[]): string {
  const H = 14
  const fw = Math.max(H, Math.round(W * ratio))
  // The gradient spans the filled part only, so every bar runs deep to light whatever its length.
  const stops = shades.map((c, i) => `<stop offset="${(i / (shades.length - 1)).toFixed(3)}" stop-color="${c}"/>`).join('')
  const isLive = status === 'running'
  const failed = status === 'failed'
  return `<g>
<defs>
<linearGradient id="g${uid}" gradientUnits="userSpaceOnUse" x1="0" x2="${fw}" y1="0" y2="0">${stops}</linearGradient>
<pattern id="p${uid}" width="16" height="${H}" patternUnits="userSpaceOnUse"><path d="M0 ${H}L8 0h6L6 ${H}z" fill="#fff" opacity=".12"/></pattern>
<clipPath id="c${uid}"><rect width="${fw}" height="${H}" rx="${H / 2}"/></clipPath>
</defs>
<rect class="k" width="${W}" height="${H}" rx="${H / 2}"/>
<g clip-path="url(#c${uid})">
<rect width="${W}" height="${H}" fill="${failed ? '#D0453F' : `url(#g${uid})`}"/>
${isLive ? `<g class="mv" style="${phase(at, 1600)}"><rect x="-16" width="${fw + 32}" height="${H}" fill="url(#p${uid})"/></g>` : ''}
</g>
${isLive ? `<circle class="hd" style="${phase(at, 2400)}" cx="${fw - H / 2}" cy="${H / 2}" r="${H / 2 - 3}" fill="#fff" opacity=".7"/>` : ''}
</g>`
}

// A stalled row goes gray: it may still be working, but nothing says so.
const rowShades = (r: Run): string[] => (r.status === 'stalled' ? FAMILY.other!.ramp : shadesOf(r))

const nowLine = (r: Run): string =>
  r.status === 'running'
    ? `Now: ${r.now || 'thinking'}`
    : r.status === 'stalled'
      ? `Stalled: nothing heard for ${Math.round(STALL_MS / 60_000)} min${r.now ? ' (last: ' + r.now + ')' : ''}`
      : r.status === 'done'
        ? 'Finished'
        : 'Stopped'

export function runSvg(uid: string, W: number, r: Run, budget: number, at: number): string {
  const p = progressOf(r, budget)
  const shades = rowShades(r)
  const color = shades[1] ?? '#888780'
  const dot =
    r.status === 'running'
      ? `<circle class="live" style="${phase(at, 2400)}" cx="6" cy="13" r="4" fill="${color}"/>`
      : r.status === 'stalled'
        ? `<circle cx="6" cy="13" r="4" fill="none" stroke="#888780" stroke-width="1.5"/>`
      : r.status === 'done'
        ? `<path d="M1 13l3.5 3.5 6.5-7" fill="none" stroke="#3B9C5F" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`
        : `<path d="M2 9l8 8M10 9l-8 8" stroke="#D0453F" stroke-width="2" stroke-linecap="round"/>`
  const chars = Math.max(10, Math.floor((W - 90) / 7))
  const now = nowLine(r)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="84" viewBox="0 0 ${W} 84"><style>${CSS}</style>
${dot}
<text class="t" x="18" y="17" font-family="${FONT}" font-size="13" font-weight="600">${xml(clip(r.task || r.type, chars))}</text>
<text x="${W}" y="17" text-anchor="end" font-family="${FONT}" font-size="15" font-weight="700" fill="${r.status === 'failed' ? '#D0453F' : color}">${pctText(p)}</text>
<text x="18" y="35" font-family="${FONT}" font-size="11"><tspan fill="${color}" font-weight="600">${xml(modelName(r.model) + (r.effort ? ' · ' + r.effort : ''))}</tspan><tspan class="s">${xml(clip(`  ·  ${r.type}${r.stepTotal ? `  ·  step ${r.stepDone ?? 0}/${r.stepTotal}` : ''}`, chars))}</tspan></text>
<text class="s" x="${W}" y="35" text-anchor="end" font-family="${FONT}" font-size="11" font-variant-numeric="tabular-nums">${fmtTokens(r.tokens)} tokens processed</text>
<text class="t" x="18" y="52" font-family="${FONT}" font-size="11.5" font-style="italic">${xml(clip(now, chars + 8))}</text>
<g transform="translate(0,62)">${barSvg(uid, W, p.ratio, r.status, at, shades)}</g>
</svg>`
}

// ---------------------------------------------------------------------------
// Terminal drawing: the same rows in text, the bar in blocks of the one hue.

// One color per cell; undefined is an empty cell.
export function barCells(ratio: number, width: number, failed: boolean, shades: string[]): (string | undefined)[] {
  const filled = Math.round(width * ratio)
  return Array.from({ length: width }, (_, i) =>
    i >= filled ? undefined : failed ? '#D0453F' : shades[Math.floor((i / Math.max(1, filled)) * shades.length)],
  )
}

// ---------------------------------------------------------------------------

async function maybeOpen($: EngineInterface, key: string, isWorkflow: boolean): Promise<void> {
  if (autoOpened.has(key)) return
  const running = (await read($, runs)).filter(r => r.status === 'running').length
  // A lone subagent is not a multi-agent run: open for a workflow, or once two agents run together.
  if (!isWorkflow && running < 2) return
  autoOpened.add(key)
  void $.ui.open({ id: PANE, title: TITLE }).catch(() => {})
}

// A row nothing has been heard from for this long is marked stalled; any later activity revives it.
// It catches what no event closes: a stalled workflow agent the engine retried under a new id, or a workflow run wholly remotely.
export const STALL_MS = 10 * 60_000
export const isLive = (r: Run): boolean => r.status === 'running' || r.status === 'stalled'

// The list with quiet running rows marked stalled, or null when none are, so an unchanged list is not written back.
export function markStalled(list: readonly Run[], at: number): Run[] | null {
  const quiet = (r: Run) => r.status === 'running' && at - (r.lastSeenAt ?? r.startedAt) > STALL_MS
  return list.some(quiet) ? list.map(r => (quiet(r) ? { ...r, status: 'stalled' as const } : r)) : null
}

// Exact Steps (a setting, off by default): Relay's own step tool, and one line added to each agent's brief asking it to report.
export const STEP_TOOL = 'mcp__relay__step'
export const STEP_BRIEF = `

Progress reporting: before other work, call \`${STEP_TOOL}\` with \`total\` (your plan in 3-8 steps) and \`done: 0\`; call it again with \`done\` and a few-word \`note\` as each step finishes. It only updates a progress bar.`

// A number an agent reported, or the fallback when it sent none or something that is not a number ("3/5").
const num = (v: unknown, fallback: number): number => {
  const n = Number(v)
  return v === undefined || !Number.isFinite(n) ? fallback : Math.max(0, Math.round(n))
}

// Registered at session start, or by the first spawn when the module loaded mid-session (a reload or a settings change), which never sees session.start.
let stepReady = false
async function registerStep($: { tool: { register(spec: any): Promise<unknown> } }) {
  if (stepReady) return
  stepReady = true
  try {
    await $.tool.register({
      name: 'step',
      description:
        "Report progress on your own task to the Relay pane. Right after reading your brief, call it with `total` (your plan in 3-8 steps) and `done: 0`; call it again as each step finishes. Cheap and silent: it only draws a bar.",
      inputSchema: {
        type: 'object',
        properties: {
          done: { type: 'integer', minimum: 0, description: 'Steps finished so far.' },
          total: { type: 'integer', minimum: 1, description: 'Steps planned; may change if the plan changes.' },
          note: { type: 'string', description: 'The step in progress, a few words.' },
        },
        required: ['done'],
      },
      // In every agent's tool list, not behind a search: agents do not go looking for it.
      isDeferred: false,
    })
  } catch {
    // Already registered by an earlier load: nothing to do.
  }
}

export const register: Register = (on, options) => {
  const exactSteps = options.exactSteps === true

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'relay', description: 'Show the live pane of running agents and subagents' })
    if (exactSteps) await registerStep($)
    // Once a minute, mark quiet rows stalled. Quiet when nothing runs: no write, no redraw.
    $.clock.every(60_000, () => {
      void (async () => {
        const list = await read($, runs)
        if (!list.some(r => r.status === 'running')) return
        const marked = markStalled(list, await $.clock.now())
        if (marked) await update($, runs, () => marked)
      })().catch(() => {})
    })
    return started
  })

  on('command.run', { command: 'relay' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: 'Relay pane opened.' }
  })

  // A Workflow call's title, kept under its tool call id, which its agents carry as tool_use_id.
  on('tool.call', { tool: 'Workflow' }, async ($, e, next) => {
    // The pane is a bystander: nothing here may stop the tool call.
    try {
      const title = workflowTitle(e as unknown as Record<string, unknown>)
      await update($, groups, g => ({ ...g, [e.tool_use_id]: title }))
    } catch {}
    return next(e)
  }).catch(($, e, next) => next(e)) // a bystander: on any failure the call goes ahead untouched

  // An agent's own step report (Exact Steps). The call is Relay's own tool, so Relay answers it.
  on('tool.call', { tool: STEP_TOOL }, async ($, e) => {
    const id = e.agentId
    if (!id) return { result: 'ignored: only agents report steps' }
    const input = e as unknown as Record<string, unknown>
    try {
      const at = await $.clock.now()
      await update($, runs, list =>
        list.map(r => {
          if (r.agentId !== id) return r
          const total = num(input.total, r.stepTotal ?? 0)
          const done = num(input.done, r.stepDone ?? 0)
          const note = typeof input.note === 'string' && input.note ? clip(redact(input.note), 60) : r.now
          return { ...r, stepTotal: total || undefined, stepDone: total ? Math.min(total, done) : done, now: note, lastSeenAt: at, status: r.status === 'stalled' ? ('running' as const) : r.status }
        }),
      )
    } catch {}
    return { result: 'ok' }
  })

  // Every tool call inside an agent's loop is what that agent is doing now.
  on('tool.call', async ($, e, next) => {
    const id = e.agentId
    if (id && e.tool !== STEP_TOOL) try {
      const now = brief(e as unknown as Record<string, unknown>)
      // Not awaited: the tool call goes ahead without waiting for the pane.
      void (async () => {
        const at = await $.clock.now()
        await update($, runs, list =>
          list.map(r =>
            // Heard from: a stalled row is running again.
            r.agentId !== id ? r : { ...r, now, lastSeenAt: at, status: r.status === 'stalled' ? ('running' as const) : r.status },
          ),
        )
      })().catch(() => {})
    } catch {}
    return next(e)
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    // Exact Steps: one line at the end of a new agent's brief. A resumed run keeps its prompt; a brief that already asks is left alone.
    const ask = exactSteps && !e.resume && !e.prompt.includes(STEP_TOOL)
    if (ask) await registerStep($)
    const started = await next(ask ? { ...e, prompt: e.prompt + STEP_BRIEF } : e)
    if (started.deny !== undefined) return started
    // After next() the spawn has happened: a failure here must not fail it.
    try {
      const isWorkflow = !!e.workflow
      const group = isWorkflow ? e.tool_use_id || e.workflow?.runId || 'workflow' : e.parentAgentId ? `sub:${e.parentAgentId}` : 'main'
      const at = await $.clock.now()
      const seen = started.agentId ? early.get(started.agentId) : undefined
      if (started.agentId) early.delete(started.agentId)
      const run: Run = {
        id: started.agentId ?? `${e.tool_use_id}:${e.workflow?.agentIndex ?? at}`,
        agentId: started.agentId,
        group,
        task: e.description || e.subagentType,
        type: e.subagentType || 'agent',
        model: seen?.model || started.model,
        effort: seen?.effort,
        status: seen?.end ?? 'running',
        startedAt: at,
        lastSeenAt: at,
        endedAt: seen?.end ? at : undefined,
        tokens: seen?.tokens ?? 0,
        // A workflow's remote agent has no local loop: no steps or tool calls ever reach the pane for it.
        now: seen?.end ? '' : started.agentId ? 'starting' : 'running remotely, no live detail',
      }
      await update($, runs, list => [...list.filter(r => r.id !== run.id), run].slice(-200))
      if (!isWorkflow && e.parentAgentId) {
        const parent = (await read($, runs)).find(r => r.agentId === e.parentAgentId)
        await update($, groups, g => ({ ...g, [group]: `Spawned by ${parent?.task ?? 'a subagent'}` }))
      }
      await maybeOpen($, group, isWorkflow)
    } catch {}
    return started
  }).catch(($, e, next) => next(e)) // never refuse a spawn: a failure lets it start as asked

  // Each model request of an agent: its tokens and the model that answered.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const id = e.agentId
    const u = result.usage
    if (!id || !u) return result
    const used = (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)
    const model = u.model || e.model
    const effort = typeof e.effort === 'string' ? e.effort : undefined
    try {
      const at = await $.clock.now()
      let matched = false
      await update($, runs, list =>
        list.map(r => {
          if (r.agentId !== id) return r
          matched = true
          const status = r.status === 'stalled' ? ('running' as const) : r.status
          return { ...r, status, lastSeenAt: at, model: model || r.model, effort: effort ?? r.effort, tokens: r.tokens + used }
        }),
      )
      if (!matched) keepEarly(id, old => ({ ...old, model: model || old.model, effort: effort ?? old.effort, tokens: old.tokens + used }))
    } catch {}
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const id = e.agentId
    if (id) try {
      const at = await $.clock.now()
      const end: Run['status'] = e.reason === 'answer' ? 'done' : 'failed'
      const u = e.usage
      // The turn's own total, for a run whose steps were never seen.
      const turnTokens = u ? (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) : 0
      let matched = false
      let finished: Run | undefined
      const after = await update($, runs, list => {
        const ended = list.map(r => {
          if (r.agentId !== id) return r
          matched = true
          if (!isLive(r)) return r
          finished = { ...r, status: end, endedAt: at, lastSeenAt: at, now: '', tokens: r.tokens || turnTokens }
          return finished
        })
        // Remote agents never report an end: close them once every local agent of their workflow has ended.
        const g = finished?.group
        const localLeft = ended.some(r => r.group === g && r.agentId && isLive(r))
        return g && !localLeft ? ended.map(r => (r.group === g && !r.agentId && isLive(r) ? { ...r, status: 'done' as const, endedAt: at, now: '' } : r)) : ended
      })
      if (!matched) keepEarly(id, old => ({ ...old, end, tokens: old.tokens || turnTokens }))
      if (finished?.status === 'done') void Promise.resolve($.ui.toast(`Done: ${clip(finished.task, 50)}`)).catch(() => {})
      // Once nothing runs, the next burst of agents may open the pane again, even if it was closed.
      if (!(after ?? []).some(isLive)) autoOpened.clear()
    } catch {}
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const list = await read($, runs)
    const titles: Groups = await read($, groups)
    const at = await $.clock.now()
    const budget = budgetOf(list)
    const clear = async () => {
      const left = await update($, runs, l => l.filter(isLive))
      // Titles go with their last row.
      const live = new Set((left ?? []).map(r => r.group))
      await update($, groups, g => Object.fromEntries(Object.entries(g ?? {}).filter(([k]) => live.has(k))))
    }

    if (list.length === 0) {
      return (
        <Box paddingX={1} paddingY={1}>
          <Text dimColor>No agents running. The pane fills in when a workflow or several subagents start.</Text>
        </Box>
      )
    }

    // Groups, newest first; inside each, running agents first.
    const keys = [...new Set([...list].reverse().map(r => r.group))]
    const running = list.filter(r => r.status === 'running').length
    const stalled = list.filter(r => r.status === 'stalled').length
    const total = list.reduce((s, r) => s + r.tokens, 0)
    const summary = `${running} running${stalled ? ` · ${stalled} stalled` : ''} · ${list.length - running - stalled} finished · ${fmtTokens(total)} tokens processed`
    // The color key: only the model families in the pane, then how effort shows.
    const families = Object.keys(FAMILY).filter(f => list.some(r => familyOf(r.model) === f))
    const legend = (
      <Box flexDirection="row" columnGap={2} flexWrap="wrap">
        {families.map(f => (
          <Text key={'k-' + f} color={FAMILY[f]?.ramp[1]}>{'● ' + (FAMILY[f]?.label ?? f)}</Text>
        ))}
        <Text dimColor>Deeper color = higher effort</Text>
      </Box>
    )
    const groupTitle = (k: string) => titles[k] ?? (k === 'main' ? 'Subagents' : 'Workflow')
    const groupLine = (k: string, members: Run[]) => {
      const mean = members.reduce((s, r) => s + progressOf(r, budget).ratio, 0) / members.length
      const isEstimate = members.some(r => progressOf(r, budget).isEstimate)
      const live = members.filter(r => r.status === 'running').length
      const quiet = members.filter(r => r.status === 'stalled').length
      const state = [live ? `${live} running` : '', quiet ? `${quiet} stalled` : ''].filter(Boolean).join(', ') || 'finished'
      return `${groupTitle(k)}  ·  ${state}  ·  ${fmtTokens(members.reduce((s, r) => s + r.tokens, 0))} tokens processed  ·  ${pctText({ ratio: mean, isEstimate })}`
    }
    const membersOf = (k: string) =>
      list.filter(r => r.group === k).sort((a, b) => Number(isLive(b)) - Number(isLive(a)) || a.startedAt - b.startedAt)

    // The terminal's element table carries an Svg that draws nothing: test the surface too.
    if (e.surface !== 'terminal' && 'Svg' in ui) {
      const { Svg } = ui
      const W = Math.max(260, Math.min(900, (e.props.bodyColumns || 40) * 8 - 16))
      return (
        <Box flexDirection="column" paddingX={1} rowGap={1}>
          <Box flexDirection="row" columnGap={1} alignItems="center">
            <Text bold>{summary}</Text>
            <Box flexGrow={1} />
            {list.length > running + stalled ? <Button key="clear" variant="secondary" onPress={clear}>Clear Finished</Button> : null}
          </Box>
          {legend}
          {keys.map(k => {
            const members = membersOf(k)
            return (
              <Box key={'g-' + k} flexDirection="column" rowGap={1}>
                <Text bold color="#A096EB">{groupLine(k, members)}</Text>
                {members.map(r => (
                  <Svg
                    key={r.id}
                    source={runSvg(uidOf(r.id), W, r, budget, at)}
                    alt={`${r.task}: ${modelName(r.model)}, ${fmtTokens(r.tokens)} tokens processed, ${pctText(progressOf(r, budget))}, ${nowLine(r)}`}
                    width={W}
                    height={84}
                  />
                ))}
              </Box>
            )
          })}
        </Box>
      )
    }

    const cols = Math.max(30, e.props.bodyColumns || 40)
    const barW = Math.max(8, Math.min(30, cols - 12))
    return (
      <Box flexDirection="column">
        <Text bold>{summary}</Text>
        {legend}
        {list.length > running + stalled ? <Button key="clear" label="Clear Finished" plain onPress={clear} /> : null}
        {keys.map(k => (
          <Box key={'g-' + k} flexDirection="column" marginTop={1}>
            <Text bold color="#A096EB" wrap="truncate-end">{groupLine(k, membersOf(k))}</Text>
            {membersOf(k).map(r => {
              const p = progressOf(r, budget)
              return (
                <Box key={r.id} flexDirection="column" marginTop={1}>
                  <Text bold wrap="truncate-end">
                    {r.status === 'running' ? '● ' : r.status === 'stalled' ? '○ ' : r.status === 'done' ? '✓ ' : '✗ '}
                    {r.task || r.type}
                  </Text>
                  <Text dimColor wrap="truncate-end">
                    {'  '}
                    <Text color={rowShades(r)[1]}>{modelName(r.model) + (r.effort ? ' · ' + r.effort : '')}</Text>
                    {` · ${r.type} · ${fmtTokens(r.tokens)} tokens processed`}
                    {r.stepTotal ? ` · step ${r.stepDone ?? 0}/${r.stepTotal}` : ''}                  </Text>
                  {isLive(r) ? <Text wrap="truncate-end">{'  ' + nowLine(r)}</Text> : null}
                  <Text>
                    {'  '}
                    {barCells(p.ratio, barW, r.status === 'failed', rowShades(r)).map((c, i) =>
                      c ? <Text key={'c' + i} color={c}>█</Text> : <Text key={'c' + i} dimColor>░</Text>,
                    )}
                    {' ' + pctText(p)}
                  </Text>
                </Box>
              )
            })}
          </Box>
        ))}
      </Box>
    )
  })
}
