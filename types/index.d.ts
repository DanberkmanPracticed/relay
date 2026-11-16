export type RunStatus = 'running' | 'done' | 'failed'

export type Run = {
  id: string
  agentId?: string
  /** The Workflow tool call that started it, or who spawned it ('main' or 'sub:<agentId>'). */
  group: string
  /** The task this agent was given (the Agent call's or the workflow agent's description). */
  task: string
  type: string
  model: string
  /** The effort level the agent's requests ask for, once its first request is seen. */
  effort?: string
  status: RunStatus
  startedAt: number
  endedAt?: number
  /** Every token of every request: input, output, cache reads and writes. */
  tokens: number
  /** What the agent is doing now: its latest tool call, in a few words. */
  now: string
  /** Self-reported steps, when the agent reports them through savvy-progress's step tool. */
  stepDone?: number
  stepTotal?: number
}

/** A group's title, by its key. */
export type Groups = Record<string, string>

declare module 'claude-code' {
  interface PluginState {
    'relay': {
      runs: Shaped<Run[]>
      groups: Shaped<Groups>
    }
  }
}
