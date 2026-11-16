import { expect, test } from 'claude-code/testing'

import { brief, budgetOf, familyOf, progressOf, shadesOf, workflowTitle } from './register'

const PANE = {
  plugin: 'relay',
  component: 'Pane',
  requestId: 'relay',
  props: { title: 'Relay', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

test('helpers', async () => {
  expect(brief({ tool: 'Edit', file_path: 'C:\\a\\b\\register.tsx' })).toBe('Edit register.tsx')
  expect(brief({ tool: 'Bash', command: 'npm   test' })).toBe('Bash npm test')
  expect(workflowTitle({ script: "export const meta = { name: 'review-changes', description: 'x' }" })).toBe('review-changes')
  const run = { id: 'a', group: 'g', task: 't', type: 'x', model: 'm', status: 'running' as const, startedAt: 0, tokens: 300_000, now: '' }
  const pct = (tokens: number, budget: number) => Math.round(progressOf({ ...run, tokens }, budget).ratio * 100)
  expect(pct(300_000, 300_000)).toBe(60)
  expect(pct(900_000, 300_000)).toBe(90)
  expect(pct(9e9, 600_000)).toBe(95)
  expect(progressOf(run, 300_000).isEstimate).toBe(true)
  expect(progressOf({ ...run, stepDone: 1, stepTotal: 4 }, 600_000)).toEqual({ ratio: 0.25, isEstimate: false })
  expect(budgetOf([{ ...run, status: 'done', tokens: 100_000 }])).toBe(100_000)
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
