/**
 * F247 Workspace Agent slice 2b tests: config custody (mode-0600 file with
 * env bootstrap fallback, token never projected), refreshable adapter, and
 * versioned-binding reads in the bridge host path.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { CloudInvokeBridge } from '../dist/domains/cats/services/cloud-bridge/cloud-invoke-bridge.js';
import {
  createRefreshableWorkspaceAgentTriggerAdapter,
  createWorkspaceAgentTriggerConfig,
} from '../dist/domains/cats/services/cloud-bridge/workspace-agent/workspace-agent-config.js';
import {
  WorkspaceAgentTriggerError,
  WorkspaceAgentTriggerHttpAdapter,
} from '../dist/domains/cats/services/cloud-bridge/workspace-agent/workspace-agent-trigger-adapter.js';

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function tempProjectRoot() {
  return mkdtempSync(join(tmpdir(), 'f247-wa-config-'));
}

test('config: unconfigured resolves null and projects no token material', () => {
  const root = tempProjectRoot();
  try {
    const config = createWorkspaceAgentTriggerConfig({ projectRoot: root, env: {} });
    assert.equal(config.resolve(), null);
    const projection = config.project();
    assert.equal(projection.enabled, false);
    assert.equal(projection.tokenConfigured, false);
    assert.equal('token' in projection, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('config: env triple bootstraps without a file; partial env stays disabled', () => {
  const root = tempProjectRoot();
  try {
    const full = createWorkspaceAgentTriggerConfig({
      projectRoot: root,
      env: {
        CAT_CAFE_WORKSPACE_AGENT_TRIGGER_ID: 'agtch_env',
        CAT_CAFE_WORKSPACE_AGENT_WORKSPACE_ID: 'ws_env',
        CAT_CAFE_WORKSPACE_AGENT_TOKEN: 'env-secret',
      },
    });
    assert.equal(full.resolve()?.source, 'env');
    assert.equal(full.project().triggerId, 'agtch_env');

    const partial = createWorkspaceAgentTriggerConfig({
      projectRoot: root,
      env: { CAT_CAFE_WORKSPACE_AGENT_TRIGGER_ID: 'agtch_env', CAT_CAFE_WORKSPACE_AGENT_TOKEN: 'env-secret' },
    });
    assert.equal(partial.resolve(), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('config: save persists mode-0600 atomically, projects presence bit, never the token', () => {
  const root = tempProjectRoot();
  try {
    const config = createWorkspaceAgentTriggerConfig({ projectRoot: root, env: {} });
    const projection = config.save({
      triggerId: 'agtch_file',
      workspaceId: 'ws_file',
      token: 'file-secret-value',
    });
    assert.equal(projection.enabled, true);
    assert.equal(projection.tokenConfigured, true);
    assert.equal(projection.source, 'settings');
    assert.equal(JSON.stringify(projection).includes('file-secret-value'), false, 'token must never be projected');

    const mode = statSync(config.configPath).mode & 0o777;
    assert.equal(mode, 0o600, 'config file must be owner-only');
    const persisted = JSON.parse(readFileSync(config.configPath, 'utf-8'));
    assert.equal(persisted.triggerId, 'agtch_file');
    assert.equal(persisted.token, 'file-secret-value');

    // Save without token preserves the stored token (re-auth of other fields).
    config.save({ workspaceId: 'ws_file2' });
    assert.equal(config.resolve()?.workspaceId, 'ws_file2');
    assert.equal(config.resolve()?.token, 'file-secret-value');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('config: disable() keeps the token and re-enable works; file wins over env', () => {
  const root = tempProjectRoot();
  try {
    const config = createWorkspaceAgentTriggerConfig({
      projectRoot: root,
      env: {
        CAT_CAFE_WORKSPACE_AGENT_TRIGGER_ID: 'agtch_env',
        CAT_CAFE_WORKSPACE_AGENT_WORKSPACE_ID: 'ws_env',
        CAT_CAFE_WORKSPACE_AGENT_TOKEN: 'env-secret',
      },
    });
    config.save({ triggerId: 'agtch_file', workspaceId: 'ws_file', token: 'file-secret' });
    const disabled = config.disable();
    assert.equal(disabled.enabled, false);
    // Disabled file suppresses the env bootstrap fallback — explicit off means off.
    assert.equal(config.resolve(), null);
    const reenabled = config.save({ enabled: true });
    assert.equal(reenabled.enabled, true);
    assert.equal(config.resolve()?.token, 'file-secret');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('refreshable adapter: reads fresh config per call; unconfigured fails typed', async () => {
  const root = tempProjectRoot();
  try {
    const config = createWorkspaceAgentTriggerConfig({ projectRoot: root, env: {} });
    const adapter = createRefreshableWorkspaceAgentTriggerAdapter(config);
    await assert.rejects(
      adapter.trigger({ input: 'x', conversationKey: 'clowder:w:t', idempotencyKey: 'k' }),
      (err) => err instanceof WorkspaceAgentTriggerError && err.code === 'WORKSPACE_AGENT_INVALID_CONFIG',
    );

    config.save({ triggerId: 'agtch_live', workspaceId: 'ws_live', token: 'tok-live' });
    const seen = [];
    // Patch global fetch for this one call to prove the live config is used.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      seen.push({ url, init });
      return jsonResponse(202, { conversation_url: 'https://chatgpt.com/c/live-1' });
    };
    try {
      const receipt = await adapter.trigger({ input: 'x', conversationKey: 'clowder:w:t', idempotencyKey: 'k' });
      assert.equal(receipt.conversationUrl, 'https://chatgpt.com/c/live-1');
      assert.ok(seen[0].url.includes('/v1/workspace_agents/agtch_live/trigger'));
      assert.equal(seen[0].init.headers.Authorization, 'Bearer tok-live');
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('bridge host path: workspace-agent versioned binding reads as needs-binding (no host URL)', async () => {
  const hostCalls = [];
  const bridge = new CloudInvokeBridge({
    hostAdapter: {
      append_message: async (...args) => {
        hostCalls.push(args);
        return { hostMessageId: 'host-1' };
      },
    },
    pinchTabAdapter: null,
    emitFallback: async () => {},
    threadStore: {
      getCloudCatBindings: async () => ({
        'gpt-pro': { v: 1, provider: 'workspace-agent', workspaceId: 'ws_1', triggerId: 'agtch_x' },
      }),
      updateCloudCatBinding: async () => {},
    },
  });
  const outcome = await bridge.dispatch({
    catId: 'gpt-pro',
    threadId: 'thread_1',
    userId: 'user-1',
    threadTitle: null,
    participants: [],
    calledBy: 'zcode',
    intent: 'hello',
    sourceMessageId: 'src-1',
  });
  assert.equal(outcome.kind, 'fallback');
  assert.equal(outcome.reason, 'needs-binding');
  assert.equal(hostCalls.length, 0, 'no host append without a personal-chrome conversation binding');
});

test('bridge host path: legacy string binding still routes through host (read migration)', async () => {
  const hostCalls = [];
  const bridge = new CloudInvokeBridge({
    hostAdapter: {
      append_message: async (...args) => {
        hostCalls.push(args);
        return { hostMessageId: 'host-1' };
      },
    },
    pinchTabAdapter: null,
    emitFallback: async () => {},
    threadStore: {
      getCloudCatBindings: async () => ({ 'gpt-pro': 'https://chatgpt.com/c/legacy-1' }),
      updateCloudCatBinding: async () => {},
    },
  });
  const outcome = await bridge.dispatch({
    catId: 'gpt-pro',
    threadId: 'thread_1',
    userId: 'user-1',
    threadTitle: null,
    participants: [],
    calledBy: 'zcode',
    intent: 'hello',
    sourceMessageId: 'src-1',
  });
  assert.equal(outcome.kind, 'sent');
  assert.equal(outcome.transport, 'host');
  assert.equal(hostCalls.length, 1);
});

test('http adapter: still validates config via constructor (regression guard)', () => {
  const adapter = new WorkspaceAgentTriggerHttpAdapter({ triggerId: 'agtch_x', tokenProvider: () => 't' });
  assert.equal(adapter.triggerId, 'agtch_x');
});
