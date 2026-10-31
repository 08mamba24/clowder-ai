import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';

const serviceWorkerPath = new URL('../extension/service-worker.js', import.meta.url);
const helperArtifactRevision = `sha512:${'0'.repeat(128)}`;
const EXTENSION_REVISION = '0.2.13';
const PAGE_ADAPTER_REVISION = '2026-10-30-fork.1';
const passiveAlarms = () => ({ create: async () => undefined, onAlarm: { addListener() {} } });

// #50 replay safety, ported 1:1 from fork
// packages/api/test/personal-chrome-worker-replay.test.js (squash 3f1380a22):
// the worker reinjects the content adapter only BEFORE append (health stage);
// a lost append receipt never triggers a second submission.

function makeChrome({ onContentMessage }) {
  const inboundListeners = [];
  const contentListeners = [];
  const outbound = [];
  const contentRequests = [];
  const injected = [];
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
      async sendMessage(tabId, request) {
        assert.equal(tabId, 73);
        contentRequests.push(request.kind);
        return onContentMessage(request, { contentListeners, injected });
      },
    },
    scripting: {
      async executeScript(options) {
        injected.push(options);
      },
    },
  };
  let resolveTerminal;
  const terminal = new Promise((resolve) => {
    resolveTerminal = resolve;
  });
  return { chrome, inboundListeners, outbound, contentRequests, injected, terminal };
}

async function driveAppend(fixture) {
  const serviceWorkerSource = await readFile(serviceWorkerPath, 'utf8');
  runInNewContext(serviceWorkerSource, {
    chrome: fixture.chrome,
    URL,
    TextEncoder,
    setTimeout() {},
    clearTimeout() {},
  });
  fixture.inboundListeners[0]({
    v: 2,
    kind: 'append_message',
    requestId: fixture.requestId,
    conversationId: 'conversation-7',
    idempotencyKey: 'source-thread-7',
    text: fixture.text,
    expectedRevisions: {
      helper: helperArtifactRevision,
      extension: EXTENSION_REVISION,
      pageAdapter: PAGE_ADAPTER_REVISION,
    },
  });
  await fixture.terminal;
}

describe('Personal Chrome append replay safety (#50)', () => {
  it('reinjects the current content adapter before append when an old listener ignores health', async () => {
    let healthCalls = 0;
    const fixture = makeChrome({
      onContentMessage(request, { injected }) {
        if (request.kind === 'adapter_health') {
          healthCalls += 1;
          // First health call lands on a stale listener (no response); the
          // helper reinjects and retries, the second call sees the fresh one.
          if (healthCalls === 1) return undefined;
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
    });
    fixture.requestId = 'append-after-extension-reload';
    fixture.text = 'TEXT_IS_ONLY_PRESENT_IN_THE_PROTOCOL_REQUEST';
    await driveAppend(fixture);

    assert.deepEqual(fixture.contentRequests, ['adapter_health', 'adapter_health', 'append_message_v2']);
    assert.equal(fixture.injected.length, 1);
    assert.equal(fixture.injected[0].target.tabId, 73);
    assert.equal(fixture.injected[0].files.join(','), 'content-script.js');
    assert.equal(fixture.outbound.at(-1).status, 'host_observed');
    assert.equal(fixture.outbound.at(-1).hostMessageId, 'chatgpt-user-message-reinjected');
  });

  it('does not replay an append after the page submitted it but its receipt was lost', async () => {
    const fixture = makeChrome({
      onContentMessage(request, { contentListeners }) {
        if (request.kind === 'adapter_health') {
          return {
            v: 2,
            kind: 'adapter_health_result',
            requestId: request.requestId,
            status: 'ready',
            observedRevisions: request.expectedRevisions,
          };
        }
        // The page accepted the submission (progress flows to the worker)
        // but the append receipt never returns.
        contentListeners[0]({
          v: 2,
          kind: 'append_progress',
          requestId: request.requestId,
          idempotencyKey: request.idempotencyKey,
          status: 'submitted',
        });
        return undefined;
      },
    });
    fixture.requestId = 'append-lost-receipt';
    fixture.text = 'The message may already be visible in ChatGPT';
    await driveAppend(fixture);

    assert.deepEqual(fixture.contentRequests, ['adapter_health', 'append_message_v2']);
    assert.equal(fixture.injected.length, 0, 'a missing append receipt must not trigger a second submission');
    assert.ok(fixture.outbound.some((message) => message.kind === 'append_progress' && message.status === 'submitted'));
    assert.equal(fixture.outbound.at(-1).errorCode, 'SUBMISSION_OUTCOME_UNKNOWN');
  });
});
