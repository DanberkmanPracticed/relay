import { expect, test } from 'claude-code/testing'

import { brief, budgetOf, familyOf, markStalled, progressOf, redact, shadesOf, STALL_MS, workflowTitle } from './register'

const PANE = {
  plugin: 'relay',
  component: 'Pane',
  requestId: 'relay',
  props: { title: 'Relay', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

test('helpers', async () => {
  expect(brief({ tool: 'Edit', file_path: 'C:\\a\\b\\register.tsx' })).toBe('Edit register.tsx')
  expect(brief({ tool: 'Bash', command: 'npm   test' })).toBe('Bash npm test')
  // Keys never reach the screen.
  expect(redact('curl -H "Authorization: Bearer abc123def" https://x.io')).not.toMatch(/abc123def/)
  expect(redact('https://api.x.io/v1?api_key=SECRET1&q=a')).toBe('https://api.x.io/v1?api_key=•••&q=a')
  expect(redact('gh auth login --token ghp_abcdefghijkl')).not.toMatch(/abcdefghijkl/)
  expect(redact('git clone https://dan:hunter2@github.com/x')).toBe('git clone https://dan:•••@github.com/x')
  expect(redact('npm test')).toBe('npm test')
  expect(brief({ tool: 'Bash', command: 'export OPENAI=sk-abcdefghijklmnop' })).not.toMatch(/abcdefghijklmnop/)
  expect(workflowTitle({ script: "export const meta = { name: 'review-changes', description: 'x' }" })).toBe('review-changes')
  expect(workflowTitle({ scriptPath: 'C:\\x\\scripts\\relay-screenshot-long-wf_c18520bb-83b.js' })).toBe('relay-screenshot-long')
  const run = { id: 'a', group: 'g', task: 't', type: 'x', model: 'm', status: 'running' as const, startedAt: 0, tokens: 300_000, now: '' }
  const pct = (tokens: number, budget: number) => Math.round(progressOf({ ...run, tokens }, budget).ratio * 100)
  expect(pct(300_000, 300_000)).toBe(60)
  expect(pct(900_000, 300_000)).toBe(90)
  expect(pct(9e9, 600_000)).toBe(95)
  expect(progressOf(run, 300_000).isEstimate).toBe(true)
  expect(progressOf({ ...run, stepDone: 1, stepTotal: 4 }, 600_000)).toEqual({ ratio: 0.25, isEstimate: false })
  expect(budgetOf([{ ...run, status: 'done', tokens: 400_000 }])).toBe(400_000)
  // One tiny finished lookup does not make every other bar jump to the cap.
  expect(budgetOf([{ ...run, status: 'done', tokens: 3_000 }])).toBe(100_000)
  // A stopped run keeps where it got to instead of a full bar.
  expect(pct(300_000, 300_000)).toBe(Math.round(progressOf({ ...run, status: 'failed' }, 300_000).ratio * 100))
  // Quiet for more than 10 minutes: stalled. Recently heard from, finished, or nothing to change: left alone.
  const quiet = { ...run, startedAt: 0, lastSeenAt: 0 }
  expect(markStalled([quiet], STALL_MS - 1)).toBe(null)
  expect(markStalled([quiet], STALL_MS + 1)?.[0]?.status).toBe('stalled')
  expect(markStalled([{ ...quiet, lastSeenAt: STALL_MS }], STALL_MS + 1)).toBe(null)
  expect(markStalled([{ ...quiet, status: 'done' }], STALL_MS * 3)).toBe(null)
  // Model picks the hue, effort how deep the bar starts.
  expect(familyOf('claude-sonnet-5-5')).toBe('sonnet')
  expect(familyOf('gpt-x')).toBe('other')
  expect(shadesOf({ model: 'claude-opus-5-5', effort: 'max' })[0]).toBe('#993c1d')
  expect(shadesOf({ model: 'claude-opus-5-5', effort: 'low' })[0]).toBe('#d85a30')
})

test('a workflow agent shows with its task, model, current step and percent', async ($, on) => {
  on('command.register', () => ({ value: { command: 'relay' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 1000 }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'ag1' }))
  on('turn.complete', () => ({ text: '' }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Workflow', tool_use_id: 'wf1', script: "export const meta = { name: 'review-changes' }" } as never)
  await $.agent.spawn({
    prompt: 'p',
    description: 'Review bugs',
    subagentType: 'general-purpose',
    tool_use_id: 'wf1',
    workflow: { runId: 'wf_1', agentIndex: 1 },
  } as never)
  await $.tool.call({ tool: 'Read', file_path: '/x/hooks.json', agentId: 'ag1' } as never)

  const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await term.find({ type: 'Text', text: /review-changes/ }))?.text).toMatch(/1 running/)
  expect((await term.find({ type: 'Text', text: /Sonnet 5\.5/ }))?.text).toMatch(/general-purpose/)
  expect((await term.find({ type: 'Text', text: /Now:/ }))?.text).toMatch(/Read hooks\.json/)
  await term.unmount()

  const desk = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await desk.find({ type: 'Text', text: /review-changes/ }))?.text).toMatch(/≈0%/)
  await desk.unmount()

  await $.turn.complete({ agentId: 'ag1', reason: 'answer', turnId: 't', answer: 'ok' } as never)
  const after = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await after.find({ type: 'Text', text: /review-changes/ }))?.text).toMatch(/finished.*100%/)
  await after.unmount()
})

