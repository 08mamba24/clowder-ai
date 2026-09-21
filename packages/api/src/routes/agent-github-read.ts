import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AgentGitHubReadBroker } from '../infrastructure/github/agent-github-read-capability.js';
import { ghReadFailure } from '../infrastructure/github/agent-github-read-execution.js';
import { ghReadQuerySchema } from '../infrastructure/github/agent-github-read-schema.js';

function bearer(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  return typeof header === 'string' && /^Bearer [A-Za-z0-9_-]{43}$/.test(header) ? header.slice(7) : undefined;
}

function consumerSignal(reply: FastifyReply): AbortSignal {
  const abort = new AbortController();
  reply.raw.once('close', () => abort.abort());
  return abort.signal;
}

/** A private read capability endpoint, separately authenticated from all family callbacks. */
export async function agentGitHubReadRoutes(
  app: FastifyInstance,
  { broker }: { broker: AgentGitHubReadBroker },
): Promise<void> {
  app.addHook('onRequest', async (request, reply) => {
    if (!(await broker.authenticate(bearer(request))))
      return reply.code(401).send(ghReadFailure('capability_unavailable'));
  });
  app.post('/api/agent-github-read', { bodyLimit: 16_384 }, async (request, reply) =>
    broker.query(bearer(request), request.body, { signal: consumerSignal(reply) }),
  );

  app.post('/api/agent-github-read/mcp', { bodyLimit: 16_384 }, async (request, reply) => {
    const signal = consumerSignal(reply);
    const server = new McpServer({ name: 'clowder-repository-read', version: '1' });
    server.registerTool(
      'github_read',
      {
        description:
          'Read approved GitHub PRs, issues, diffs, checks and CI run metadata. Supply one typed query with an explicit owner/repository. No write operations or raw API access.',
        inputSchema: { query: ghReadQuerySchema },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      async ({ query }) => {
        const result = await broker.query(bearer(request), query, { signal });
        return { isError: !result.ok, content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      },
    );
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.raw.once('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    reply.hijack();
    await transport.handleRequest(request.raw, reply.raw, request.body);
  });
}
