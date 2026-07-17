#!/usr/bin/env node
import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { getDb, kvSet } from '../core/db';
import { daemonLogPath, dataDir, ensureDirs } from '../core/paths';
import { allAdapters, getAdapter, isToolName, rollingWindowAdapters } from '../adapters/registry';
import { isRollingWindowAdapter } from '../adapters/types';
import {
  getTask,
  insertTask,
  listRuns,
  listTasks,
  updateTaskStatus,
  usageEventsSince,
} from '../core/repo';
import { detectDailyWindow, latestPattern } from '../core/patterns/windowDetector';
import { computePrewarm, getPrewarmConfig, setPrewarmConfig, listPrewarmConfigs, acctFromKey } from '../core/patterns/prewarmComputer';
import { generateSuggestions } from '../core/patterns/suggestionEngine';
import { assessCapacity } from '../core/scheduler/capacityPlanner';
import { readDaemonPid, runDaemon, runSingleTick } from '../daemon/index';
import { successfulSessionId } from '../core/repo';
import { addAccount, envForAccount, getAccount, listAccounts, loginCommand, removeAccount } from '../core/accounts';
import { addProfile, getProfile, listProfiles, removeProfile } from '../core/profiles';
import { predictWindow, predictWeekly } from '../core/patterns/predictor';
import { computeHeatmap, computeWasteReport, renderHeatmapAscii } from '../core/patterns/heatmap';
import { renderOneLine } from '../core/statusLine';
import { runsSince } from '../core/repo';
import { diffStat, removeWorktree } from '../core/git';
import { cleanableWorktrees } from '../core/repo';
import { notify } from '../notify/index';
import { listMemoryProviders, getMemoryProvider, missingEnvFor, buildMemoryExtraArgs } from '../core/memory';
import { getWebhookUrl, setWebhookUrl, listWebhooks, WebhookChannel } from '../notify/webhookConfig';
import { sendWebhook } from '../notify/webhook';
import { toCsv, exportUsageEvents, exportTaskRuns } from '../core/exporter';
import { runDoctor } from '../core/doctor';
import { renderDashboard } from '../core/watch';
import { detectBackend, install, uninstall, Backend } from '../daemon/installers/index';
import { executeTask } from '../daemon/taskRunner';

const program = new Command();
program
  .name('spareloop')
  .description('Queue AI-CLI tasks for spare usage capacity, learn your daily window pattern, and prewarm resets so they land when you need them.')
  .version('0.4.0');

program
  .command('init')
  .description('Detect installed AI CLIs, create the spareloop data directory + database')
  .action(async () => {
    ensureDirs();
    getDb();
    console.log(`Data dir: ${dataDir()}\n`);
    for (const adapter of allAdapters()) {
      const det = await adapter.detectInstallation();
      const windowNote = isRollingWindowAdapter(adapter)
        ? '5h rolling window — prewarm applies'
        : 'monthly credit pool — no window, no prewarm';
      console.log(
        `  ${det.installed ? '[ok]' : '[--]'} ${adapter.tool.padEnd(7)} ${det.installed ? (det.version ?? 'installed') : 'not found on PATH'}  (${windowNote})`
      );
      if (det.note) console.log(`        ${det.note}`);
    }
    console.log('\nNext steps:');
    console.log('  spareloop add --tool claude --dir ~/myproject --prompt "..." --spare-capacity');
    console.log('  spareloop daemon install');
    console.log('  spareloop suggest   (after a few days of usage history)');
  });

