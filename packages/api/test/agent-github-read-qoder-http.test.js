import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import Fastify from 'fastify';
import { createAgentGitHubReader } from '../dist/infrastructure/github/agent-github-read.js';
import { AgentGitHubReadBroker } from '../dist/infrastructure/github/agent-github-read-capability.js';
import { agentGitHubReadRoutes } from '../dist/routes/agent-github-read.js';

test(
  'real Qoder shell-prefix reaches only the narrow HTTP read and cannot replay a revoked attempt',
  { skip: process.platform === 'win32' },
  async () => {
    const app = Fastify();
    const dir = mkdtempSync(join(tmpdir(), 'gh-read-http-'));
    let runnerCalls = 0;
    const broker = new AgentGitHubReadBroker({
      apiUrl: 'http://127.0.0.1:43210',
      ownerUserId: 'owner',
      resolvePrincipal: async (invocationId) => ({
        invocationId,
        userId: 'owner',
        catId: 'qoder-flash',
        threadId: 'thread',
      }),
      read: createAgentGitHubReader({
        ghPath: '/host/gh',
        cwd: '/host',
        baseEnv: {},
        runner: async () => {
          runnerCalls++;
          return { stdout: '[]', exitCode: 0 };
        },
      }),
      appendAudit: async () => {},
    });
    try {
      await app.register(agentGitHubReadRoutes, { broker });
      const origin = await app.listen({ host: '127.0.0.1', port: 0 });
      const lease = await broker.open('child');
      assert.ok(lease);
      const config = join(dir, 'read.json');
      writeFileSync(config, JSON.stringify({ token: lease.token, queryUrl: `${origin}/api/agent-github-read` }), {
        mode: 0o600,
      });
      const env = {
        PATH: process.env.PATH,
        CAT_CAFE_QODER_GITHUB_READ_CONFIG: config,
        CAT_CAFE_QODER_SANDBOX_BIN: '/usr/bin/false',
        CAT_CAFE_QODER_WORKSPACE_POLICY: '/absent',
        CAT_CAFE_QODER_MEMORY_POLICY: '/absent',
        CAT_CAFE_QODER_MEMORY_SHIM: '/absent',
      };
      const run = async (command) => {
        try {
          return await promisify(execFile)(
            process.execPath,
            [resolve('../../scripts/qoder-shell-sandbox.mjs'), command],
            { env, timeout: 20_000 },
          );
        } catch (error) {
          return error;
        }
      };
      const command = 'gh pr list --repo 08mamba24/clowder-ai --limit 2';
      const success = await run(command);
      assert.equal(JSON.parse(success.stdout).ok, true, success.stderr);
      assert.equal(runnerCalls, 1);
      const denied = await run('gh pr list --repo stranger/private');
      assert.equal(JSON.parse(denied.stdout).code, 'scope_denied');
      const unsupported = await run(`${command}; touch ${dir}/injected`);
      assert.match(unsupported.stderr, /unsupported_query/);
      assert.equal(runnerCalls, 1);
      lease.revoke();
      const revoked = await run(command);
      assert.equal(JSON.parse(revoked.stdout).code, 'capability_unavailable');
      assert.equal(runnerCalls, 1);
      for (const result of [success, denied, unsupported, revoked])
        assert.ok(!JSON.stringify(result).includes(lease.token));
    } finally {
      broker.close();
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
