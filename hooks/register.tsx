import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Groups, Run } from '../types'

const runs = atom({ plugin: 'relay', key: 'runs' } as const, [])
const groups = atom({ plugin: 'relay', key: 'groups' } as const, {})

const PANE = 'relay'
const TITLE = 'Relay'
const STEP_TOOL = 'mcp__savvy-progress__step'
// shortcut: percent complete is tokens used over a guessed budget; upgrade if the engine ever reports a real plan size.
const DEFAULT_BUDGET = 600_000
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

// Which groups the pane already opened itself for; starting over on a reload only reopens it once more.
const autoOpened = new Set<string>()

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

const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + '…' : s)
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
  return clip(arg ? `${tool} ${arg.replace(/\s+/g, ' ')}` : tool, 60)
}

// Tokens a run of this session usually takes: the mean of the finished ones, else the default.
export function budgetOf(list: readonly Run[]): number {
  const done = list.filter(r => r.status === 'done' && r.tokens > 0)
  return done.length ? done.reduce((s, r) => s + r.tokens, 0) / done.length : DEFAULT_BUDGET
}

// The fraction done and whether it is a guess: steps the agent reported are not.
export function progressOf(r: Run, budget: number): { ratio: number; isEstimate: boolean } {
  if (r.status !== 'running') return { ratio: 1, isEstimate: false }
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
  if (typeof e.scriptPath === 'string' && e.scriptPath) return base(e.scriptPath).replace(/\.[^.]+$/, '')
  return 'Workflow'
}

// ---------------------------------------------------------------------------
// Desktop drawing: every row is one SVG, so nothing wraps.

const xml = (s: string): string =>
  s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)

const CSS = `.t{fill:#1f1f1f}.s{fill:#6b6b68}.k{fill:#ecebe8}
@media (prefers-color-scheme: dark){.t{fill:#ececec}.s{fill:#a8a8a4}.k{fill:#2c2c2b}}
.mv{animation:mv 1.6s linear infinite}@keyframes mv{to{transform:translateX(16px)}}
.hd{animation:hd 2.4s ease-in-out infinite}@keyframes hd{50%{opacity:.45}}
.live{animation:hd 2.4s ease-in-out infinite}
@media (prefers-reduced-motion: reduce){.mv,.hd,.live{animation:none}}`

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

