# spareloop

**Stop wasting your AI coding CLI usage windows.**

You pay for Claude Code / Codex / Cursor, but your usage limit doesn't roll over. Some days you barely touch it; other days you hit the wall at noon and sit locked out for two hours. spareloop turns both problems into scheduling problems — and solves them:

1. **Queue tasks into your spare capacity.** Refactors, test coverage, doc updates, dependency bumps — queue them once, and spareloop runs them unattended (overnight, in your dead zones, or whenever there's headroom), each in its own repo with its own tool and settings.
2. **Learn your rhythm, then prewarm your window.** Claude Code and Codex enforce a 5-hour *rolling* window that starts at your **first prompt**. spareloop watches when you actually start, exhaust, and reset each day — then fires a trivial prompt early in the morning so the reset lands right when you'd otherwise be locked out.

### The prewarm trick, concretely

Say you start work at 9am, exhaust your window at 12:10pm, and can't work again until 2pm. That's ~110 wasted minutes, every day.

```
without prewarm:  window starts 9:00 ──── exhausted 12:10 ══ DEAD ZONE ══ 14:00 reset
with prewarm:     window starts 7:05 ──── you start 9:00 ── resets 12:05, right
                  (trivial auto-prompt)                      before you hit the wall
```

spareloop computes the fire time as `typical_exhaustion − 5h − safety_margin`, re-learns your pattern continuously (recency-weighted over a 21-day rolling lookback), and nudges the prewarm time as your habits drift — with hysteresis, so it doesn't jitter on noisy days.

> **What spareloop is not:** it does not bypass, extend, or manipulate any vendor's usage limits. All accounting stays on the vendor's servers, untouched. spareloop just makes sure the capacity you already pay for stops evaporating unused.

## Install

```bash
npm install -g spareloop
spareloop init            # detects claude / codex / cursor-agent on your PATH
spareloop daemon install  # registers the scheduler (launchd / systemd / cron)
```

## Queue your first task

```bash
# run whenever there's spare capacity (dead zones, overnight, ...)
spareloop add --tool claude --dir ~/code/myapp \
  --prompt "Add missing unit tests for src/utils/. Run the test suite and make it pass." \
  --spare-capacity

# or at an explicit time
spareloop add --tool codex --dir ~/code/otherapp \
  --prompt "Upgrade all minor-version dependencies and fix any breakage." \
  --at 03:00

# watch it
spareloop list
spareloop show <id>
spareloop daemon logs
```

## Let it learn, then optimize

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
   2. [queue_into_dead_zone] Your 11:17-15:45 dead zone is prime time for queued
      background work — queued tasks drain into it automatically.
```

(That's real output. The author's own dead zone was 4.5 hours a day.)

```bash
spareloop prewarm enable --tool claude          # auto-computed, keeps converging
spareloop prewarm enable --tool claude --time 07:05   # or pin it manually
spareloop usage                                  # unified cost/token/rate-limit history
```

## Tool support

|                       | Claude Code | Codex CLI | Cursor CLI |
|-----------------------|-------------|-----------|------------|
| Headless execution    | `claude -p` | `codex exec` | `cursor-agent -p` |
| Queue + scheduling    | yes         | yes       | yes        |
| Cost tracking         | native `$`  | tokens → estimated `$` (flagged) | none exposed by local CLI |
| Interactive-usage learning | yes (session logs) | yes (session logs) | n/a |
| Prewarm               | yes         | yes       | **n/a — monthly credit pool, no rolling window** |

spareloop never fabricates metrics: Codex costs are estimates from a [user-overridable pricing table](src/adapters/pricing.ts) and flagged as such in the database; Cursor runs are tracked by count only.

> **Status:** the Claude Code adapter is validated end-to-end against the real binary (including live cost parsing and session-log ingestion). The **Codex and Cursor adapters are experimental** — built against current documented flags but not yet exercised against real installs. If you run either, bug reports (especially exact rate-limit message phrasings) are the single most useful contribution.

## Safety model

Unattended runs default to each tool's **safe non-interactive mode** — Claude `--permission-mode dontAsk` (auto-denies anything outside your project's `permissions.allow` rules), Codex `-a never -s workspace-write` (sandboxed to the workspace), Cursor allowlist rules from `~/.cursor/cli-config.json`. Nothing prompts, nothing hangs, nothing gets silently approved.

Per task you can opt into `--permission-mode full_bypass` (Claude `--dangerously-skip-permissions` / Codex `--yolo` / Cursor `--force`) — do that only for repos where you'd accept any outcome, ideally sandboxed. Budget caps: `--budget-usd` (enforced natively by Claude Code).

## How it works

- **One SQLite database** (`~/.local/share/spareloop/`) holds tasks, runs, a unified usage-event timeline (your interactive sessions + spareloop's own runs), learned patterns, and suggestions.
- **A tiny daemon** ticks every minute: ingests new usage from the tools' local session logs, re-queues rate-limited tasks after their reset passes, recomputes your pattern hourly, schedules the daily prewarm, and launches eligible tasks (one per tool at a time).
- **Rate-limit hits are the ground truth.** When a run hits the wall, spareloop parses the reset time from the error message, holds the task, and retries after reset — and that hit becomes a data point for pattern learning.
- **Capacity is estimated honestly.** No vendor exposes a live quota API, so spareloop layers reactive signals (a recent rate-limit hit = hard block) over learned heuristics (historical dead zones) over an optimistic cold-start default.

Machine asleep = no runs. For overnight schedules on a laptop: `sudo pmset repeat wakeorpoweron MTWRFSU 06:55:00` (macOS) or `rtcwake` / a `WakeSystem=true` systemd timer (Linux).

## Commands

```
spareloop init                         detect CLIs, create data dir
spareloop add [flags]                  queue a task (--at | --asap | --spare-capacity)
spareloop list / show <id> / cancel <id> / run <id>
spareloop daemon install|uninstall|start|stop|status|logs|tick
spareloop daemon pause <tool> / resume <tool>
spareloop usage [--tool t] [--days n]  unified usage history
spareloop suggest [--verbose]          pattern analysis + recommendations
spareloop prewarm enable|disable|status
```

## Development

```bash
git clone https://github.com/VinayJogani14/spareloop && cd spareloop
npm install && npm test
SPARELOOP_HOME=/tmp/sl-dev node dist/src/cli/index.js init   # isolated sandbox
```

Contributions welcome — especially: Codex/Cursor rate-limit message corpora (the exact phrasings vary by version), a `spareloop watch` live TUI, OS notifications, and Windows Task Scheduler support.

## License

MIT © Vinay Jogani
