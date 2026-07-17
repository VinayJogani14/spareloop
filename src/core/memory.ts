/**
 * Pluggable memory-provider integration: injects an MCP server config into a
 * single headless invocation so a queued task can recall/store context
 * across sessions via a third-party memory layer (Mem0, Supermemory, etc),
 * on top of the native session-resume continuity already built into chains.
 *
 * Scope, honestly stated: only Claude Code's `--mcp-config` was verified live
 * (both stdio and HTTP transport - see adapters/claude.ts). Codex and Cursor
 * are excluded via ToolCapabilities.supportsMemoryInjection until their MCP
 * story is verified the same way.
 *
 * Never auto-runs anything without the user's own credentials: each provider
 * declares the env vars it needs, and spareloop refuses to attach it to a
 * task until they're present.
 */

export interface MemoryProviderDef {
  name: string;
  label: string;
  url: string;
  requiredEnv: string[];
  authHeader: (env: NodeJS.ProcessEnv) => Record<string, string>;
  /** What was actually verified vs. just documented - read before trusting this in production. */
  notes: string;
}

export const MEMORY_PROVIDERS: Record<string, MemoryProviderDef> = {
  mem0: {
    name: 'mem0',
    label: 'Mem0 (hosted)',
    url: 'https://mcp.mem0.ai/mcp',
    requiredEnv: ['MEM0_API_KEY'],
    authHeader: (env) => ({ Authorization: `Bearer ${env.MEM0_API_KEY ?? ''}` }),
    notes:
      'The HTTP MCP transport mechanism itself is verified live (a real HTTP MCP server was ' +
      'successfully connected via --mcp-config against Claude Code). The Mem0-specific bearer-token ' +
      'auth handshake was NOT verified end-to-end - that needs a real MEM0_API_KEY to confirm.',
  },
  supermemory: {
    name: 'supermemory',
    label: 'Supermemory (hosted)',
    url: 'https://mcp.supermemory.ai/mcp',
    requiredEnv: ['SUPERMEMORY_API_KEY'],
    authHeader: (env) => ({ Authorization: `Bearer ${env.SUPERMEMORY_API_KEY ?? ''}` }),
    notes:
      'Same HTTP transport mechanism as mem0. Supermemory normally onboards via OAuth through their ' +
      'own install-mcp CLI rather than a static bearer token - this header-based auth is best-effort ' +
      'and may need adjustment; please report back if it needs a different auth shape.',
  },
};

export function listMemoryProviders(): MemoryProviderDef[] {
  return Object.values(MEMORY_PROVIDERS);
}

export function getMemoryProvider(name: string): MemoryProviderDef | undefined {
  return MEMORY_PROVIDERS[name];
}

export function missingEnvFor(providerName: string): string[] {
  const def = getMemoryProvider(providerName);
  if (!def) return [];
  return def.requiredEnv.filter((k) => !process.env[k]);
}

/**
 * Build the `--mcp-config` argument pair for a task's extraArgs. Caller is
 * responsible for checking missingEnvFor() first and deciding whether to
 * proceed with a warning or refuse - this always returns something (with an
 * empty/placeholder token if env is missing) rather than throwing, since a
 * scheduled task should fail loudly through its own run() error path, not a
 * silent CLI-time crash.
 */
export function buildMemoryExtraArgs(providerName: string): string[] {
  const def = MEMORY_PROVIDERS[providerName];
  if (!def) throw new Error(`unknown memory provider: ${providerName}`);
  const config = {
    mcpServers: {
      [def.name]: {
        type: 'http',
        url: def.url,
        headers: def.authHeader(process.env),
      },
    },
  };
  return ['--mcp-config', JSON.stringify(config)];
}
