/**
 * F247 Workspace Agent slice 3 tests: owner-only Settings routes. The token
 * is write-only — every response is a config-store projection carrying a
 * presence bit, never the value.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import Fastify from 'fastify';

import { registerWorkspaceAgentPluginRoutes } from '../dist/routes/workspace-agent-plugin-routes.js';
import {
  createRefreshableWorkspaceAgentTriggerAdapter,
  createWorkspaceAgentTriggerConfig,
} from '../dist/domains/cats/services/cloud-bridge/workspace-agent/workspace-agent-config.js';

// The access guard resolves the configured owner from this env (same setup
// as personal-chrome-plugin-routes.test.js).
const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
process.env.DEFAULT_OWNER_USER_ID = 'owner-user';
const ownerUserId = process.env.DEFAULT_OWNER_USER_ID;
test.after(() => {
  if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
  else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
});
const writeHeaders = {
  host: 'localhost:3004',
  origin: 'http://localhost:5173',
  'x-test-session-user': ownerUserId,
  'content-type': 'application/json',
};
const readHeaders = { host: writeHeaders.host, 'x-test-session-user': ownerUserId };

function buildApp(adapterOverrides = {}) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'f247-wa-routes-'));
  const config = createWorkspaceAgentTriggerConfig({ projectRoot, env: {} });
  const triggerCalls = [];
  const adapter = {
    trigger: async (args) => {
      triggerCalls.push(args);
      if (adapterOverrides.failWith) throw adapterOverrides.failWith;
      return {
        conversationUrl: 'https://chatgpt.com/c/selftest-1',
        providerRunId: 'apirun_selftest',
      };
    },
    get triggerId() {
      return config.resolve()?.triggerId ?? '';
    },
  };
  const app = Fastify();
  // Same test-session bridge as personal-chrome-plugin-routes.test.js: map
  // the x-test-session-user header onto the sessionUserId request field the
  // access guards consume.
  app.addHook('preHandler', async (request) => {
    const raw = request.headers['x-test-session-user'];
    if (typeof raw === 'string' && raw.trim()) request.sessionUserId = raw.trim();
  });
  registerWorkspaceAgentPluginRoutes(app, { config, adapter: createRefreshableWrapper(config, adapter) });
  return { app, config, triggerCalls, cleanup: () => rmSync(projectRoot, { recursive: true, force: true }) };
}

/** The routes exercise the refreshable wrapper so unconfigured tests 409 correctly. */
function createRefreshableWrapper(config, inner) {
  const refreshable = createRefreshableWorkspaceAgentTriggerAdapter(config);
  return {
    get triggerId() {
      return refreshable.triggerId;
    },
    trigger: (args) => (config.resolve() ? inner.trigger(args) : refreshable.trigger(args)),
  };
}

test('GET status: owner read returns projection without token', async () => {
  const { app, cleanup } = buildApp();
  try {
    const res = await app.inject({ method: 'GET', url: '/api/plugins/workspace-agent', headers: readHeaders });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.enabled, false);
    assert.equal('token' in body, false);

    const denied = await app.inject({ method: 'GET', url: '/api/plugins/workspace-agent', headers: { host: 'example.com' } });
    assert.ok(denied.statusCode >= 400, 'non-local access must be rejected');
  } finally {
    await app.close();
    cleanup();
  }
});

test('PUT config: saves and never echoes the token back', async () => {
  const { app, cleanup } = buildApp();
  try {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/plugins/workspace-agent/config',
      headers: writeHeaders,
      payload: { triggerId: 'agtch_ui', workspaceId: 'ws_ui', token: 'ui-secret-token' },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.enabled, true);
    assert.equal(body.triggerId, 'agtch_ui');
    assert.equal(body.tokenConfigured, true);
    assert.equal(res.body.includes('ui-secret-token'), false, 'token must never appear in any response');
  } finally {
    await app.close();
    cleanup();
  }
});