program
  .command('add')
  .description('Queue a task to run unattended')
  .requiredOption('--prompt <text>', 'the task/instruction for the agent')
  .option('--tool <tool>', 'claude | codex | cursor (or supplied by --profile)')
  .option('--dir <path>', 'project directory to run in', process.cwd())
  .option('--model <model>', 'model override (tool default if omitted)')
  .option('--permission-mode <mode>', 'allowlist (safe default) | full_bypass', 'allowlist')
  .option('--at <datetime>', 'explicit run time (ISO or "HH:MM" for next occurrence)')
  .option('--asap', 'run as soon as there is capacity')
  .option('--spare-capacity', 'run whenever the system detects spare capacity')
  .option('--not-before <datetime>', 'earliest allowed time for asap/spare-capacity scheduling (ISO or "HH:MM")')
  .option('--not-after <datetime>', 'expire the task if not run by this time (ISO)')
  .option('--priority <n>', 'higher runs first', '0')
  .option('--max-attempts <n>', 'retry budget', '3')
  .option('--budget-usd <amount>', 'max spend for the run (enforced natively by Claude only)')
  .option('--account <name>', 'run under a registered account, or "auto" to route to whichever has capacity')
  .option('--after <task-id>', 'run only after that task succeeds (chain)')
  .option('--same-session', 'with --after: resume the dependency\'s session instead of starting fresh')
  .option('--continue-from <task-id>', 'resume the session of a previously completed task')
  .option('--instructions <text>', 'standing directions prepended to the prompt')
  .option('--instructions-file <path>', 'read --instructions from a file')
  .option('--no-branch', 'run directly in the working tree instead of an isolated git worktree branch')
  .option('--profile <name>', 'start from a saved profile (tool/dir/model/account/instructions)')
  .action((opts) => {
    const profile = opts.profile ? getProfile(opts.profile) : undefined;
    if (opts.profile && !profile) fail(`no profile named ${opts.profile}`);
    if (profile) {
      opts.tool = opts.tool ?? profile.tool;
      opts.dir = opts.dir === process.cwd() ? profile.project_dir : opts.dir;
      opts.model = opts.model ?? profile.model ?? undefined;
      opts.account = opts.account ?? profile.account ?? undefined;
      opts.instructions = opts.instructions ?? profile.instructions ?? undefined;
      if (profile.permission_mode === 'full_bypass' && opts.permissionMode === 'allowlist')
        opts.permissionMode = 'full_bypass';
    }
    if (!isToolName(opts.tool)) fail(`unknown tool: ${opts.tool} (expected claude|codex|cursor)`);
    if (opts.permissionMode !== 'allowlist' && opts.permissionMode !== 'full_bypass')
      fail('permission-mode must be allowlist or full_bypass');
    if (opts.account && opts.account !== 'auto' && !getAccount(opts.account))
      fail(`no account named ${opts.account} (register with: spareloop account add)`);
    if (opts.sameSession && !opts.after) fail('--same-session requires --after');

    let instructions: string | null = opts.instructions ?? null;
    if (opts.instructionsFile) {
      const p = path.resolve(opts.instructionsFile.replace(/^~/, process.env.HOME ?? '~'));
      if (!fs.existsSync(p)) fail(`instructions file not found: ${p}`);
      instructions = fs.readFileSync(p, 'utf8');
    }

    let dependsOn: string | null = null;
    if (opts.after) {
      const dep = getTask(opts.after);
      if (!dep) fail(`--after: no task matching ${opts.after}`);
      dependsOn = dep!.id;
    }
    let resumeSessionId: string | null = null;
    if (opts.continueFrom) {
      const src = getTask(opts.continueFrom);
      if (!src) fail(`--continue-from: no task matching ${opts.continueFrom}`);
      resumeSessionId = successfulSessionId(src!.id);
      if (!resumeSessionId) fail(`--continue-from: task ${opts.continueFrom} has no successful run with a session id`);
    }

    let scheduleKind: 'explicit' | 'spare_capacity' | 'asap' = 'asap';
    let scheduleAt: string | null = null;
    if (opts.at) {
      scheduleKind = 'explicit';
      scheduleAt = parseWhen(opts.at).toISOString();
    } else if (opts.spareCapacity) scheduleKind = 'spare_capacity';
    else if (opts.asap) scheduleKind = 'asap';

    const projectDir = path.resolve(opts.dir.replace(/^~/, process.env.HOME ?? '~'));
    if (!fs.existsSync(projectDir)) fail(`project dir does not exist: ${projectDir}`);

    let extraArgs: string[] | undefined;
    if (profile?.memory_provider) {
      if (!getAdapter(opts.tool).capabilities.supportsMemoryInjection) {
        fail(
          `profile "${opts.profile}" has memory provider "${profile.memory_provider}" configured, ` +
            `but ${opts.tool} doesn't support per-task MCP injection yet (only claude does currently)`
        );
      }
      const missing = missingEnvFor(profile.memory_provider);
      if (missing.length > 0) {
        console.log(
          `  warning: memory provider "${profile.memory_provider}" is missing env var(s): ${missing.join(', ')} — it will fail to authenticate.`
        );
      }
      extraArgs = buildMemoryExtraArgs(profile.memory_provider);
    }

    const id = insertTask({
      prompt: opts.prompt,
      tool: opts.tool,
      projectDir,
      model: opts.model ?? null,
      permissionMode: opts.permissionMode,
      extraArgs,
      scheduleKind,
      scheduleAt,
      notBefore: opts.notBefore ? parseWhen(opts.notBefore).toISOString() : null,
      notAfter: opts.notAfter ? parseWhen(opts.notAfter).toISOString() : null,
      priority: parseInt(opts.priority, 10),
      maxAttempts: parseInt(opts.maxAttempts, 10),
      budgetUsdCap: opts.budgetUsd ? parseFloat(opts.budgetUsd) : null,
      account: opts.account ?? null,
      dependsOn,
      sameSession: Boolean(opts.sameSession),
      instructions,
      resumeSessionId,
      profileId: profile?.id ?? null,
      branchMode: opts.branch === false ? 'none' : 'auto',
    });
    console.log(
      `Queued task ${id.slice(0, 8)} (${scheduleKind}${scheduleAt ? ` @ ${scheduleAt}` : ''}` +
        `${opts.account ? `, account=${opts.account}` : ''}${dependsOn ? `, after ${dependsOn.slice(0, 8)}` : ''})`
    );
    if (opts.permissionMode === 'full_bypass') {
      console.log('  note: full_bypass skips ALL permission checks — use only in repos you fully trust.');
    }
    if (!readDaemonPid()) {
      console.log('  daemon is not running — start it with: spareloop daemon install');
    }
  });

