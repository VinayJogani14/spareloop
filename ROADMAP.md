# Roadmap

## Shipped

- **v0.1** — queue + daemon (launchd/systemd/cron) + prewarm + pattern learning, Claude Code adapter
- **v0.2** — multi-account routing, task chains + session continuity, git-worktree isolation, saved profiles
- **v0.3** — burn-rate prediction, usage heatmap + waste report, threshold alerts, status-line integration
- **v0.4** — Codex CLI adapter fixed against a real install (see below), Cursor CLI adapter verified, per-account
  prewarm (each login gets its own learned pattern, not one blended across accounts), auto-commit of worktree
  changes (previously sat uncommitted — the review workflow was silently non-functional), morning report
  (`spareloop report`), pluggable memory providers via MCP (`spareloop memory`, Claude Code only so far),
  Slack/Discord webhook notifications, CSV/JSON export, `spareloop doctor`, `spareloop watch` live dashboard

### Real bugs found and fixed along the way (kept here for transparency)
- Codex CLI: `-a/--ask-for-approval` is rejected by `codex exec` (only valid on the top-level `codex` command);
  exec mode already defaults to `approval: never` since it's headless — removed the broken flag
- Codex CLI: `-s/--sandbox` is rejected by `exec resume` specifically (accepted by plain `exec`)
- Codex CLI: refuses non-git directories without `--skip-git-repo-check` — every task in a non-git dir was failing
- Worktree changes were never committed — `git diff`/`git log` against a task's branch showed nothing, and
  deleting a worktree would have silently discarded the agent's work
- A task pinned to a removed/renamed account retried silently every daemon tick forever instead of failing

## In progress / help wanted

- **Zep and Letta memory providers** — only Mem0 and Supermemory are in the registry so far; Zep's exact
  production MCP endpoint and Letta's official (vs. community) MCP server need pinning down
- **Mem0/Supermemory auth end-to-end** — the HTTP MCP transport mechanism is verified live; the provider-specific
  bearer-token handshake needs a real API key to confirm
- **Codex/Cursor adapters under real authenticated load** — flag shapes are verified against real installs, but
  neither has completed an authenticated round-trip in this project yet (no test accounts available)
- **Codex/Cursor per-invocation MCP injection** — Codex's MCP support is registration-based
  (`codex mcp add`); Cursor has no per-invocation MCP flag at all. Memory providers are Claude-only until this
  is resolved (or worked around).

## Not started

- Windows support (daemon currently targets launchd/systemd/cron only)
- Per-account capacity-aware task scheduling (prewarm is fully per-account; the general "is there capacity
  right now" gate that decides when to launch a queued task is still scoped to the default login — see the
  comment in `capacityPlanner.ts` for why)
- A Windows Task Scheduler daemon backend

Have a use case not listed here? Open an issue — [feature request](.github/ISSUE_TEMPLATE/feature-request.yml) template.
