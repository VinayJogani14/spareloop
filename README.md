<div align="center">

# 🔄 spareloop

### Your AI coding subscription wastes hours every day. Get them back.

**The scheduler + optimizer for Claude Code, Codex CLI, and Cursor: queue work into your spare capacity, learn your daily rhythm, and shift your usage window so resets land exactly when you need them.**

[![CI](https://github.com/VinayJogani14/spareloop/actions/workflows/ci.yml/badge.svg)](https://github.com/VinayJogani14/spareloop/actions/workflows/ci.yml)
[![GitHub Stars](https://img.shields.io/github/stars/VinayJogani14/spareloop?style=flat&logo=github)](https://github.com/VinayJogani14/spareloop/stargazers)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Node >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen?logo=node.js&logoColor=white)](package.json)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-blueviolet.svg)](CONTRIBUTING.md)

[Quick Start](#-quick-start) · [The Prewarm Trick](#-the-prewarm-trick) · [Queue](#-queue-tasks-into-spare-capacity) · [Multi-Account](#-multiple-accounts) · [Chains & Sessions](#-task-chains--session-continuity) · [Safety](#-safety-model) · [vs. Alternatives](#-vs-alternatives) · [Roadmap](#-roadmap)

![spareloop demo: suggest, predict, and stats commands running against real usage history](demo/demo.gif)

<details>
<summary>▶ 25-second animated explainer (the prewarm mechanism, visually)</summary>
<br>

<video src="https://raw.githubusercontent.com/VinayJogani14/spareloop/main/demo/explainer.mp4" controls width="640"></video>

If the player above doesn't render for you, grab [`demo/explainer.mp4`](demo/explainer.mp4) directly — code-rendered frame by frame (Pillow + ffmpeg), not screen-recorded. Free to reuse anywhere video works better than a GIF (X/Twitter posts, etc).

</details>

</div>

---

You pay for Claude Code / Codex / Cursor, but usage limits don't roll over. Some windows you barely touch; others you hit the wall at noon and sit locked out for hours. **The author measured his own waste: ~268 minutes of dead zone, every single day.**

spareloop closes that loop:

- 🌙 **Queue real work into wasted capacity** — refactors, tests, doc updates run unattended overnight or in your dead zones, each in its own repo, on its own branch, with retries that respect rate-limit resets
- 🧠 **Learn how you actually work** — reconstructs your daily window start / exhaustion / reset rhythm from your own session logs (recency-weighted, 21-day lookback)
- ⏰ **Prewarm your window** — fires one trivial prompt early so your 5-hour window resets *right before* you'd normally hit the wall
- 🔀 **Route across your accounts** — work + personal subscriptions, auto-routed to whichever has capacity
- 🔗 **Chain tasks with session continuity** — "migrate, then fix tests" pipelines that resume the same conversation

> **What spareloop is not:** it does not bypass, extend, or manipulate any vendor's limits. All accounting stays server-side, untouched. spareloop just makes sure the capacity you already pay for stops evaporating unused.

## ⚡ Quick Start

```bash
npm install -g spareloop
spareloop init              # detects claude / codex / cursor-agent
spareloop daemon install    # registers the scheduler (launchd / systemd / cron)

# queue your first overnight task
spareloop add --tool claude --dir ~/code/myapp \
  --prompt "Add missing unit tests for src/utils/ and make them pass." \
  --spare-capacity
```

After a few days of normal usage:

```bash
$ spareloop suggest

Claude Code — usage pattern (21-day lookback, 6 days with limit hits, confidence high)
  Typical start:      09:47
  Typical exhaustion: 11:17
  Window reset:       15:45
  Daily dead zone:    ~268 min
  Suggestions:
   1. [enable_prewarm] Prewarm at 06:12 shifts your window reset to ~11:12,
      landing just before you'd normally hit the wall.
      -> spareloop prewarm enable --tool claude
```

*(Real output — that's the author's actual 4.5-hour daily dead zone.)*

## ⏰ The Prewarm Trick

Claude Code and Codex enforce a 5-hour **rolling** window that starts at your **first prompt of the day**. That's an exploitable fact:

```
without prewarm:  window starts 9:00 ──── exhausted 12:10 ══ DEAD ZONE ══ 14:00 reset
with prewarm:     window starts 7:05 ──── you start 9:00 ── resets 12:05, right
                  (one trivial auto-prompt)                  before you hit the wall
```

`prewarm_time = typical_exhaustion − 5h − safety_margin`, recomputed continuously as your habits drift, with hysteresis so noisy days don't jitter the schedule. Enable auto mode or pin it manually:

```bash
spareloop prewarm enable --tool claude              # auto-computed, keeps converging
spareloop prewarm enable --tool claude --time 07:05 # or pin it
```

## 🌙 Queue Tasks Into Spare Capacity

```bash
spareloop add --tool claude --dir ~/code/api --prompt "..." \
  --at 03:00              # explicit time
  --asap                  # as soon as there's capacity
  --spare-capacity        # whenever the system detects headroom
  --priority 5            # higher runs first
  --not-after "2026-07-20T09:00"   # or don't bother
  --budget-usd 2.50       # spend cap (enforced natively by Claude)
```

Rate-limited mid-run? spareloop parses the reset time from the error, holds the task, and retries after the window clears — and that hit becomes a data point for pattern learning. Weekly caps back off for a day, not three hours.

**Saved profiles** kill the boilerplate:

```bash
spareloop profile add backend --tool claude --dir ~/code/api \
  --account auto --instructions "Run the full test suite before finishing. Never touch migrations."
spareloop add --profile backend --prompt "Fix the flaky OrderService tests"
```

## 👥 Multiple Accounts

Have separate work and personal subscriptions? Auth is resolved per config dir (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`), not per repo — so any account can run tasks in any project:

```bash
spareloop account add work --tool claude && spareloop account login work
spareloop account add personal --tool claude && spareloop account login personal

spareloop add --account auto ...    # routes to whichever account has capacity
spareloop add --account work ...    # or pin one
```

Each account gets its own capacity tracking, usage timeline, and prewarm schedule. **For subscriptions you legitimately own** — spareloop doesn't change any vendor-side accounting, and account sharing/farming violates vendor terms.

## 🔗 Task Chains & Session Continuity

```bash
A=$(spareloop add --tool claude --dir ~/code/api --prompt "Migrate the user table schema" --at 02:00)
spareloop add --after $A --same-session --prompt "Now run the test suite and fix any breakage"
```

`--after` gates on success (a failed migration cancels the follow-up instead of "fixing tests" against a broken schema). `--same-session` resumes the dependency's actual conversation — full context, no amnesia. `--continue-from <task-id>` resumes any past task's session.

## 🛡️ Safety Model

Letting an agent work while you sleep requires trust. spareloop's defaults are built for it:

- **Auto-branch isolation:** tasks in git repos run in a dedicated **git worktree** on branch `spareloop/<id>` — your working tree is never touched. Review over coffee: `git diff main...spareloop/a1b2c3d4`. Opt out per task with `--no-branch`.
- **Safe permission modes by default:** Claude `--permission-mode dontAsk` (auto-denies outside your allow rules), Codex `-a never -s workspace-write` (sandboxed), Cursor allowlist. Nothing prompts, nothing hangs, nothing silently approved.
- **Full bypass is opt-in, per task** (`--permission-mode full_bypass`) — for repos where you'd accept any outcome.
- **One task per repo, one per tool, at a time.** No agent pile-ups.
- **Honest metrics only:** Claude reports real `$`; Codex tokens → estimated `$` (flagged); Cursor exposes nothing, so nothing is invented.

## 🧰 Tool Support

|                       | Claude Code | Codex CLI | Cursor CLI |
|-----------------------|-------------|-----------|------------|
| Headless execution    | `claude -p` | `codex exec` | `cursor-agent -p` |
| Queue + scheduling    | ✅          | ✅        | ✅         |
| Cost tracking         | native `$`  | tokens → est. `$` | run counts only |
| Usage-pattern learning | ✅ session logs | ✅ session logs | n/a |
| Prewarm (rolling window) | ✅       | ✅        | n/a — monthly credit pool |
| Multi-account         | ✅          | ✅        | —          |
| Session resume in chains | ✅       | soon      | —          |

> **Status:** Claude Code adapter validated end-to-end against the real binary. **Codex and Cursor adapters are experimental** — built against current documented flags but not yet exercised on real installs. Running one? Rate-limit message reports are the most valuable contribution you can make.

## 🔮 Predict, Stats & Status

```bash
$ spareloop predict
Claude Code
  at your current pace (~340 tok/min), you'll reach your typical exhaustion
  point in ~52 min
  Projected wall: ~12:14 PM (confidence high)
  Weekly pace: $4.12 so far -> projected ~$9.80 by week's end

$ spareloop stats --tool claude
claude — usage heatmap (21-day lookback, 12196 events)
     012345678901234567890123
Mon
Tue             =+  .   ..
Wed                 . .-  .
...
  Peak hour: 20:00 (1,131,680 tokens)
  Quiet hours: 01:00, 02:00, ..., 07:00
  Waste report (last 7d): 112h of 192h unused, ~35.7h/week lost to dead zones

$ spareloop status --tool claude   # embed in Claude Code's statusLine, tmux, or a shell prompt
spareloop[claude] ▮▮▮▮▮▮▮▯▯▯ 68% · ~wall 12:14 PM · 2 queued
```

Threshold alerts (50/75/90% of your typical exhaustion budget) fire as OS notifications automatically once the daemon is running — no flag needed. Task completions/failures notify too.

## 📟 All Commands

```
spareloop init                          detect CLIs, create data dir
spareloop add [flags]                   queue a task
spareloop list / show <id> / cancel <id> / run <id>
spareloop account add|login|list|rm     multi-account management
spareloop profile add|list|rm           reusable task presets
spareloop daemon install|start|stop|status|logs|pause|resume
spareloop usage [--tool] [--days]       unified usage history
spareloop predict [--tool]              burn-rate ETA + weekly pace
spareloop stats [--tool] [--days]       peak/quiet-hour heatmap + waste report
spareloop status --tool <t>             one-line status for statusLine/tmux/prompt
spareloop suggest [--verbose]           pattern analysis + recommendations
spareloop prewarm enable|disable|status
```

## ⚔️ vs. Alternatives

There's a great ecosystem of tools around this problem already — spareloop exists because each one solves one piece, and none closes the loop:

|                                  | [ccusage](https://github.com/ryoppippi/ccusage) | [Claude-Code-Usage-Monitor](https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor) | [claude-queue](https://github.com/vasiliyk/claude-queue) | **spareloop** |
|----------------------------------|:---:|:---:|:---:|:---:|
| Parses local usage/session logs  | ✅ | ✅ | — | ✅ |
| Live burn-rate & ETA prediction  | — | ✅ | — | ✅ |
| Queue tasks to run unattended    | — | — | ✅ | ✅ |
| Auto-pause/resume on rate limit  | — | — | ✅ | ✅ |
| **Learns your daily rhythm & prewarms your window** | — | — | — | ✅ |
| Multi-account routing            | — | — | — | ✅ |
| Task chains + session resume     | — | — | — | ✅ |
| Auto-branch isolation (git worktree) | — | — | — | ✅ |
| Multi-tool (Claude / Codex / Cursor) | Claude only | Claude only | Claude only | ✅ |

ccusage and the usage monitors tell you what happened; claude-queue lets you queue work. spareloop is the loop: it watches usage, learns your pattern, prewarms your window, and queues work into the capacity that would otherwise evaporate — across every tool you use.

## 🗺️ Roadmap

- [x] Queue + daemon + prewarm + pattern learning (v0.1)
- [x] Multi-account routing, task chains, session continuity, worktree isolation, profiles (v0.2)
- [x] `spareloop predict` — live burn rate → "you hit the wall at 12:40pm" (v0.3)
- [x] `spareloop stats` — peak/down hours heatmap + waste report (v0.3)
- [x] Threshold alerts (50/75/90%) + OS notifications + status-line integration (v0.3)
- [ ] Morning report: what ran overnight, diffs, costs
- [ ] Memory providers (OpenMemory/Mem0, Supermemory, Zep, Letta via MCP)
- [ ] Webhooks (Slack/Discord), CSV/JSON export, Windows support

## ⭐ Star History

[![Star History Chart](https://api.star-history.com/svg?repos=VinayJogani14/spareloop&type=Date)](https://star-history.com/#VinayJogani14/spareloop&Date)

## 🤝 Contributing

The highest-impact contributions right now: real-world **Codex/Cursor rate-limit message samples**, adapter validation on real installs, and the roadmap items above. Development:

```bash
git clone https://github.com/VinayJogani14/spareloop && cd spareloop
npm install && npm test
SPARELOOP_HOME=/tmp/sl-dev node dist/src/cli/index.js init   # isolated sandbox
```

## License

MIT © Vinay Jogani
