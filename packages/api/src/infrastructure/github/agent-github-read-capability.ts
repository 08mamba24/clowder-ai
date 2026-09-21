import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { GhReadAuthority, GhReadResult } from './agent-github-read.js';
import { ghReadFailure } from './agent-github-read-execution.js';
import { ghReadQuerySchema } from './agent-github-read-schema.js';

export interface GhReadPrincipal {
  invocationId: string;
  userId: string;
  catId: string;
  threadId: string;
}
export interface GhReadLease {
  readonly token: string;
  readonly queryUrl: string;
  readonly mcpUrl: string;
  revoke(): void;
}
export interface GhReadBrokerOptions {
  apiUrl: string;
  ownerUserId: string;
  resolvePrincipal(invocationId: string): Promise<GhReadPrincipal | null>;
  read(query: unknown, authority: GhReadAuthority, request: { signal?: AbortSignal }): Promise<GhReadResult>;
  appendAudit(event: { type: string; threadId: string; data: Record<string, unknown> }): Promise<unknown>;
}

const REPOSITORIES = Object.freeze(['08mamba24/clowder-ai', 'zts212653/clowder-ai']);
const ENABLED_CATS = new Set(['zcode', 'qoder-flash']);
const SOURCE_REF = 'thread_msqw8n1bqpvmob6f#0001789954443843-000354-15718ecc';
interface Grant {
  principal: GhReadPrincipal;
  id: string;
  authority: GhReadAuthority;
  revoke(): void;
}

function tokenKey(token: unknown): string | undefined {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
  return createHash('sha256').update(token).digest('hex');
}

/** Ephemeral capabilities belong to provider attempts, never to a resumed native session. */
export class AgentGitHubReadBroker {
  private readonly grants = new Map<string, Grant>();
  private readonly current = new Map<string, Grant>();
  private readonly options: GhReadBrokerOptions;
  private readonly queryUrl: string;
  private readonly mcpUrl: string;
  private closed = false;

  constructor(options: GhReadBrokerOptions) {
    this.options = { ...options };
    const url = new URL(options.apiUrl);
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password)
      throw new Error('GitHub read carrier requires the host API loopback origin');
    this.queryUrl = new URL('/api/agent-github-read', url).href;
    this.mcpUrl = `${this.queryUrl}/mcp`;
  }

  private async principal(invocationId: string): Promise<GhReadPrincipal | null> {
    try {
      return await this.options.resolvePrincipal(invocationId);
    } catch {
      return null;
    }
  }

  async open(invocationId: string, signal?: AbortSignal): Promise<GhReadLease | null> {
    const principal = await this.principal(invocationId);
    if (this.closed || signal?.aborted || !principal) return null;
    if (
      principal.invocationId !== invocationId ||
      principal.userId !== this.options.ownerUserId ||
      !ENABLED_CATS.has(principal.catId)
    )
      return null;
    this.current.get(invocationId)?.revoke();
    if (this.grants.size >= 256) return null;
    const abort = new AbortController();
    const token = randomBytes(32).toString('base64url');
    const key = createHash('sha256').update(token).digest('hex');
    const grant: Grant = {
      principal: { ...principal },
      id: randomUUID(),
      authority: { repositories: REPOSITORIES, signal: abort.signal, validate: () => this.valid(grant) },
      revoke: () => {
        abort.abort();
        signal?.removeEventListener('abort', grant.revoke);
        this.grants.delete(key);
        if (this.current.get(invocationId) === grant) this.current.delete(invocationId);
      },
    };
    this.grants.set(key, grant);
    this.current.set(invocationId, grant);
    signal?.addEventListener('abort', grant.revoke, { once: true });
    return { token, queryUrl: this.queryUrl, mcpUrl: this.mcpUrl, revoke: grant.revoke };
  }

  private async valid(grant: Grant): Promise<boolean> {
    if (grant.authority.signal.aborted || this.closed) return false;
    const current = await this.principal(grant.principal.invocationId);
    const valid =
      current !== null &&
      (Object.keys(grant.principal) as Array<keyof GhReadPrincipal>).every(
        (key) => current[key] === grant.principal[key],
      );
    if (!valid) grant.revoke();
    return valid && !grant.authority.signal.aborted;
  }

  private find(token: unknown): Grant | undefined {
    const key = tokenKey(token);
    return key ? this.grants.get(key) : undefined;
  }

  async authenticate(token: unknown): Promise<boolean> {
    const grant = this.find(token);
    return grant ? this.valid(grant) : false;
  }

  async query(token: unknown, query: unknown, request: { signal?: AbortSignal } = {}): Promise<GhReadResult> {
    const grant = this.find(token);
    if (!grant) return ghReadFailure('capability_unavailable');
    if (!(await this.valid(grant))) return ghReadFailure('invocation_ended');
    const result = await this.options.read(query, grant.authority, request);
    const parsed = ghReadQuerySchema.safeParse(query);
    try {
      await this.options.appendAudit({
        type: 'agent_github_read',
        threadId: grant.principal.threadId,
        data: {
          ...grant.principal,
          grantId: grant.id,
          sourceRef: SOURCE_REF,
          ...(parsed.success ? { repository: parsed.data.repo, operation: parsed.data.op } : {}),
          outcome: result.ok ? 'read' : result.code,
          ...(result.ok ? { headSha: result.provenance.headSha, truncated: result.provenance.truncated } : {}),
        },
      });
    } catch {
      return ghReadFailure('unavailable');
    }
    if (!(await this.valid(grant))) return ghReadFailure('invocation_ended');
    if (request.signal?.aborted) return ghReadFailure('cancelled');
    return result;
  }

  close(): void {
    this.closed = true;
    for (const grant of this.grants.values()) grant.revoke();
  }
}