program
  .command('list')
  .description('List queued and recent tasks')
  .option('--status <status>')
  .option('--tool <tool>')
  .action((opts) => {
    const tasks = listTasks({ status: opts.status, tool: opts.tool });
    if (tasks.length === 0) return console.log('No tasks.');
    for (const t of tasks) {
      const when =
        t.schedule_kind === 'explicit' ? `@ ${t.schedule_at}` : `(${t.schedule_kind})`;
      console.log(
        `${t.id.slice(0, 8)}  ${t.status.padEnd(12)} ${t.tool.padEnd(7)} ${when.padEnd(28)} ${t.is_prewarm ? '[prewarm] ' : ''}${t.prompt.slice(0, 60)}`
      );
    }
  });

program
  .command('show <id>')
  .description('Show a task and its run history')
  .action((id) => {
    const t = getTask(id);
    if (!t) fail(`no task matching ${id}`);
    console.log(JSON.stringify(t, null, 2));
    const runs = listRuns(t!.id);
    if (runs.length) {
      console.log('\nRuns:');
      for (const r of runs) {
        console.log(
          `  #${r.attempt_number} ${r.outcome ?? 'running'} started=${r.started_at}` +
            (r.account ? ` account=${r.account}` : '') +
            (r.cost_usd != null ? ` cost=$${r.cost_usd}${r.cost_usd_estimated ? ' (est)' : ''}` : '') +
            (r.rate_limit_message ? ` rate_limit="${r.rate_limit_message}"` : '') +
            (r.error_message ? ` error="${String(r.error_message).slice(0, 120)}"` : '')
        );
        if (r.git_branch) {
          console.log(`     changes on branch ${r.git_branch} (worktree: ${r.worktree_path})`);
          console.log(`     review: cd ${t!.project_dir} && git diff main...${r.git_branch}`);
        }
      }
    }
  });

program
  .command('cancel <id>')
  .description('Cancel a queued task')
  .action((id) => {
    const t = getTask(id);
    if (!t) fail(`no task matching ${id}`);
    if (t!.status !== 'queued' && t!.status !== 'rate_limited')
      fail(`task is ${t!.status}; only queued/rate_limited tasks can be cancelled`);
    updateTaskStatus(t!.id, 'cancelled');
    console.log(`Cancelled ${t!.id.slice(0, 8)}`);
  });

program
  .command('run <id>')
  .description('Force-run a queued task now, in the foreground (debugging)')
  .action(async (id) => {
    const t = getTask(id);
    if (!t) fail(`no task matching ${id}`);
    const result = await executeTask(t!, (m) => console.log(m));
    console.log(`Outcome: ${result.outcomeKind}`);
  });

const account = program
  .command('account')
  .description('Manage multiple accounts (separate subscriptions, e.g. work + personal)');

account
  .command('add <name>')
  .description('Register an account with an isolated config dir (then: spareloop account login <name>)')
  .requiredOption('--tool <tool>', 'claude | codex')
  .action((name, opts) => {
    if (opts.tool !== 'claude' && opts.tool !== 'codex')
      fail('multi-account currently supports claude and codex (Cursor has no verified config-dir override)');
    const acct = addAccount(name, opts.tool);
    console.log(`Account "${acct.name}" registered (${acct.tool}, config dir ${acct.config_dir}).`);
    console.log(`Sign in with: spareloop account login ${acct.name}`);
    console.log('Note: use accounts you legitimately own — separate work/personal subscriptions.');
  });

account
  .command('login <name>')
  .description('Interactive sign-in for a registered account')
  .action((name) => {
    const acct = getAccount(name);
    if (!acct) fail(`no account named ${name}`);
    const { bin, args } = loginCommand(acct!);
    console.log(`Launching ${bin} ${args.join(' ')} for account "${name}"...`);
    const child = spawn(bin, args, {
      stdio: 'inherit',
      env: { ...process.env, ...envForAccount(acct!) },
    });
    child.on('close', (code) => process.exit(code ?? 0));
  });

account
  .command('list')
  .action(() => {
    const accts = listAccounts();
    if (accts.length === 0)
      return console.log('No accounts registered. Tasks use your default login.\nAdd one: spareloop account add work --tool claude');
    for (const a of accts) {
      console.log(`${a.name.padEnd(16)} ${a.tool.padEnd(7)} route-order=${a.route_order}  ${a.config_dir}`);
    }
  });

account
  .command('rm <name>')
  .description('Unregister an account (credentials on disk are left untouched)')
  .action((name) => {
    const referencing = getDb()
      .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE account = ? AND status IN ('queued','rate_limited')`)
      .get(name) as { n: number };
    if (referencing.n > 0) {
      console.log(
        `Warning: ${referencing.n} queued/rate-limited task(s) are pinned to account "${name}". ` +
          `After removal they will fail with "account not found" instead of running. ` +
          `Reassign them first (spareloop cancel <id> && re-add), or proceed if that's intended.`
      );
    }
    removeAccount(name);
    console.log(`Removed account "${name}" from spareloop. Its config dir was NOT deleted.`);
  });

const profileCmd = program.command('profile').description('Reusable task presets (tool + dir + account + instructions)');

