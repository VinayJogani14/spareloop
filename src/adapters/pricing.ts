/**
 * Fallback per-million-token pricing used ONLY to estimate Codex CLI costs
 * (Codex reports tokens but no dollar figure). Values drift as vendors change
 * pricing — treat every number here as an estimate, and every derived cost is
 * flagged `cost_usd_estimated = 1` in the database.
 *
 * Override via ~/.local/share/spareloop/pricing.json:
 *   { "gpt-5-codex": { "inputPerM": 1.25, "outputPerM": 10 } }
 */
import * as fs from 'fs';
import * as path from 'path';
import { dataDir } from '../core/paths';

export interface ModelPricing {
  inputPerM: number;
  outputPerM: number;
  cachedInputPerM?: number;
}

const DEFAULTS: Record<string, ModelPricing> = {
  'gpt-5-codex': { inputPerM: 1.25, outputPerM: 10, cachedInputPerM: 0.125 },
  'gpt-5': { inputPerM: 1.25, outputPerM: 10, cachedInputPerM: 0.125 },
  'gpt-5-mini': { inputPerM: 0.25, outputPerM: 2, cachedInputPerM: 0.025 },
  default: { inputPerM: 1.25, outputPerM: 10 },
};

let cached: Record<string, ModelPricing> | null = null;

function table(): Record<string, ModelPricing> {
  if (cached) return cached;
  cached = { ...DEFAULTS };
  const overridePath = path.join(dataDir(), 'pricing.json');
  try {
    if (fs.existsSync(overridePath)) {
      Object.assign(cached, JSON.parse(fs.readFileSync(overridePath, 'utf8')));
    }
  } catch {
    // Bad override file: fall back to defaults rather than crashing the daemon.
  }
  return cached;
}

export function estimateCostUsd(
  model: string | null,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens: number
): number {
  const t = table();
  const p = (model && t[model]) || t['default'];
  const cachedRate = p.cachedInputPerM ?? p.inputPerM;
  const freshInput = Math.max(0, inputTokens - cachedInputTokens);
  return (
    (freshInput * p.inputPerM + cachedInputTokens * cachedRate + outputTokens * p.outputPerM) /
    1_000_000
  );
}
