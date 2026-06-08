#!/usr/bin/env node
// make-it-count - workflow + token analyzer for Claude Code
//
// Reads your local Claude Code session history (read-only), measures how you
// actually work, and grades it against 8 token-efficiency principles. Nothing
// leaves your machine. No content is uploaded anywhere. Short prompt snippets
// are read only to score precision, and they are never printed.
//
// Usage:
//   node scripts/scan.mjs                  # human-readable report
//   MIC_FORMAT=json node scripts/scan.mjs  # raw metrics as JSON
//
// Config (env vars):
//   MIC_PROJECTS_DIR   default: ~/.claude/projects
//   MIC_DAYS           how far back to scan, in days (default: 30)
//   MIC_FORMAT         "markdown" (default) or "json"

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const HOME = os.homedir();
const PROJECTS_DIR =
  process.env.MIC_PROJECTS_DIR || path.join(HOME, ".claude", "projects");
const DAYS = Number(process.env.MIC_DAYS || 30);
const FORMAT = (process.env.MIC_FORMAT || "markdown").toLowerCase();
const CUTOFF = Date.now() - DAYS * 24 * 60 * 60 * 1000;

// Per-million-token rates. Cached 2026-05-26 from the Claude pricing docs.
// Update these when prices change.
const PRICING = {
  opus: { input: 5, output: 25 },
  sonnet: { input: 3, output: 15 },
  haiku: { input: 1, output: 5 },
  other: { input: 5, output: 25 },
};

// Tools that count as "spawning a subagent" (the noise stays over there).
const SUBAGENT_TOOLS = new Set(["Task", "Agent"]);
// Heavy main-thread tools that, in bulk, are candidates for a subagent.
const HEAVY_TOOLS = new Set(["Bash", "Grep", "Glob", "Read", "WebFetch"]);

// Thresholds (tunable).
const BLOAT_TURNS = 100; // assistant turns in one chat before it reads as bloated
const BIG_CLAUDE_MD_TOKENS = 3000; // CLAUDE.md size that earns a trim
const VAGUE_MAX_WORDS = 6; // a short prompt with no anchors reads as vague

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function walkJsonl(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkJsonl(full));
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}

function modelFamily(model) {
  if (!model || model === "<synthetic>") return null;
  if (model.includes("opus")) return "opus";
  if (model.includes("sonnet")) return "sonnet";
  if (model.includes("haiku")) return "haiku";
  return "other";
}

