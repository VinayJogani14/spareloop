#!/usr/bin/env node
/**
 * Seeds a throwaway SPARELOOP_HOME with realistic synthetic usage history so
 * `spareloop predict` / `stats` / `suggest` have something real to show,
 * without touching the user's actual data. Used only to render demo.gif via
 * `vhs demo.tape` — not part of the published package.
 */
const path = require('path');
process.env.SPARELOOP_HOME = process.argv[2] || path.join(__dirname, '.demo-home');

const { getDb } = require('../dist/src/core/db');
const { insertUsageEvents, insertTask } = require('../dist/src/core/repo');
const { detectDailyWindow } = require('../dist/src/core/patterns/windowDetector');
const { computePrewarm, setPrewarmConfig } = require('../dist/src/core/patterns/prewarmComputer');

const db = getDb();
db.exec('DELETE FROM usage_events; DELETE FROM tasks; DELETE FROM task_runs; DELETE FROM learned_patterns; DELETE FROM suggestions;');

const now = new Date();
const events = [];

function mkEvent(at, overrides) {
  return {
    tool: 'claude',
    source: 'interactive',
    occurredAt: at.toISOString(),
    sessionId: null,
    costUsd: null,
    costUsdEstimated: false,
    inputTokens: 800 + Math.floor(Math.random() * 400),
    outputTokens: 400 + Math.floor(Math.random() * 300),
    cachedInputTokens: 0,
    rateLimitHit: false,
    rateLimitResetAt: null,
    rawRef: null,
    account: null,
    ...overrides,
  };
}

// 18 days of history: start ~09:47, exhaust ~11:17, reset ~15:45 (the author's real measured pattern).
for (let d = 18; d >= 1; d--) {
  const day = new Date(now);
  day.setDate(day.getDate() - d);
  const at = (h, m) => {
    const x = new Date(day);
    x.setHours(h, m, 0, 0);
    return x;
  };
  const jitter = () => Math.floor(Math.random() * 10) - 5;

  events.push(mkEvent(at(9, 47 + jitter())));
  events.push(mkEvent(at(10, 20)));
  events.push(mkEvent(at(10, 50)));
  const resetAt = at(15, 45);
  events.push({
    ...mkEvent(at(11, 17 + jitter())),
    rateLimitHit: true,
    rateLimitResetAt: resetAt.toISOString(),
    rawRef: "You've hit your session limit · resets 3:45pm",
  });
  // Some evening usage, contributing to the 20:00 peak hour.
  events.push(mkEvent(at(20, 5), { inputTokens: 3000, outputTokens: 1500 }));
  events.push(mkEvent(at(20, 30), { inputTokens: 3000, outputTokens: 1500 }));
}

// Today so far: window under way, ~65% into the typical exhaustion budget.
const todayStart = new Date(now);
todayStart.setHours(9, 47, 0, 0);
if (todayStart < now) {
  events.push(mkEvent(todayStart));
  events.push(mkEvent(new Date(todayStart.getTime() + 40 * 60000)));
}

insertUsageEvents(events);

// A couple of queued demo tasks so `list`/`status` have something to show.
insertTask({
  prompt: 'Add missing unit tests for src/utils/ and make them pass.',
  tool: 'claude',
  projectDir: process.cwd(),
  scheduleKind: 'spare_capacity',
  priority: 0,
  maxAttempts: 3,
});
insertTask({
  prompt: 'Upgrade minor-version dependencies and fix any breakage.',
  tool: 'claude',
  projectDir: process.cwd(),
  scheduleKind: 'explicit',
  scheduleAt: new Date(now.getTime() + 6 * 3600 * 1000).toISOString(),
  priority: 0,
  maxAttempts: 3,
});

// Precompute the pattern directly from the seeded data (do NOT run `daemon
// tick`/ingestInteractiveUsage for this — it reads the REAL ~/.claude
// session logs regardless of SPARELOOP_HOME, which would pollute the demo
// with whatever the current machine's actual usage happens to be).
const pattern = detectDailyWindow('claude', now);
const decision = computePrewarm(pattern);
if (decision.worthEnabling) {
  setPrewarmConfig('claude', { scheduledLocalTime: decision.proposedLocalTime });
}

console.log(`Seeded ${events.length} usage events into ${process.env.SPARELOOP_HOME}`);
console.log(`Pattern: start=${pattern.windowStartLocal} exhaustion=${pattern.windowExhaustionLocal} reset=${pattern.windowResetLocal} deadzone=${pattern.deadZoneMinutes}min`);