test('an agent that finishes before its row exists still shows as finished', async ($, on) => {
  on('command.register', () => ({ value: { command: 'relay' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 1000 }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'fast' }))
  on('turn.complete', () => ({ text: '' }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.complete({ agentId: 'fast', reason: 'answer', turnId: 't', answer: 'ok' } as never)
  await $.agent.spawn({ prompt: 'p', description: 'Quick lookup', subagentType: 'Explore', tool_use_id: 'x' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Quick lookup/ }))?.text).toMatch(/✓/)
  expect((await ui.find({ type: 'Text', text: /running/ }))?.text).toMatch(/0 running/)
  await ui.unmount()
})

test('a remote workflow agent closes when its workflow\'s local agents end', async ($, on) => {
  on('command.register', () => ({ value: { command: 'relay' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 1000 }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))
  let n = 0
  // The first agent starts locally, the second remotely (no agentId).
  on('agent.spawn', () => (n++ === 0 ? { model: 'claude-opus-5-5', agentId: 'local1' } : { model: 'claude-opus-5-5' }))
  on('turn.complete', () => ({ text: '' }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const wf = { tool_use_id: 'wf9', subagentType: 'general-purpose', prompt: 'p' }
  await $.agent.spawn({ ...wf, description: 'Local part', workflow: { runId: 'wf_9', agentIndex: 1 } } as never)
  await $.agent.spawn({ ...wf, description: 'Remote part', workflow: { runId: 'wf_9', agentIndex: 2 } } as never)

  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /running remotely/ }))?.text).toBeTruthy()
  await ui.unmount()

  await $.turn.complete({ agentId: 'local1', reason: 'answer', turnId: 't', answer: 'ok' } as never)
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Remote part/ }))?.text).toMatch(/✓/)
  await ui.unmount()
})

test('a step count that is not a number is ignored', async ($, on) => {
  on('command.register', () => ({ value: { command: 'relay' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.now', () => ({ value: 1000 }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'ag3' }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn({ prompt: 'p', description: 'Steps', subagentType: 'general-purpose', tool_use_id: 'y' } as never)
  await $.tool.call({ tool: 'mcp__savvy-progress__step', agentId: 'ag3', total: 5, done: '3/5' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /step / }))?.text).toMatch(/step 0\/5/)
  expect(await ui.find({ type: 'Text', text: /NaN/ })).toBeFalsy()
  await ui.unmount()
})