// Does this prompt anchor itself to something concrete?
const ANCHOR_RE =
  /([\w./-]+\.(ts|tsx|js|jsx|py|swift|md|json|go|rs|css|html|sh|rb|java|kt|c|cpp|h|hpp|sql|yaml|yml|toml))\b|:\d+\b|`[^`]+`/i;

function estTokens(bytes) {
  return Math.round(bytes / 4); // rough, good enough for "is this too big"
}

function fmtTokens(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}

function pct(n) {
  return (n * 100).toFixed(0) + "%";
}

function usd(n) {
  if (n >= 100) return "$" + n.toFixed(0);
  return "$" + n.toFixed(2);
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

const metrics = {
  scannedFiles: 0,
  scannedSessions: 0,
  lines: 0,
  earliest: null,
  latest: null,
  byModel: {}, // family -> { turns, tokens, cost }
  totals: { turns: 0, tokens: 0, cost: 0 },
  subagentSpawns: 0,
  sidechainLines: 0,
  inlineHeavy: 0,
  prompts: { total: 0, precise: 0, vague: 0 },
  sessions: { total: 0, bloated: 0, maxTurns: 0, multiModel: 0, single: 0 },
  turnHistogram: [],
  handoffWrites: 0,
  mdWrites: 0,
  cwds: {}, // cwd -> session count
};

function bumpModel(fam, tokens, cost) {
  if (!metrics.byModel[fam])
    metrics.byModel[fam] = { turns: 0, tokens: 0, cost: 0 };
  metrics.byModel[fam].turns += 1;
  metrics.byModel[fam].tokens += tokens;
  metrics.byModel[fam].cost += cost;
}

const files = walkJsonl(PROJECTS_DIR);

for (const file of files) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    continue;
  }
  if (stat.mtimeMs < CUTOFF) continue;

  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    continue;
  }

  metrics.scannedFiles += 1;
  let sessionTurns = 0;
  const sessionFamilies = new Set();

  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    let d;
    try {
      d = JSON.parse(raw);
    } catch {
      continue;
    }
    metrics.lines += 1;

    const ts = d.timestamp ? Date.parse(d.timestamp) : null;
    if (ts) {
      if (!metrics.earliest || ts < metrics.earliest) metrics.earliest = ts;
      if (!metrics.latest || ts > metrics.latest) metrics.latest = ts;
    }

    if (d.isSidechain) metrics.sidechainLines += 1;
    if (d.cwd) metrics.cwds[d.cwd] = (metrics.cwds[d.cwd] || 0) + 1;

    const msg = d.message || {};

    // ---- assistant turns: model mix, tokens, cost, tool use ----
    if (d.type === "assistant") {
      const fam = modelFamily(msg.model);
      const u = msg.usage || {};
      const inp = u.input_tokens || 0;
      const out = u.output_tokens || 0;
      const cc = u.cache_creation_input_tokens || 0;
      const cr = u.cache_read_input_tokens || 0;
      const tokens = inp + out + cc + cr;

      if (fam) {
        const rate = PRICING[fam] || PRICING.other;
        // cache writes ~1.25x input, cache reads ~0.1x input
        const cost =
          ((inp + cc * 1.25 + cr * 0.1) / 1e6) * rate.input +
          (out / 1e6) * rate.output;
        bumpModel(fam, tokens, cost);
        metrics.totals.turns += 1;
        metrics.totals.tokens += tokens;
        metrics.totals.cost += cost;
        if (!d.isSidechain) {
          sessionTurns += 1;
          sessionFamilies.add(fam);
        }
      }

      const content = Array.isArray(msg.content) ? msg.content : [];
      for (const block of content) {
        if (!block || block.type !== "tool_use") continue;
        const name = block.name || "";
        if (SUBAGENT_TOOLS.has(name)) metrics.subagentSpawns += 1;
        if (!d.isSidechain && HEAVY_TOOLS.has(name)) metrics.inlineHeavy += 1;
        if (name === "Write") {
          const fp = (block.input && block.input.file_path) || "";
          if (fp.endsWith(".md")) {
            metrics.mdWrites += 1;
            const base = path.basename(fp).toLowerCase();
            if (
              /(note|handoff|hand-off|todo|next|progress|context|decision|journal|scratch|plan|recap|status)/.test(
                base,
              )
            )
              metrics.handoffWrites += 1;
          }
        }
      }
    }

    // ---- user prompts: precision ----
    if (d.type === "user" && !d.isSidechain && !d.isMeta) {
      const c = msg.content;
      let promptText = "";
      if (typeof c === "string") {
        promptText = c;
      } else if (Array.isArray(c)) {
        // tool_result entries are not human prompts
        if (c.some((b) => b && b.type === "tool_result")) continue;
        promptText = c
          .filter((b) => b && b.type === "text")
          .map((b) => b.text || "")
          .join(" ");
      }
      promptText = promptText.trim();
      if (!promptText) continue;
      // skip slash-command wrappers and piped stdout
      if (/^<(command|local-command|user-prompt-submit)/.test(promptText))
        continue;

      metrics.prompts.total += 1;
      const anchored = ANCHOR_RE.test(promptText);
      const words = promptText.split(/\s+/).length;
      if (anchored) metrics.prompts.precise += 1;
      else if (words <= VAGUE_MAX_WORDS) metrics.prompts.vague += 1;
    }
  }

  if (sessionTurns > 0) {
    metrics.scannedSessions += 1;
    metrics.sessions.total += 1;
    metrics.turnHistogram.push(sessionTurns);
    if (sessionTurns > metrics.sessions.maxTurns)
      metrics.sessions.maxTurns = sessionTurns;
    if (sessionTurns > BLOAT_TURNS) metrics.sessions.bloated += 1;
    if (sessionFamilies.size > 1) metrics.sessions.multiModel += 1;
    else metrics.sessions.single += 1;
  }
}

// ---- CLAUDE.md / .claudeignore checks ----
function fileTokens(p) {
  try {
    return estTokens(fs.statSync(p).size);
  } catch {
    return null;
  }
}

const claudeChecks = [];
const globalMd = path.join(HOME, ".claude", "CLAUDE.md");
const gTok = fileTokens(globalMd);
if (gTok != null)
  claudeChecks.push({ scope: "global", path: globalMd, tokens: gTok, ignore: null });

const topCwds = Object.entries(metrics.cwds)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 5)
  .map(([c]) => c);
for (const cwd of topCwds) {
  const md = path.join(cwd, "CLAUDE.md");
  const tok = fileTokens(md);
  const hasIgnore = fs.existsSync(path.join(cwd, ".claudeignore"));
  if (tok != null || hasIgnore !== undefined)
    claudeChecks.push({
      scope: cwd.replace(HOME, "~"),
      path: md,
      tokens: tok,
      ignore: hasIgnore,
    });
}
metrics.claudeChecks = claudeChecks;

// ---------------------------------------------------------------------------
// Grade
// ---------------------------------------------------------------------------

const median = (arr) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

const T = metrics.totals.tokens || 1;
const opusTok = metrics.byModel.opus ? metrics.byModel.opus.tokens : 0;
const sonnetTok = metrics.byModel.sonnet ? metrics.byModel.sonnet.tokens : 0;
const haikuTok = metrics.byModel.haiku ? metrics.byModel.haiku.tokens : 0;
const opusShare = opusTok / T;
const sonnetShare = sonnetTok / T;

const P = metrics.prompts.total || 1;
const vagueRate = metrics.prompts.vague / P;

const S = metrics.sessions.total || 1;
const bloatRate = metrics.sessions.bloated / S;
const multiModelRate = metrics.sessions.multiModel / S;

const STATUS = { fix: "FIX", watch: "WATCH", good: "GOOD" };

function grade() {
  const g = [];

  // 1. Right model for the job
  let s1 = "good";
  if (opusShare > 0.7) s1 = "fix";
  else if (opusShare > 0.4) s1 = "watch";
  g.push({
    n: 1,
    title: "Right model for the job",
    status: s1,
    evidence: `Opus ran ${pct(opusShare)} of your tokens. Sonnet ${pct(
      sonnetShare,
    )}, Haiku ${pct(haikuTok / T)}.`,
    rec:
      s1 === "good"
        ? "Healthy spread. Keep routing the routine work down a tier."
        : "Send routine edits, renames, and log-reading to Sonnet, grunt work to Haiku. Save Opus for hard architecture. Paying Opus rates to rename a variable is the most common leak.",
  });

  // 2. Be specific or pay for it
  let s2 = "good";
  if (vagueRate > 0.45) s2 = "fix";
  else if (vagueRate > 0.25) s2 = "watch";
  g.push({
    n: 2,
    title: "Be specific or pay for it",
    status: s2,
    evidence: `${metrics.prompts.vague} of ${metrics.prompts.total} prompts were short and unanchored (${pct(
      vagueRate,
    )}). ${metrics.prompts.precise} named a file, line, or symbol.`,
    rec:
      s2 === "good"
        ? "Your prompts point at things. That keeps reads cheap."
        : 'A vague prompt makes the agent read half your repo to find what you meant. Name the file and line. "Fix the auth redirect in login.ts:42" costs pennies next to "something is off with login".',
  });

  // 3. One task per chat
  let s3 = "good";
  if (bloatRate > 0.2) s3 = "fix";
  else if (bloatRate > 0.1) s3 = "watch";
  g.push({
    n: 3,
    title: "One task per chat",
    status: s3,
    evidence: `Median chat: ${median(metrics.turnHistogram)} turns. Longest: ${
      metrics.sessions.maxTurns
    }. ${metrics.sessions.bloated} of ${metrics.sessions.total} ran past ${BLOAT_TURNS} turns.`,
    rec:
      s3 === "good"
        ? "You keep chats scoped. Stale context is not taxing you."
        : "Long chats carry stale context into every later message, and you pay for it each turn. Finish a job, clear, start the next. Dump anything worth keeping to a file first.",
  });

  // 4. Send heavy lifting to subagents
  let s4 = "good";
  if (metrics.subagentSpawns === 0 && metrics.inlineHeavy > 200) s4 = "fix";
  else if (metrics.inlineHeavy > 0 && metrics.subagentSpawns / metrics.inlineHeavy < 0.02)
    s4 = "watch";
  g.push({
    n: 4,
    title: "Send the heavy lifting to subagents",
    status: s4,
    evidence: `${metrics.subagentSpawns} subagent spawns against ${metrics.inlineHeavy} heavy searches/reads on the main thread. Sidechain traffic: ${fmtTokens(
      metrics.sidechainLines,
    )} lines.`,
    rec:
      s4 === "good"
        ? "You push noisy work to subagents. Only the summary comes home."
        : "Big searches, test runs, log scraping, and doc fetching dump a lot of noise straight into your main context. Hand them to a subagent. The mess stays there and only the answer comes back.",
  });

  // 5. Plan in Opus, build in Sonnet
  let s5 = "good";
  if (multiModelRate < 0.05 && opusShare > 0.6) s5 = "fix";
  else if (multiModelRate < 0.15 && opusShare > 0.4) s5 = "watch";
  g.push({
    n: 5,
    title: "Plan in Opus, build in Sonnet",
    status: s5,
    evidence: `${pct(multiModelRate)} of chats used more than one model. The rest stayed on a single tier.`,
    rec:
      s5 === "good"
        ? "You shift tiers within a job. Pay once for the thinking, cheap for the doing."
        : "If a chat is all-Opus from plan to build, you paid Opus rates for the typing too. Plan and architect in Opus, then drop to Sonnet to implement.",
  });

  // 6. Tiny CLAUDE.md + .claudeignore
  let s6 = "good";
  const bigMd = metrics.claudeChecks.filter(
    (c) => c.tokens != null && c.tokens > BIG_CLAUDE_MD_TOKENS,
  );
  const missingIgnore = metrics.claudeChecks.filter(
    (c) => c.scope !== "global" && c.ignore === false,
  );
  if (bigMd.length) s6 = "fix";
  else if (missingIgnore.length) s6 = "watch";
  const mdLines = metrics.claudeChecks.length
    ? metrics.claudeChecks
        .map(
          (c) =>
            `${c.scope}: ${
              c.tokens == null ? "no CLAUDE.md" : "~" + fmtTokens(c.tokens) + " tok"
            }${c.ignore === false ? ", no .claudeignore" : c.ignore === true ? ", has .claudeignore" : ""}`,
        )
        .join("; ")
    : "No CLAUDE.md or active project dirs found.";
  g.push({
    n: 6,
    title: "Tiny CLAUDE.md plus a .claudeignore",
    status: s6,
    evidence: mdLines,
    rec:
      s6 === "good"
        ? "Lean config. You are not re-reading junk every session."
        : "Every session re-reads CLAUDE.md and pulls in whatever is not ignored. Trim CLAUDE.md to the essentials and add a .claudeignore for build output, lockfiles, and vendored code. Set it once, win every session.",
  });

  // 7. Leave yourself a note
  let s7 = metrics.handoffWrites >= 3 ? "good" : metrics.handoffWrites >= 1 ? "watch" : "fix";
  g.push({
    n: 7,
    title: "Leave yourself a note",
    status: s7,
    evidence: `${metrics.handoffWrites} handoff-style markdown notes written (${metrics.mdWrites} markdown files total).`,
    rec:
      s7 === "good"
        ? "You write things down. Tomorrow you load the note instead of re-explaining."
        : "Dump decisions and next steps to a markdown file at the end of a session. Loading that note tomorrow is far cheaper than rebuilding the whole context from scratch.",
  });

  // 8. Watch /usage
  g.push({
    n: 8,
    title: "Watch /usage",
    status: "watch",
    evidence: `Estimated spend in this window: ${usd(metrics.totals.cost)} across ${fmtTokens(
      metrics.totals.tokens,
    )} tokens.`,
    rec: "Run /usage now and then. Knowing where the spend goes is what lets you put the expensive model on the moments that earn it.",
  });

  return g;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

if (metrics.scannedSessions === 0) {
  const msg = [
    "make-it-count found no Claude Code history to analyze.",
    "",
    `Looked in: ${PROJECTS_DIR} (sessions from the last ${DAYS} days).`,
    "",
    "If you use Claude Code elsewhere, point the scanner at it:",
    "  MIC_PROJECTS_DIR=/path/to/.claude/projects node scripts/scan.mjs",
    "",
    "Or widen the window:",
    "  MIC_DAYS=90 node scripts/scan.mjs",
  ].join("\n");
  if (FORMAT === "json") {
    console.log(JSON.stringify({ error: "no_history", projectsDir: PROJECTS_DIR, days: DAYS }, null, 2));
  } else {
    console.log(msg);
  }
  process.exit(0);
}

const graded = grade();
metrics.grades = graded;

if (FORMAT === "json") {
  console.log(JSON.stringify(metrics, null, 2));
  process.exit(0);
}

// markdown report
const lines = [];
const range =
  metrics.earliest && metrics.latest
    ? `${new Date(metrics.earliest).toISOString().slice(0, 10)} to ${new Date(
        metrics.latest,
      ).toISOString().slice(0, 10)}`
    : "recent";

lines.push("# make-it-count report");
lines.push("");
lines.push(
  `Scanned ${metrics.scannedSessions} sessions (${range}), ${fmtTokens(
    metrics.lines,
  )} transcript lines. Estimated spend in window: ${usd(metrics.totals.cost)}.`,
);
lines.push("");
lines.push("Read-only. Nothing left your machine.");
lines.push("");

// model table
lines.push("## Where your tokens went");
lines.push("");
lines.push("| Model | Turns | Tokens | Share | Est. cost |");
lines.push("|---|---:|---:|---:|---:|");
for (const fam of ["opus", "sonnet", "haiku", "other"]) {
  const m = metrics.byModel[fam];
  if (!m) continue;
  lines.push(
    `| ${fam} | ${m.turns} | ${fmtTokens(m.tokens)} | ${pct(
      m.tokens / T,
    )} | ${usd(m.cost)} |`,
  );
}
lines.push("");
lines.push("_Cost is an estimate. Cache reads are billed at roughly a tenth of input, and that is factored in. Rates live at the top of scripts/scan.mjs if you need to update them._");
lines.push("");

// per-principle
lines.push("## The 8 principles, graded");
lines.push("");
for (const item of graded) {
  lines.push(`### ${item.n}. ${item.title}  [${STATUS[item.status]}]`);
  lines.push("");
  lines.push(item.evidence);
  lines.push("");
  lines.push(item.rec);
  lines.push("");
}

// top moves
const order = { fix: 0, watch: 1, good: 2 };
const moves = graded
  .filter((x) => x.status !== "good")
  .sort((a, b) => order[a.status] - order[b.status]);
lines.push("## Top moves");
lines.push("");
if (!moves.length) {
  lines.push("Nothing flagged. You are running lean. Watch /usage and keep going.");
} else {
  let i = 1;
  for (const m of moves) {
    lines.push(`${i}. **${m.title}** [${STATUS[m.status]}] - ${m.rec}`);
    i += 1;
  }
}
lines.push("");
lines.push("Constraints make you more precise, if you let them.");
lines.push("");

console.log(lines.join("\n"));