test('PUT config: invalid trigger id rejected with 400', async () => {
  const { app, cleanup } = buildApp();
  try {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/plugins/workspace-agent/config',
      headers: writeHeaders,
      payload: { triggerId: 'bad id!', workspaceId: 'ws', token: 't' },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().code, 'INVALID_CONFIG');
  } finally {
    await app.close();
    cleanup();
  }
});

test('DELETE disables without losing the token', async () => {
  const { app, config, cleanup } = buildApp();
  try {
    await app.inject({
      method: 'PUT',
      url: '/api/plugins/workspace-agent/config',
      headers: writeHeaders,
      payload: { triggerId: 'agtch_ui', workspaceId: 'ws_ui', token: 't' },
    });
    const res = await app.inject({ method: 'DELETE', url: '/api/plugins/workspace-agent', headers: writeHeaders });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().enabled, false);
    assert.equal(res.json().tokenConfigured, true);
    assert.equal(config.resolve(), null);
  } finally {
    await app.close();
    cleanup();
  }
});

test('POST test: unconfigured → 409; configured → real trigger with selftest conversation key', async () => {
  const { app, triggerCalls, cleanup } = buildApp();
  try {
    const unconfigured = await app.inject({ method: 'POST', url: '/api/plugins/workspace-agent/test', headers: writeHeaders, payload: {} });
    assert.equal(unconfigured.statusCode, 409);
    assert.equal(unconfigured.json().code, 'WORKSPACE_AGENT_NOT_CONFIGURED');
    assert.equal(triggerCalls.length, 0);

    await app.inject({
      method: 'PUT',
      url: '/api/plugins/workspace-agent/config',
      headers: writeHeaders,
      payload: { triggerId: 'agtch_ui', workspaceId: 'ws_ui', token: 't' },
    });
    const ok = await app.inject({ method: 'POST', url: '/api/plugins/workspace-agent/test', headers: writeHeaders, payload: {} });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().ok, true);
    assert.equal(ok.json().conversationUrl, 'https://chatgpt.com/c/selftest-1');
    assert.equal(triggerCalls.length, 1);
    assert.equal(triggerCalls[0].conversationKey, 'clowder:ws_ui:settings-selftest');
    assert.ok(triggerCalls[0].idempotencyKey.startsWith('f247-selftest-'));
    assert.ok(triggerCalls[0].input.includes('internal verification only'));
  } finally {
    await app.close();
    cleanup();
  }
});

test('POST test: adapter failure surfaces the typed code without the token', async () => {
  const { WorkspaceAgentTriggerError } = await import(
    '../dist/domains/cats/services/cloud-bridge/workspace-agent/workspace-agent-trigger-adapter.js'
  );
  const { app, cleanup } = buildApp({
    failWith: new WorkspaceAgentTriggerError('WORKSPACE_AGENT_UNAUTHORIZED', 'token rejected (401)', 401),
  });
  try {
    await app.inject({
      method: 'PUT',
      url: '/api/plugins/workspace-agent/config',
      headers: writeHeaders,
      payload: { triggerId: 'agtch_ui', workspaceId: 'ws_ui', token: 'secret-t' },
    });
    const res = await app.inject({ method: 'POST', url: '/api/plugins/workspace-agent/test', headers: writeHeaders, payload: {} });
    assert.equal(res.statusCode, 502);
    assert.equal(res.json().code, 'WORKSPACE_AGENT_UNAUTHORIZED');
    assert.equal(res.body.includes('secret-t'), false);
  } finally {
    await app.close();
    cleanup();
  }
});

test('R3: PUT rejects a workspaceId the conversation-key builder would refuse', async () => {
  const { app, cleanup } = buildApp();
  try {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/plugins/workspace-agent/config',
      headers: writeHeaders,
      payload: { triggerId: 'agtch_ui', workspaceId: 'tenant:fixture', token: 't' },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().code, 'INVALID_CONFIG');
    const followUp = await app.inject({ method: 'GET', url: '/api/plugins/workspace-agent', headers: readHeaders });
    assert.equal(followUp.json().enabled, false, 'rejected value must not be partially saved');
  } finally {
    await app.close();
    cleanup();
  }
});
