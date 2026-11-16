# Relay

A Claude Code mod that keeps a live pane beside the chat showing every agent and subagent at work.

When a workflow starts, or two or more subagents run at once, the Relay pane opens by itself. It groups the agents under the task they belong to (the workflow's name, or "Subagents") and shows one row per agent:

- **Task**: what the agent was asked to do.
- **Now**: what it is doing at this moment, taken from its latest tool call ("Edit register.tsx", "Bash npm test").
- **Model and effort**: for example "Opus 5.5 · high".
- **Tokens**: every token the agent has used so far.
- **Percent complete**: shown as a bar with slow-moving stripes.

## Colors

Each agent's bar is a single-hue gradient whose hue comes from its model: Fable is purple, Opus coral, Sonnet blue, Haiku teal, and any other model gray. Higher effort starts the bar on a deeper shade. A color key at the top of the pane lists the models in view.

## How the percent is worked out

Claude Code does not report how big an agent's job is, so the percent is an estimate, marked with "≈". It divides the tokens the agent has used by the average tokens of agents that already finished in the session (600k before any has finished), and it never shows more than 95% until the agent actually finishes. An agent that reports its own steps through a `step` tool (as savvy-flow workers do) shows the exact "step 3/5" instead.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install relay --marketplace DanberkmanPracticed/relay
```

Answer `y` to add the marketplace, then pick a scope.

From a shell:

```
claude plugin install relay --marketplace DanberkmanPracticed/relay
```

## Use

- The pane opens by itself for a workflow, or once two agents run together.
- `/relay` opens it by hand.
- **Clear Finished** removes the agents that are done.
- In a terminal the same pane is drawn in text, with the bar in colored blocks.
- Animations stop when the system asks for reduced motion.

## License

MIT
