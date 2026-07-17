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
import { computePrewarm, getPrewarmConfig, setPrewarmConfig } from '../core/patterns/prewarmComputer';
import { generateSuggestions } from '../core/patterns/suggestionEngine';
import { assessCapacity } from '../core/scheduler/capacityPlanner';
import { readDaemonPid, runDaemon, runSingleTick } from '../daemon/index';
import { successfulSessionId } from '../core/repo';
import { addAccount, envForAccount, getAccount, listAccounts, loginCommand, removeAccount } from '../core/accounts';
import { addProfile, getProfile, listProfiles, removeProfile } from '../core/profiles';
import { detectBackend, install, uninstall, Backend } from '../daemon/installers/index';
import { executeTask } from '../daemon/taskRunner';

const program = new Command();
program
  .name('spareloop')
  .description('Queue AI-CLI tasks for spare usage capacity, learn your daily window pattern, and prewarm resets so they land when you need them.')
  .version('0.1.0');

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

    const id = insertTask({
      prompt: opts.prompt,
      tool: opts.tool,
      projectDir,
      model: opts.model ?? null,
      permissionMode: opts.permissionMode,
      scheduleKind,
      scheduleAt,
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
    addProfile({
      name,
      tool: opts.tool,
      projectDir: dir,
      model: opts.model ?? null,
      permissionMode: opts.permissionMode,
      account: opts.account ?? null,
      instructions,
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
          `${p.instructions ? '  [instructions]' : ''}`
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
      const pattern = detectDailyWindow(adapter.tool);
      const label = adapter.tool === 'claude' ? 'Claude Code' : 'Codex CLI';
      console.log(`\n${label} — usage pattern (21-day lookback, ${pattern.sampleDays} day(s) with limit hits, confidence ${confidenceWord(pattern.confidence)})`);
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
    console.log('\nCursor — monthly credit pool; no rolling-window pattern applies (run counts tracked, see: spareloop usage --tool cursor)');
  });

const prewarm = program.command('prewarm').description('Manage window-prewarm scheduling');

prewarm
  .command('enable')
  .description('Enable daily prewarm for a rolling-window tool')
  .requiredOption('--tool <tool>', 'claude | codex')
  .option('--time <HH:MM>', 'manual fire time (skips auto-convergence)')
  .action((opts) => {
    if (opts.tool !== 'claude' && opts.tool !== 'codex')
      fail('prewarm only applies to rolling-window tools: claude, codex (Cursor has a monthly credit pool)');
    let time: string | null = opts.time ?? null;
    let manual = Boolean(opts.time);
    if (!time) {
      const pattern = latestPattern(opts.tool) ?? detectDailyWindow(opts.tool);
      const decision = computePrewarm(pattern);
      if (!decision.worthEnabling || !decision.proposedLocalTime) {
        fail(`${decision.reason}\nYou can force a time manually: spareloop prewarm enable --tool ${opts.tool} --time 07:05`);
      }
      time = decision.proposedLocalTime!;
    }
    setPrewarmConfig(opts.tool, { enabled: true, scheduledLocalTime: time, manualOverride: manual });
    console.log(`Prewarm enabled for ${opts.tool} at ${time}${manual ? ' (manual override — will not auto-adjust)' : ' (auto-converges as your pattern shifts)'}`);
    if (!readDaemonPid()) console.log('Daemon is not running — prewarm fires from the daemon: spareloop daemon install');
  });

prewarm
  .command('disable')
  .requiredOption('--tool <tool>')
  .action((opts) => {
    if (opts.tool !== 'claude' && opts.tool !== 'codex') fail('tool must be claude or codex');
    setPrewarmConfig(opts.tool, { enabled: false });
    console.log(`Prewarm disabled for ${opts.tool}.`);
  });

prewarm
  .command('status')
  .action(() => {
    for (const tool of ['claude', 'codex'] as const) {
      const cfg = getPrewarmConfig(tool);
      if (!cfg || cfg.enabled !== 1) {
        console.log(`${tool}: disabled`);
        continue;
      }
      console.log(
        `${tool}: enabled @ ${cfg.scheduled_local_time}${cfg.manual_override ? ' (manual)' : ' (auto)'}${cfg.last_fired_at ? `, last fired ${cfg.last_fired_at}` : ', never fired yet'}`
      );
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
