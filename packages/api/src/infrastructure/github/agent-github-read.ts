import { isAbsolute } from 'node:path';
import { GhReadExecution, ghReadFailure } from './agent-github-read-execution.js';
import { GhReadError, type GhReadRunner, runGhReadProcess } from './agent-github-read-process.js';
import {
  GH_READ_HEAD_FIELDS,
  type GhReadFailure,
  type GhReadQuery,
  type GhReadResult,
  ghReadArgs,
  ghReadHeadSchema,
  ghReadQuerySchema,
  ghReadSourceUrl,
  projectGhRead,
} from './agent-github-read-schema.js';

export type { GhReadQuery, GhReadResult } from './agent-github-read-schema.js';

/** Host-owned authority; never deserialize it from a carrier request. */
export interface GhReadAuthority {
  readonly repositories: readonly string[];
  readonly signal: AbortSignal;
  /** Revalidate the canonical child before/after every subprocess, including head probes. */
  readonly validate?: () => Promise<boolean>;
}
export interface AgentGitHubReaderOptions {
  readonly ghPath: string;
  readonly cwd: string;
  readonly baseEnv: NodeJS.ProcessEnv;
  readonly runner?: GhReadRunner;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

function admissionFailure(repo: string, authority?: GhReadAuthority, signal?: AbortSignal): GhReadFailure | undefined {
  if (!authority) return 'capability_unavailable';
  if (authority.signal.aborted) return 'invocation_ended';
  if (!authority.repositories.includes(repo)) return 'scope_denied';
  if (signal?.aborted) return 'cancelled';
  return undefined;
}

async function readQuery(query: GhReadQuery, execution: GhReadExecution): Promise<GhReadResult> {
  const readHead = async () =>
    ghReadHeadSchema.parse(
      JSON.parse(
        await execution.execute([
          'pr',
          'view',
          String('number' in query ? query.number : ''),
          '--repo',
          `github.com/${query.repo}`,
          '--json',
          GH_READ_HEAD_FIELDS,
        ]),
      ),
    );
  const pin = query.op === 'pr_diff' || query.op === 'pr_checks' ? await readHead() : undefined;
  const stdout = await execution.execute(ghReadArgs(query), query.op === 'pr_checks');
  const result = projectGhRead(query, stdout);
  if (pin) {
    const after = await readHead();
    if (pin.headRefOid !== after.headRefOid || pin.baseRefOid !== after.baseRefOid) throw new GhReadError('stale_head');
  }
  await execution.validateActive();
  const headSha = pin ? pin.headRefOid : result.headSha;
  return {
    ok: true,
    data: result.data,
    provenance: {
      repository: query.repo,
      operation: query.op,
      observedAt: new Date().toISOString(),
      sourceUrl: ghReadSourceUrl(query),
      truncated: result.truncated,
      ...(headSha ? { headSha } : {}),
    },
  };
}

function bounded(value: number | undefined, maximum: number): number {
  return value === undefined ? maximum : Math.max(1, Math.min(Number.isFinite(value) ? value : maximum, maximum));
}

/** Eight fixed reads, one total deadline, bounded output and no shell interpolation. */
export function createAgentGitHubReader(input: AgentGitHubReaderOptions) {
  const options = {
    ...input,
    baseEnv: { ...input.baseEnv },
    runner: input.runner ?? runGhReadProcess,
    timeoutMs: bounded(input.timeoutMs, 15_000),
    maxOutputBytes: bounded(input.maxOutputBytes, 1_048_576),
  };
  const validPaths = isAbsolute(options.ghPath) && isAbsolute(options.cwd);
  const active = new WeakMap<GhReadAuthority, number>();
  return async (
    input: unknown,
    authority?: GhReadAuthority,
    request: { signal?: AbortSignal } = {},
  ): Promise<GhReadResult> => {
    const parsed = ghReadQuerySchema.safeParse(input);
    if (!parsed.success) return ghReadFailure('unsupported_query');
    const denied = admissionFailure(parsed.data.repo, authority, request.signal);
    if (denied) return ghReadFailure(denied);
    if (!authority || !validPaths) return ghReadFailure('capability_unavailable');
    const running = active.get(authority) ?? 0;
    if (running >= 2) return ghReadFailure('unavailable');
    active.set(authority, running + 1);
    let execution: GhReadExecution | undefined;
    try {
      execution = new GhReadExecution({
        ...options,
        authoritySignal: authority.signal,
        validateAuthority: authority.validate,
        requestSignal: request.signal,
      });
      return await readQuery(parsed.data, execution);
    } catch (error) {
      return execution ? execution.failure(error) : ghReadFailure('unavailable');
    } finally {
      execution?.dispose();
      const remaining = Number(active.get(authority)) - 1;
      active.set(authority, remaining);
    }
  };
}