export function runSvg(uid: string, W: number, r: Run, budget: number, at: number): string {
  const p = progressOf(r, budget)
  const shades = shadesOf(r)
  const color = shades[1] ?? '#888780'
  const dot =
    r.status === 'running'
      ? `<circle class="live" style="${phase(at, 2400)}" cx="6" cy="13" r="4" fill="${color}"/>`
      : r.status === 'done'
        ? `<path d="M1 13l3.5 3.5 6.5-7" fill="none" stroke="#3B9C5F" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`
        : `<path d="M2 9l8 8M10 9l-8 8" stroke="#D0453F" stroke-width="2" stroke-linecap="round"/>`
  const chars = Math.max(10, Math.floor((W - 90) / 7))
  const steps = r.stepTotal ? `  ·  step ${r.stepDone ?? 0}/${r.stepTotal}` : ''
  const now = r.status === 'running' ? `Now: ${r.now || 'thinking'}` : r.status === 'done' ? 'Finished' : 'Stopped'
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="84" viewBox="0 0 ${W} 84"><style>${CSS}</style>
${dot}
<text class="t" x="18" y="17" font-family="${FONT}" font-size="13" font-weight="600">${xml(clip(r.task || r.type, chars))}</text>
<text x="${W}" y="17" text-anchor="end" font-family="${FONT}" font-size="15" font-weight="700" fill="${r.status === 'failed' ? '#D0453F' : color}">${pctText(p)}</text>
<text x="18" y="35" font-family="${FONT}" font-size="11"><tspan fill="${color}" font-weight="600">${xml(modelName(r.model) + (r.effort ? ' · ' + r.effort : ''))}</tspan><tspan class="s">${xml(clip(`  ·  ${r.type}${steps}`, chars))}</tspan></text>
<text class="s" x="${W}" y="35" text-anchor="end" font-family="${FONT}" font-size="11" font-variant-numeric="tabular-nums">${fmtTokens(r.tokens)} tokens</text>
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
  void $.ui.open({ id: PANE, title: TITLE })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'relay', description: 'Show the live pane of running agents and subagents' })
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
  })

  // Every tool call inside an agent's loop is what that agent is doing now.
  on('tool.call', async ($, e, next) => {
    const id = e.agentId
    if (id) try {
      const input = e as unknown as Record<string, unknown>
      const isStep = e.tool === STEP_TOOL
      await update($, runs, list =>
        list.map(r => {
          if (r.agentId !== id) return r
          if (!isStep) return { ...r, now: brief(input) }
          const total = Number(input.total ?? r.stepTotal ?? 0)
          const done = Number(input.done ?? r.stepDone ?? 0)
          return { ...r, stepTotal: total || undefined, stepDone: total ? Math.min(total, done) : done, now: typeof input.note === 'string' && input.note ? clip(input.note, 60) : r.now }
        }),
      )
    } catch {}
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.deny !== undefined) return started
    const isWorkflow = !!e.workflow
    const group = isWorkflow ? e.tool_use_id || e.workflow?.runId || 'workflow' : e.parentAgentId ? `sub:${e.parentAgentId}` : 'main'
    const at = await $.clock.now()
    const run: Run = {
      id: started.agentId ?? `${e.tool_use_id}:${e.workflow?.agentIndex ?? at}`,
      agentId: started.agentId,
      group,
      task: e.description || e.subagentType,
      type: e.subagentType || 'agent',
      model: started.model,
      status: 'running',
      startedAt: at,
      tokens: 0,
      now: 'starting',
    }
    await update($, runs, list => [...list.filter(r => r.id !== run.id), run].slice(-200))
    if (!isWorkflow && e.parentAgentId) {
      const parent = (await read($, runs)).find(r => r.agentId === e.parentAgentId)
      await update($, groups, g => ({ ...g, [group]: `Spawned by ${parent?.task ?? 'a subagent'}` }))
    }
    await maybeOpen($, group, isWorkflow)
    return started
  })

  // Each model request of an agent: its tokens and the model that answered.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const id = e.agentId
    const u = result.usage
    if (!id || !u) return result
    const used = (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)
    await update($, runs, list => list.map(r => (r.agentId === id ? { ...r, model: u.model || e.model || r.model, effort: typeof e.effort === 'string' ? e.effort : r.effort, tokens: r.tokens + used } : r)))
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const id = e.agentId
    if (id) {
      const at = await $.clock.now()
      let finished: Run | undefined
      await update($, runs, list =>
        list.map(r => {
          if (r.agentId !== id || r.status !== 'running') return r
          finished = { ...r, status: e.reason === 'answer' ? 'done' : 'failed', endedAt: at, now: '' }
          return finished
        }),
      )
      if (finished?.status === 'done') $.ui.toast(`Done: ${clip(finished.task, 50)}`)
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const list = await read($, runs)
    const titles: Groups = await read($, groups)
    const at = await $.clock.now()
    const budget = budgetOf(list)
    const clear = () => update($, runs, l => l.filter(r => r.status === 'running'))

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
    const total = list.reduce((s, r) => s + r.tokens, 0)
    const summary = `${running} running · ${list.length - running} finished · ${fmtTokens(total)} tokens`
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
      return `${groupTitle(k)}  ·  ${live ? `${live} running` : 'finished'}  ·  ${fmtTokens(members.reduce((s, r) => s + r.tokens, 0))} tokens  ·  ${pctText({ ratio: mean, isEstimate })}`
    }
    const membersOf = (k: string) =>
      list.filter(r => r.group === k).sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running') || a.startedAt - b.startedAt)

    // The terminal's element table carries an Svg that draws nothing: test the surface too.
    if (e.surface !== 'terminal' && 'Svg' in ui) {
      const { Svg } = ui
      const W = Math.max(260, Math.min(900, (e.props.bodyColumns || 40) * 8 - 16))
      return (
        <Box flexDirection="column" paddingX={1} rowGap={1}>
          <Box flexDirection="row" columnGap={1} alignItems="center">
            <Text bold>{summary}</Text>
            <Box flexGrow={1} />
            {list.length > running ? <Button key="clear" variant="secondary" onPress={clear}>Clear Finished</Button> : null}
          </Box>
          {legend}
          {keys.map(k => {
            const members = membersOf(k)
            return (
              <Box key={'g-' + k} flexDirection="column" rowGap={1}>
                <Text bold color="#A096EB">{groupLine(k, members)}</Text>
                {members.map((r, i) => (
                  <Svg
                    key={r.id}
                    source={runSvg(`${keys.indexOf(k)}-${i}`, W, r, budget, at)}
                    alt={`${r.task}: ${modelName(r.model)}, ${fmtTokens(r.tokens)} tokens, ${pctText(progressOf(r, budget))}, ${r.status === 'running' ? 'now ' + r.now : r.status}`}
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
        {list.length > running ? <Button key="clear" label="Clear Finished" plain onPress={clear} /> : null}
        {keys.map(k => (
          <Box key={'g-' + k} flexDirection="column" marginTop={1}>
            <Text bold color="#A096EB" wrap="truncate-end">{groupLine(k, membersOf(k))}</Text>
            {membersOf(k).map(r => {
              const p = progressOf(r, budget)
              return (
                <Box key={r.id} flexDirection="column" marginTop={1}>
                  <Text bold wrap="truncate-end">
                    {r.status === 'running' ? '● ' : r.status === 'done' ? '✓ ' : '✗ '}
                    {r.task || r.type}
                  </Text>
                  <Text dimColor wrap="truncate-end">
                    {'  '}
<Text color={shadesOf(r)[1]}>{modelName(r.model) + (r.effort ? ' · ' + r.effort : '')}</Text> · {r.type} · {fmtTokens(r.tokens)} tokens
                    {r.stepTotal ? ` · step ${r.stepDone ?? 0}/${r.stepTotal}` : ''}
                  </Text>
                  {r.status === 'running' ? <Text wrap="truncate-end">{'  Now: ' + (r.now || 'thinking')}</Text> : null}
                  <Text>
                    {'  '}
                    {barCells(p.ratio, barW, r.status === 'failed', shadesOf(r)).map((c, i) =>
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