profileCmd
  .command('add <name>')
  .requiredOption('--tool <tool>', 'claude | codex | cursor')
  .requiredOption('--dir <path>', 'project directory')
  .option('--model <model>')
  .option('--permission-mode <mode>', 'allowlist | full_bypass', 'allowlist')
  .option('--account <name>', 'account name or "auto"')
  .option('--instructions <text>', 'standing directions for every task using this profile')
  .option('--instructions-file <path>')
  .option('--memory <provider>', 'attach a memory provider (see: spareloop memory list) - claude only, for now')
  .action((name, opts) => {
    if (!isToolName(opts.tool)) fail(`unknown tool: ${opts.tool}`);
    let instructions = opts.instructions ?? null;
    if (opts.instructionsFile) {
      instructions = fs.readFileSync(path.resolve(opts.instructionsFile), 'utf8');
    }
    const dir = path.resolve(opts.dir.replace(/^~/, process.env.HOME ?? '~'));
    if (!fs.existsSync(dir)) fail(`project dir does not exist: ${dir}`);
    if (opts.account && opts.account !== 'auto' && !getAccount(opts.account))
      fail(`no account named ${opts.account}`);
    if (opts.memory) {
      if (!getMemoryProvider(opts.memory))
        fail(`unknown memory provider "${opts.memory}" (see: spareloop memory list)`);
      if (!getAdapter(opts.tool).capabilities.supportsMemoryInjection)
        fail(`${opts.tool} doesn't support per-task MCP injection yet (only claude does currently)`);
      const missing = missingEnvFor(opts.memory);
      if (missing.length > 0)
        console.log(`  warning: missing env var(s) for "${opts.memory}": ${missing.join(', ')} — set them before running tasks with this profile.`);
    }
    addProfile({
      name,
      tool: opts.tool,
      projectDir: dir,
      model: opts.model ?? null,
      permissionMode: opts.permissionMode,
      account: opts.account ?? null,
      instructions,
      memoryProvider: opts.memory ?? null,
    });
    console.log(`Profile "${name}" saved. Use it: spareloop add --profile ${name} --prompt "..."`);
  });

profileCmd
  .command('list')
  .action(() => {
    const profiles = listProfiles();
    if (profiles.length === 0) return console.log('No profiles saved.');
    for (const p of profiles) {
      console.log(
        `${p.name.padEnd(16)} ${p.tool.padEnd(7)} ${p.project_dir}` +
          `${p.account ? `  account=${p.account}` : ''}${p.model ? `  model=${p.model}` : ''}` +
          `${p.instructions ? '  [instructions]' : ''}${p.memory_provider ? `  memory=${p.memory_provider}` : ''}`
      );
    }
  });

profileCmd
  .command('rm <name>')
  .action((name) => {
    removeProfile(name);
    console.log(`Removed profile "${name}".`);
  });

const daemon = program.command('daemon').description('Manage the background scheduler');

daemon
  .command('install')
  .description('Install the daemon under launchd/systemd/cron and start it')
  .option('--backend <backend>', 'launchd | systemd | cron (auto-detected if omitted)')
  .action((opts) => {
    ensureDirs();
    getDb();
    const backend: Backend = opts.backend ?? detectBackend();
    console.log(install(backend));
    console.log('\nNote: the daemon only runs while this machine is awake. Laptop that sleeps at night?');
    console.log('  macOS:  sudo pmset repeat wakeorpoweron MTWRFSU 06:55:00');
    console.log('  Linux:  rtcwake, or a systemd timer with WakeSystem=true');
  });

daemon
  .command('uninstall')
  .description('Remove the OS-level daemon registration')
  .option('--backend <backend>')
  .action((opts) => {
    console.log(uninstall(opts.backend ?? detectBackend()));
  });

daemon
  .command('run')
  .description('Run the daemon in the foreground (used by launchd/systemd)')
  .action(async () => {
    await runDaemon();
  });

daemon
  .command('tick')
  .description('Single stateless scheduler pass (used by the cron backend)')
  .action(async () => {
    await runSingleTick();
  });

