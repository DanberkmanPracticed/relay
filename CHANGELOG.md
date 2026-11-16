# Changelog

Relay follows semantic versioning: the minor number goes up for new behavior, the patch number for fixes.

## 0.5.1 (2026-11-16)

- Exact Steps now works when the setting is turned on in a session that is already running: the step tool is set up when the first agent starts, not only at session start.

## 0.5.0 (2026-11-16)

- New Exact Steps setting, off by default: Relay adds one line to each agent's instructions asking it to report its steps through Relay's own `step` tool, and the row shows an exact "step 3/5". No other plugin needed.

## 0.4.0 (2026-11-16)

- Removed the savvy-progress step reporting. Relay depends on no other plugin; every percent is its own estimate.

## 0.3.0 (2026-11-16)

- A row with no activity for 10 minutes turns gray and says "Stalled", so a stuck or retried agent no longer reads as running forever. Any later activity brings it back.

## 0.2.0 (2026-11-16)

- An agent that finishes before Relay has recorded it now shows as finished instead of running forever.
- An error in Relay's own bookkeeping can no longer break a subagent starting or ending, or slow a tool call down.
- A remote workflow agent says so, and closes when the rest of its workflow finishes.
- The percent no longer parks near 95% on long runs, a quick lookup can't skew it (100k floor), and an agent that stops early keeps the percent it reached.
- Keys, passwords and tokens are masked on the "Now" line.
- Token counts are labeled "tokens processed".
- After you close the pane, it opens again for the next batch of agents.
- Saved workflow scripts show their name without the run id.
- A step count that is not a number is ignored, and odd characters no longer blank a row.

## 0.1.0 (2026-11-16)

First release.
