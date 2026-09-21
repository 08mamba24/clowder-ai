import { z } from 'zod';
import type { GhReadLease } from '../../../../../../infrastructure/github/agent-github-read-types.js';
import type { AcpMcpServer } from './types.js';

function isReadEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'http:' &&
      ['127.0.0.1', '[::1]'].includes(url.hostname) &&
      !!url.port &&
      url.pathname === '/api/agent-github-read/mcp' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}
const servers = z
  .array(
    z
      .object({
        name: z.literal('clowder-repository-read'),
        type: z.literal('http'),
        url: z.string().refine(isReadEndpoint),
        headers: z.tuple([
          z
            .object({ name: z.literal('Authorization'), value: z.string().regex(/^Bearer [A-Za-z0-9_-]{43}$/) })
            .strict(),
        ]),
      })
      .strict(),
  )
  .max(1);

export function zcodeReadMcp(lease: GhReadLease): AcpMcpServer[] {
  return [
    {
      name: 'clowder-repository-read',
      type: 'http',
      url: lease.mcpUrl,
      headers: [{ name: 'Authorization', value: `Bearer ${lease.token}` }],
    },
  ];
}

/** Never forward family MCP or arbitrary credential-bearing config into this isolated provider. */
export function parseZcodeReadMcp(value: unknown) {
  const parsed = servers.safeParse(value === undefined ? [] : value);
  if (!parsed.success) throw new Error('ZCode accepts only the host repository-read MCP descriptor');
  return parsed.data.map((server) => ({ ...server, protocolVersion: 'legacy' as const }));
}