daemon
  .command('start')
  .description('Start the daemon detached (without OS-level install)')
  .action(() => {
    if (readDaemonPid()) return console.log('Daemon already running.');
    ensureDirs();
    const child = spawn(process.execPath, [process.argv[1], 'daemon', 'run'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    console.log(`Daemon started (pid ${child.pid}). It will not survive reboot — use "daemon install" for that.`);
  });

daemon
  .command('stop')
  .description('Stop a running daemon')
  .action(() => {
    const pid = readDaemonPid();
    if (!pid) return console.log('Daemon not running.');
    process.kill(pid, 'SIGTERM');
    console.log(`Sent SIGTERM to daemon (pid ${pid}).`);
  });

daemon
  .command('status')
  .description('Daemon liveness + per-tool capacity assessment')
  .action(() => {
    const pid = readDaemonPid();
    console.log(pid ? `Daemon running (pid ${pid})` : 'Daemon NOT running');
    for (const adapter of allAdapters()) {
      const v = assessCapacity(adapter);
      console.log(`  ${adapter.tool.padEnd(7)} capacity=${v.capacity.padEnd(16)} ${v.reason}`);
    }
  });

daemon
  .command('logs')
  .description('Print recent daemon log lines')
  .option('-n <lines>', 'lines to show', '50')
  .action((opts) => {
    try {
      const lines = fs.readFileSync(daemonLogPath(), 'utf8').trim().split('\n');
      console.log(lines.slice(-parseInt(opts.n, 10)).join('\n'));
    } catch {
      console.log('No daemon log yet.');
    }
  });

daemon
  .command('pause <tool>')
  .description('Pause launching tasks for a tool (esp. useful for Cursor, which has no quota signal)')
  .action((tool) => {
    if (!isToolName(tool)) fail(`unknown tool: ${tool}`);
    kvSet(`paused:${tool}`, '1');
    console.log(`Paused ${tool}.`);
  });

daemon
  .command('resume <tool>')
  .description('Resume launching tasks for a tool')
  .action((tool) => {
    if (!isToolName(tool)) fail(`unknown tool: ${tool}`);
    kvSet(`paused:${tool}`, '0');
    console.log(`Resumed ${tool}.`);
  });

program
  .command('usage')
  .description('Usage history summary from the unified timeline')
  .option('--tool <tool>')
  .option('--days <n>', 'lookback days', '21')
  .action((opts) => {
    const since = new Date(Date.now() - parseInt(opts.days, 10) * 24 * 3600 * 1000).toISOString();
    const tools = opts.tool ? [opts.tool] : ['claude', 'codex', 'cursor'];
    for (const tool of tools) {
      if (!isToolName(tool)) continue;
      const events = usageEventsSince(tool, since);
      if (events.length === 0) {
        console.log(`${tool}: no usage events recorded`);
        continue;
      }
      const cost = events.reduce((s, e) => s + (e.cost_usd ?? 0), 0);
      const inTok = events.reduce((s, e) => s + (e.input_tokens ?? 0), 0);
      const outTok = events.reduce((s, e) => s + (e.output_tokens ?? 0), 0);
      const hits = events.filter((e) => e.rate_limit_hit === 1).length;
      console.log(
        `${tool}: ${events.length} events | ~$${cost.toFixed(2)} | ${inTok.toLocaleString()} in / ${outTok.toLocaleString()} out tokens | ${hits} rate-limit hit(s)`
      );
    }
  });

program
  .command('suggest')
  .description('Analyze usage patterns and print optimization suggestions')
  .option('--verbose', 'include per-day observations')
  .action((opts) => {
    for (const adapter of rollingWindowAdapters()) {
      const label = adapter.tool === 'claude' ? 'Claude Code' : 'Codex CLI';
      const logins: Array<string | null> = [null, ...listAccounts(adapter.tool).map((a) => a.name)];
      for (const account of logins) {
        const pattern = detectDailyWindow(adapter.tool, new Date(), account);
        const who = account ? `${label} (${account})` : label;
        console.log(`\n${who} — usage pattern (21-day lookback, ${pattern.sampleDays} day(s) with limit hits, confidence ${confidenceWord(pattern.confidence)})`);
        if (pattern.windowStartLocal == null) {
          console.log('  No usage history yet. Use the tool normally (or run queued tasks) and check back.');
          continue;
        }
        console.log(`  Typical start:      ${pattern.windowStartLocal}`);
        console.log(`  Typical exhaustion: ${pattern.windowExhaustionLocal ?? 'never observed hitting the limit'}`);
        console.log(`  Window reset:       ${pattern.windowResetLocal ?? '-'}`);
        if (pattern.deadZoneMinutes != null)
          console.log(`  Daily dead zone:    ~${pattern.deadZoneMinutes} min`);

        const suggestions = generateSuggestions(pattern);
        if (suggestions.length > 0) {
          console.log('  Suggestions:');
          suggestions.forEach((s, i) => console.log(`   ${i + 1}. [${s.kind}] ${s.message}`));
        } else {
          const decision = computePrewarm(pattern);
          console.log(`  ${decision.reason}`);
        }
        if (opts.verbose) {
          console.log('  Observations:');
          for (const o of pattern.observations) {
            console.log(`    ${o.day}: start=${o.windowStartMin}min exhaust=${o.exhaustionMin ?? '-'} reset=${o.resetMin ?? '-'} w=${o.weight.toFixed(2)}`);
          }
        }
      }
    }
    console.log('\nCursor — monthly credit pool; no rolling-window pattern applies (run counts tracked, see: spareloop usage --tool cursor)');
  });

program
  .command('report')
  .description('Summary of what ran recently (default: last 12h) - the morning-after report')
  .option('--hours <n>', 'lookback window in hours', '12')
  .option('--notify', 'also send an OS notification with the summary')
  .action((opts) => {
    const hours = parseInt(opts.hours, 10);
    const runs = runsSince(hours).filter((r) => !r.is_prewarm);
    if (runs.length === 0) {
      console.log(`No tasks ran in the last ${hours}h.`);
      return;
    }

    const succeeded = runs.filter((r) => r.outcome === 'success');
    const failed = runs.filter((r) => r.outcome === 'failure' || r.outcome === 'timeout');
    const rateLimited = runs.filter((r) => r.outcome === 'rate_limited');
    const totalCost = runs.reduce((s, r) => s + (r.cost_usd ?? 0), 0);
    const anyEstimated = runs.some((r) => r.cost_usd != null && r.cost_usd_estimated === 1);

    console.log(
      `\nLast ${hours}h: ${succeeded.length} succeeded, ${failed.length} failed, ${rateLimited.length} rate-limited` +
        (totalCost > 0 ? ` — ~$${totalCost.toFixed(4)}${anyEstimated ? ' (includes estimates)' : ''}` : '')
    );

    for (const r of runs) {
      const when = r.started_at.replace('T', ' ').slice(0, 16);
      const acct = r.account ? `@${r.account}` : '';
      const head = `\n[${r.outcome ?? 'running'}] ${when} ${r.tool}${acct} — ${r.prompt.slice(0, 70)}`;
      console.log(head);
      if (r.cost_usd != null) console.log(`  cost: $${r.cost_usd.toFixed(4)}${r.cost_usd_estimated ? ' (est)' : ''}`);
      if (r.outcome === 'success' && r.git_branch) {
        const stat = diffStat(r.project_dir, r.git_branch);
        if (stat) {
          console.log(`  changes (${r.git_branch}):`);
          stat.split('\n').forEach((line) => console.log(`    ${line}`));
          console.log(`  review: cd ${r.project_dir} && git diff HEAD...${r.git_branch}`);
        } else {
          console.log(`  branch ${r.git_branch}: no diff against HEAD (or repo/branch no longer available)`);
        }
      }
      if (r.outcome === 'rate_limited' && r.rate_limit_message) {
        console.log(`  rate limit: ${r.rate_limit_message.slice(0, 150)}`);
      }
      if ((r.outcome === 'failure' || r.outcome === 'timeout') && r.error_message) {
        console.log(`  error: ${r.error_message.slice(0, 200)}`);
      }
    }

    if (opts.notify) {
      notify(
        'spareloop: morning report',
        `${succeeded.length} succeeded, ${failed.length} failed, ${rateLimited.length} rate-limited in the last ${hours}h`
      );
    }
  });

program
  .command('predict')
  .description('Forecast when you\'ll hit your window (and rough weekly pace)')
  .option('--tool <tool>')
  .action((opts) => {
    const tools = opts.tool ? [opts.tool] : ['claude', 'codex'];
    for (const tool of tools) {
      if (!isToolName(tool)) continue;
      if (!getAdapter(tool).capabilities.hasRollingWindow) continue;
      const label = tool === 'claude' ? 'Claude Code' : 'Codex CLI';
      const w = predictWindow(tool);
      console.log(`\n${label}`);
      if (!w.hasData) {
        console.log(`  ${w.reason}`);
      } else if (w.etaMinutes == null) {
        console.log(`  ${w.reason}`);
      } else if (w.etaMinutes === 0) {
        console.log(`  ⚠ ${w.reason}`);
      } else {
        const eta = new Date(w.etaAt!);
        console.log(`  ${w.reason}`);
        console.log(`  Projected wall: ~${eta.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} (confidence ${confidenceWord(w.confidence)})`);
      }
      const weekly = predictWeekly(tool);
      if (weekly.hasData && weekly.projectedWeekCostUsd != null) {
        console.log(
          `  Weekly pace: $${(weekly.costUsdSoFar ?? 0).toFixed(2)} so far -> projected ~$${weekly.projectedWeekCostUsd.toFixed(2)} by week's end (naive same-pace projection)`
        );
      }
    }
  });

program
  .command('stats')
  .description('Peak/quiet-hour heatmap and a waste report (unused window-hours, dead-zone hours lost)')
  .option('--tool <tool>')
  .option('--days <n>', 'lookback days', '21')
  .action((opts) => {
    const tools = opts.tool ? [opts.tool] : ['claude', 'codex', 'cursor'];
    for (const tool of tools) {
      if (!isToolName(tool)) continue;
      const hm = computeHeatmap(tool, parseInt(opts.days, 10));
      const totalEvents = hm.cells.flat().reduce((s, c) => s + c.events, 0);
      console.log(`\n${tool} — usage heatmap (${hm.lookbackDays}-day lookback, ${totalEvents} events)`);
      if (totalEvents === 0) {
        console.log('  No usage recorded yet.');
        continue;
      }
      console.log(renderHeatmapAscii(hm));
      if (hm.peakHour) {
        console.log(`  Peak hour: ${String(hm.peakHour.hour).padStart(2, '0')}:00 (${hm.peakHour.tokens.toLocaleString()} tokens)`);
      }
      if (hm.quietHours.length > 0) {
        console.log(`  Quiet hours: ${hm.quietHours.map((h) => `${String(h).padStart(2, '0')}:00`).join(', ')}`);
      }
      const waste = computeWasteReport(tool, 7);
      console.log(
        `  Waste report (last ${waste.lookbackDays}d): ${waste.windowHoursUnused}h of ${waste.windowHoursAvailable}h unused` +
          (waste.deadZoneHoursLost > 0 ? `, ~${waste.deadZoneHoursLost.toFixed(1)}h/week lost to dead zones` : '')
      );
    }
  });

program
  .command('status')
  .description('Compact status line (for Claude Code statusLine, tmux, or a shell prompt)')
  .requiredOption('--tool <tool>', 'claude | codex | cursor')
  .option('--oneline', 'force single-line output (default)')
  .action((opts) => {
    if (!isToolName(opts.tool)) fail(`unknown tool: ${opts.tool}`);
    console.log(renderOneLine(opts.tool));
  });

const memoryCmd = program
  .command('memory')
  .description('Pluggable memory-provider integration (MCP) for cross-session recall — opt-in, per profile');

memoryCmd
  .command('list')
  .description('Available memory providers and what they need')
  .action(() => {
    console.log('Only Claude Code supports per-task MCP injection currently (verified via --mcp-config).\n');
    for (const p of listMemoryProviders()) {
      const missing = missingEnvFor(p.name);
      console.log(`${p.name.padEnd(14)} ${p.label}`);
      console.log(`  needs: ${p.requiredEnv.join(', ')}${missing.length > 0 ? `  (missing: ${missing.join(', ')})` : '  (all set)'}`);
      console.log(`  ${p.notes}`);
      console.log(`  use it: spareloop profile add <name> --tool claude --dir <path> --memory ${p.name}\n`);
    }
  });

memoryCmd
  .command('status')
  .description('Which profiles have a memory provider attached')
  .action(() => {
    const withMemory = listProfiles().filter((p) => p.memory_provider);
    if (withMemory.length === 0) return console.log('No profiles have a memory provider attached.');
    for (const p of withMemory) {
      const missing = missingEnvFor(p.memory_provider!);
      console.log(`${p.name.padEnd(16)} ${p.memory_provider}${missing.length > 0 ? `  MISSING ENV: ${missing.join(', ')}` : '  ok'}`);
    }
  });

program
  .command('watch')
  .description('Live-updating dashboard: window burn rate, queue status, active tasks, recent activity')
  .option('--interval <seconds>', 'refresh interval', '2')
  .action((opts) => {
    const intervalMs = Math.max(1000, parseFloat(opts.interval) * 1000);
    const isTty = process.stdout.isTTY;
    const draw = () => {
      const frame = renderDashboard();
      if (isTty) {
        process.stdout.write('\x1b[2J\x1b[H'); // clear screen, cursor home
      } else {
        console.log('\n' + '='.repeat(70));
      }
      console.log(frame);
    };
    draw();
    const timer = setInterval(draw, intervalMs);
    process.on('SIGINT', () => {
      clearInterval(timer);
      if (isTty) process.stdout.write('\x1b[?25h'); // ensure cursor visible on exit
      process.exit(0);
    });
  });

program
  .command('clean')
  .description('Remove disk-space-consuming worktrees for finished tasks (never touches git branches/history)')
  .option('--older-than <days>', 'only clean worktrees whose last run ended more than this many days ago', '3')
  .option('--yes', 'actually remove (default is a dry-run listing)')
  .action((opts) => {
    const candidates = cleanableWorktrees(parseInt(opts.olderThan, 10));
    if (candidates.length === 0) return console.log('Nothing to clean.');
    if (!opts.yes) {
      console.log(`Would remove ${candidates.length} worktree(s) (branches are kept — this only frees disk space):\n`);
      for (const c of candidates) {
        console.log(`  ${c.task_id.slice(0, 8)} [${c.task_status}] ${c.git_branch} — ${c.worktree_path}`);
      }
      console.log(`\nRe-run with --yes to actually remove them. The branch stays reachable: git checkout <branch>.`);
      return;
    }
    let removed = 0;
    for (const c of candidates) {
      if (removeWorktree(c.worktree_path, c.project_dir)) {
        removed++;
        console.log(`  removed ${c.worktree_path}`);
      } else {
        console.log(`  failed to remove ${c.worktree_path} (project dir may no longer exist)`);
      }
    }
    console.log(`\nRemoved ${removed}/${candidates.length} worktree(s). Branches are untouched.`);
  });

program
  .command('doctor')
  .description('Diagnose daemon health, account/tool setup, and misconfigured tasks')
  .action(async () => {
    const { checks } = await runDoctor();
    const icon = { ok: '✔', warn: '⚠', error: '✖' };
    for (const c of checks) console.log(`${icon[c.status]} ${c.message}`);
    const errors = checks.filter((c) => c.status === 'error').length;
    const warns = checks.filter((c) => c.status === 'warn').length;
    console.log(`\n${errors} error(s), ${warns} warning(s)`);
    if (errors > 0) process.exitCode = 1;
  });

program
  .command('export')
  .description('Export usage/task history as CSV or JSON — survives whatever local log retention the underlying tool has')
  .option('--what <what>', 'usage | tasks', 'usage')
  .option('--format <format>', 'csv | json', 'csv')
  .option('--tool <tool>')
  .option('--days <n>', 'lookback days', '30')
  .option('--out <path>', 'write to a file instead of stdout')
  .action((opts) => {
    if (opts.what !== 'usage' && opts.what !== 'tasks') fail('--what must be usage or tasks');
    if (opts.format !== 'csv' && opts.format !== 'json') fail('--format must be csv or json');
    const filter = { tool: opts.tool, days: parseInt(opts.days, 10) };
    const rows = opts.what === 'usage' ? exportUsageEvents(filter) : exportTaskRuns(filter);
    const output = opts.format === 'csv' ? toCsv(rows) : JSON.stringify(rows, null, 2);
    if (opts.out) {
      fs.writeFileSync(path.resolve(opts.out), output);
      console.error(`Wrote ${rows.length} row(s) to ${opts.out}`);
    } else {
      process.stdout.write(output);
    }
  });

const notifyCmd = program.command('notify').description('Configure notification channels');
const webhookCmd = notifyCmd.command('webhook').description('Slack/Discord incoming-webhook forwarding');

webhookCmd
  .command('set <channel> <url>')
  .description('Set the incoming-webhook URL for slack or discord')
  .action((channel, url) => {
    if (channel !== 'slack' && channel !== 'discord') fail('channel must be slack or discord');
    setWebhookUrl(channel as WebhookChannel, url);
    console.log(`${channel} webhook configured. Task completions, failures, and burn-rate alerts will now also post there.`);
  });

webhookCmd
  .command('unset <channel>')
  .action((channel) => {
    if (channel !== 'slack' && channel !== 'discord') fail('channel must be slack or discord');
    setWebhookUrl(channel as WebhookChannel, null);
    console.log(`${channel} webhook removed.`);
  });

webhookCmd
  .command('status')
  .action(() => {
    for (const { channel, url } of listWebhooks()) {
      console.log(`${channel.padEnd(8)} ${url ? 'configured' : 'not configured'}`);
    }
  });

webhookCmd
  .command('test <channel>')
  .action(async (channel) => {
    if (channel !== 'slack' && channel !== 'discord') fail('channel must be slack or discord');
    if (!getWebhookUrl(channel as WebhookChannel)) fail(`${channel} webhook not configured — set it first: spareloop notify webhook set ${channel} <url>`);
    const ok = await sendWebhook(channel as WebhookChannel, 'spareloop: test notification', 'If you can see this, the webhook is working.');
    console.log(ok ? `Sent — check ${channel}.` : `Failed to send — check the URL is a valid incoming webhook.`);
  });

const prewarm = program.command('prewarm').description('Manage window-prewarm scheduling');

prewarm
  .command('enable')
  .description('Enable daily prewarm for a rolling-window tool (default login, or one registered account)')
  .requiredOption('--tool <tool>', 'claude | codex')
  .option('--account <name>', 'registered account name (omit for the default login)')
  .option('--time <HH:MM>', 'manual fire time (skips auto-convergence)')
  .action((opts) => {
    if (opts.tool !== 'claude' && opts.tool !== 'codex')
      fail('prewarm only applies to rolling-window tools: claude, codex (Cursor has a monthly credit pool)');
    const account: string | null = opts.account ?? null;
    if (account && !getAccount(account)) fail(`no account named ${account}`);
    let time: string | null = opts.time ?? null;
    let manual = Boolean(opts.time);
    if (!time) {
      const pattern = latestPattern(opts.tool, account) ?? detectDailyWindow(opts.tool, new Date(), account);
      const decision = computePrewarm(pattern);
      if (!decision.worthEnabling || !decision.proposedLocalTime) {
        fail(`${decision.reason}\nYou can force a time manually: spareloop prewarm enable --tool ${opts.tool}${account ? ` --account ${account}` : ''} --time 07:05`);
      }
      time = decision.proposedLocalTime!;
    }
    setPrewarmConfig(opts.tool, account, { enabled: true, scheduledLocalTime: time, manualOverride: manual });
    console.log(`Prewarm enabled for ${opts.tool}${account ? ` (${account})` : ''} at ${time}${manual ? ' (manual override — will not auto-adjust)' : ' (auto-converges as your pattern shifts)'}`);
    if (!readDaemonPid()) console.log('Daemon is not running — prewarm fires from the daemon: spareloop daemon install');
  });

prewarm
  .command('disable')
  .requiredOption('--tool <tool>')
  .option('--account <name>', 'registered account name (omit for the default login)')
  .action((opts) => {
    if (opts.tool !== 'claude' && opts.tool !== 'codex') fail('tool must be claude or codex');
    const account: string | null = opts.account ?? null;
    setPrewarmConfig(opts.tool, account, { enabled: false });
    console.log(`Prewarm disabled for ${opts.tool}${account ? ` (${account})` : ''}.`);
  });

prewarm
  .command('status')
  .action(() => {
    for (const tool of ['claude', 'codex'] as const) {
      const configs = listPrewarmConfigs(tool);
      const logins: Array<string | null> = [null, ...listAccounts(tool).map((a) => a.name)];
      for (const account of logins) {
        const label = account ? `${tool} (${account})` : tool;
        const cfg = configs.find((c) => acctFromKey(c.account) === account);
        if (!cfg || cfg.enabled !== 1) {
          console.log(`${label}: disabled`);
          continue;
        }
        console.log(
          `${label}: enabled @ ${cfg.scheduled_local_time}${cfg.manual_override ? ' (manual)' : ' (auto)'}${cfg.last_fired_at ? `, last fired ${cfg.last_fired_at}` : ', never fired yet'}`
        );
      }
    }
  });

function parseWhen(input: string): Date {
  if (/^\d{1,2}:\d{2}$/.test(input)) {
    const [h, m] = input.split(':').map(Number);
    const d = new Date();
    d.setHours(h, m, 0, 0);
    if (d <= new Date()) d.setDate(d.getDate() + 1);
    return d;
  }
  const d = new Date(input);
  if (isNaN(d.getTime())) fail(`could not parse time: ${input}`);
  return d;
}

function confidenceWord(c: number): string {
  if (c >= 0.8) return 'high';
  if (c >= 0.4) return 'medium';
  return 'low';
}

function fail(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

program.parseAsync(process.argv).catch((err) => {
  console.error(`error: ${(err as Error).message}`);
  process.exit(1);
});
