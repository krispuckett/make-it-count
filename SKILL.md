---
name: make-it-count
description: "Analyze your Claude Code workflow and token usage, then hand back a prioritized punch list for spending less to do more. Reads your local session history (read-only, nothing leaves your machine), grades how you actually work against 8 token-efficiency principles (right model, precise prompts, one task per chat, subagents, plan/build split, lean CLAUDE.md, handoff notes, watch usage), and tells you exactly what to change. Use when asked to optimize token usage, audit Claude Code spend, review an agent workflow, cut costs, or make every token count."
---

# make-it-count

Find out where your tokens go, then make every one count.

This skill reads your real Claude Code history, measures how you work, and grades
it against 8 principles. It does not lecture from theory. It pulls actual numbers
off your transcripts (model mix, token spend, chat length, subagent use, prompt
precision) and turns them into a short list of things to change.

## Quick start

```bash
# Human-readable report
node scripts/scan.mjs

# Raw metrics as JSON (for the agent to reason over)
MIC_FORMAT=json node scripts/scan.mjs
```

## How to run it

1. Run `node scripts/scan.mjs` from this skill's directory.
2. Read the report it prints. It already grades all 8 principles and ranks the
   top moves. For most people, that is the whole job.
3. If the user wants a deeper or more personal read, run
   `MIC_FORMAT=json node scripts/scan.mjs`, take the structured metrics, and
   reason over them yourself before answering. Tie advice to their actual
   numbers, not to generic best practice.

## What it measures

| # | Principle | Signal pulled from transcripts |
|---|---|---|
| 1 | Right model for the job | Token + cost share across opus / sonnet / haiku |
| 2 | Be specific or pay for it | Share of prompts that are short and unanchored vs. ones that name a file, line, or symbol |
| 3 | One task per chat | Turns per session, count of bloated sessions |
| 4 | Send heavy lifting to subagents | Subagent spawns vs. heavy main-thread searches and reads |
| 5 | Plan in Opus, build in Sonnet | Share of chats that shift model tiers within a single job |
| 6 | Tiny CLAUDE.md plus a .claudeignore | Size of each CLAUDE.md, presence of .claudeignore in active repos |
| 7 | Leave yourself a note | Count of handoff-style markdown notes written |
| 8 | Watch /usage | Estimated spend for the window, as a teaser to go check the real thing |

## Config

| Variable | Default | Description |
|---|---|---|
| `MIC_PROJECTS_DIR` | `~/.claude/projects` | Where Claude Code keeps session transcripts |
| `MIC_DAYS` | `30` | How far back to scan, in days |
| `MIC_FORMAT` | `markdown` | `markdown` for the report, `json` for raw metrics |

## How to read the grades

- **FIX** is leaking real money or context. Address it first.
- **WATCH** is fine for now but worth a habit change.
- **GOOD** means the data says you already do this. Leave it alone.

When you relay results, lead with the FIX items and the dollar estimate. Keep it
direct. The point is a short, specific punch list, not a scorecard.

## Safety

- **Read-only.** It never writes to, deletes, or uploads anything.
- **Stays local.** No content leaves the machine. Short prompt snippets are read
  only to score precision, and they are never printed or stored.
- **Advisory only.** Every output is a recommendation. You decide what to change.

## Notes

- Cost is an estimate. Cache reads are billed at roughly a tenth of input, and
  the script factors that in, so the number tracks reality better than a raw
  token multiply would. Per-million rates live at the top of `scripts/scan.mjs`.
  Update them when prices move.
- The unmeasurable principles (watch /usage, and partly leave-yourself-a-note)
  come back as coaching rather than a hard grade. That is by design.
