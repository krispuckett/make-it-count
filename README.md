# Make It Count 

A Claude Code skill that reads your real session history, measures how you
actually work, and hands back a prioritized list for spending less to do
more.

If we don't have $2000/month in token budget, we need
to make every token count. 

## What it does

- **Reads your local transcripts** in `~/.claude/projects` (read-only, nothing
  leaves your machine)
- **Pulls real numbers**: model mix, token spend, chat length, subagent use,
  prompt precision, CLAUDE.md size
- **Grades 8 principles** and ranks the top moves, with a dollar estimate

## Quick start

```bash
git clone https://github.com/krispuckett/make-it-count.git
cd make-it-count

# Human-readable report
node scripts/scan.mjs

# Raw metrics as JSON
MIC_FORMAT=json node scripts/scan.mjs
```

That is it. No dependencies, no install, no API key. Just Node.

## Use it through your agent

Drop the folder into your skills directory and ask:

> "Run make-it-count"
> "Audit my token usage"
> "Where am I wasting tokens?"
> "Make every token count"

The agent runs the scan, then reasons over your actual numbers instead of
reciting generic advice.

## The 8 principles

1. **Right model for the job.** Sonnet for most of it, Opus for hard
   architecture, Haiku for grunt work. Do not pay Opus rates to rename a variable.
2. **Be specific or pay for it.** "Fix line 42 in auth.ts" costs pennies.
   "Something is off with login" makes it read half your repo.
3. **One task per chat.** Clear context between jobs. Stale context taxes every
   message after it.
4. **Send the heavy lifting to subagents.** Tests, logs, doc-fetching, big
   searches. The noise stays there. Only the summary comes home.
5. **Plan in Opus, build in Sonnet.** Pay once for the thinking, cheap for the
   doing.
6. **Tiny CLAUDE.md, plus a .claudeignore.** Stop it re-reading junk every time.
   Set it once, win every session.
7. **Leave yourself a note.** Dump decisions and next steps to a markdown file.
   Load it tomorrow instead of re-explaining everything.
8. **Watch /usage.** Spend the expensive model on the moments that earn it.

## What you get

```
# make-it-count report

Scanned 18 sessions, 9.4K transcript lines. Estimated spend in window: $214.

## Where your tokens went

| Model  | Turns | Tokens | Share | Est. cost |
|--------|------:|-------:|------:|----------:|
| opus   |  1240 |   480M |   76% |   $205.00 |
| sonnet |    90 |   110M |   17% |     $7.20 |
| haiku  |    60 |    42M |    7% |     $1.50 |

## Top moves

1. Right model for the job [FIX] - 76% of tokens on Opus; route routine edits to Sonnet, grunt work to Haiku
2. One task per chat [WATCH] - 4 of 18 chats ran past 100 turns
3. Leave yourself a note [FIX] - 0 handoff notes written this window
...

Constraints make you more precise, if you let them.
```

(Sample figures. Your report uses your own numbers.)

## Configuration

| Variable | Default | Description |
|---|---|---|
| `MIC_PROJECTS_DIR` | `~/.claude/projects` | Where Claude Code keeps transcripts |
| `MIC_DAYS` | `30` | How far back to scan, in days |
| `MIC_FORMAT` | `markdown` | `markdown` for the report, `json` for raw metrics |

```bash
# Look back 90 days
MIC_DAYS=90 node scripts/scan.mjs

# Point it somewhere else
MIC_PROJECTS_DIR=/path/to/.claude/projects node scripts/scan.mjs
```

## Safety

- **Read-only.** Never writes, deletes, or uploads anything.
- **Stays on your machine.** No content is sent anywhere. Prompt text is read
  only to score precision and is never printed.
- **Advisory only.** Every output is a recommendation.

## How the cost estimate works

Per-million-token rates live at the top of `scripts/scan.mjs`. The estimate
counts cache reads at roughly a tenth of input price and cache writes at about
1.25x, so it tracks your real bill better than multiplying raw tokens would.
Treat it as directional, and update the rates when prices move.

## License

MIT. See [LICENSE](LICENSE).

---
