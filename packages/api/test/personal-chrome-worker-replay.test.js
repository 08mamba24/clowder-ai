import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const apiRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const serviceWorkerPath = join(apiRoot, 'src/plugins/cloud-cat-personal-host/extension/service-worker.js');
const helperArtifactRevision = `sha512:${'0'.repeat(128)}`;
const passiveAlarms = () => ({ create: async () => undefined, onAlarm: { addListener() {} } });

describe('Personal Chrome append replay safety', () => {
  it('reinjects the current content adapter before append when an old listener ignores health', async () => {
    const serviceWorkerSource = await readFile(serviceWorkerPath, 'utf8');
    const inboundListeners = [];
    const outbound = [];
    const contentRequests = [];
    const injected = [];
    let resolveTerminal;
    const terminal = new Promise((resolve) => {
      resolveTerminal = resolve;
    });
    const chrome = {
      runtime: {
        connectNative() {
          return {
            onMessage: { addListener: (listener) => inboundListeners.push(listener) },
            onDisconnect: { addListener() {} },
            postMessage(message) {
              outbound.push(message);
              if (message.kind === 'append_result') resolveTerminal();
            },
          };
        },
        onMessage: { addListener() {} },
      },
      alarms: passiveAlarms(),
      action: {
        onClicked: { addListener() {} },
        setBadgeText() {},
        setTitle() {},
      },
      tabs: {
        async query() {
          return [{ id: 73, url: 'https://chatgpt.com/c/conversation-7' }];
        },
        async sendMessage(tabId, request) {
          assert.equal(tabId, 73);
          contentRequests.push(request);
          if (contentRequests.length === 1) return undefined;
          if (request.kind === 'adapter_health') {
            return {
              v: 2,
              kind: 'adapter_health_result',
              requestId: request.requestId,
              status: 'ready',
              observedRevisions: request.expectedRevisions,
            };
          }
          return {
            v: 2,
            kind: 'append_result',
            requestId: request.requestId,
            idempotencyKey: request.idempotencyKey,
            status: 'host_observed',
            hostMessageId: 'chatgpt-user-message-reinjected',
            observedRevisions: request.expectedRevisions,
          };
        },
      },
      scripting: {
        async executeScript(options) {
          injected.push(options);
        },
      },
    };

    runInNewContext(serviceWorkerSource, { chrome, URL, TextEncoder, setTimeout() {}, clearTimeout() {} });
    inboundListeners[0]({
      v: 2,
      kind: 'append_message',
      requestId: 'append-after-extension-reload',
      conversationId: 'conversation-7',
      idempotencyKey: 'source-thread-7',
      text: 'TEXT_IS_ONLY_PRESENT_IN_THE_PROTOCOL_REQUEST',
      expectedRevisions: {
        helper: helperArtifactRevision,
        extension: '0.2.13',
        pageAdapter: '2026-09-24.1',
      },
    });
    await terminal;

    assert.deepEqual(
      contentRequests.map((request) => request.kind),
      ['adapter_health', 'adapter_health', 'append_message_v2'],
    );
    assert.equal(injected.length, 1);
    assert.equal(injected[0].target.tabId, 73);
    assert.equal(injected[0].files.join(','), 'content-script.js');
    assert.equal(outbound.at(-1).status, 'host_observed');
    assert.equal(outbound.at(-1).hostMessageId, 'chatgpt-user-message-reinjected');
  });

  it('does not replay an append after the page submitted it but its receipt was lost', async () => {
    const serviceWorkerSource = await readFile(serviceWorkerPath, 'utf8');
    const inboundListeners = [];
    const contentListeners = [];
    const outbound = [];
    const contentRequests = [];
    const injected = [];
    let resolveTerminal;
    const terminal = new Promise((resolve) => {
      resolveTerminal = resolve;
    });
    const chrome = {
      runtime: {
        connectNative() {
          return {
            onMessage: { addListener: (listener) => inboundListeners.push(listener) },
            onDisconnect: { addListener() {} },
            postMessage(message) {
              outbound.push(message);
              if (message.kind === 'append_result') resolveTerminal();
            },
          };
        },
        onMessage: { addListener: (listener) => contentListeners.push(listener) },
      },
      alarms: passiveAlarms(),
      action: {
        onClicked: { addListener() {} },
        setBadgeText() {},
        setTitle() {},
      },
      tabs: {
        async query() {
          return [{ id: 73, url: 'https://chatgpt.com/c/conversation-7' }];
        },
        async sendMessage(_tabId, request) {
          contentRequests.push(request.kind);
          if (request.kind === 'adapter_health') {
            return {
              v: 2,
              kind: 'adapter_health_result',
              requestId: request.requestId,
              status: 'ready',
              observedRevisions: request.expectedRevisions,
            };
          }
          contentListeners[0]({
            v: 2,
            kind: 'append_progress',
            requestId: request.requestId,
            idempotencyKey: request.idempotencyKey,
            status: 'submitted',
          });
          return undefined;
        },
      },
      scripting: {
        async executeScript(options) {
          injected.push(options);
        },
      },
    };

    runInNewContext(serviceWorkerSource, { chrome, URL, TextEncoder, setTimeout() {}, clearTimeout() {} });
    inboundListeners[0]({
      v: 2,
      kind: 'append_message',
      requestId: 'append-lost-receipt',
      conversationId: 'conversation-7',
      idempotencyKey: 'source-thread-7',
      text: 'The message may already be visible in ChatGPT',
      expectedRevisions: {
        helper: helperArtifactRevision,
        extension: '0.2.13',
        pageAdapter: '2026-09-24.1',
      },
    });
    await terminal;

    assert.deepEqual(contentRequests, ['adapter_health', 'append_message_v2']);
    assert.equal(injected.length, 0, 'a missing append receipt must not trigger a second submission');
    assert.ok(outbound.some((message) => message.kind === 'append_progress' && message.status === 'submitted'));
    assert.equal(outbound.at(-1).errorCode, 'SUBMISSION_OUTCOME_UNKNOWN');
  });
});
