import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { JSDOM } from 'jsdom';

const extensionRoot = () => new URL('../extension/', import.meta.url);

// Page-injection boundary: the page never imports the adapter module sources —
// it runs the generated extension/content-script.js bundle. These tests
// evaluate the real bundle inside a jsdom page with a mocked chrome.runtime
// and drive append_message_v2 through the registered listener, so a bundle
// that drops a dependency or breaks the IIFE wiring fails here even when
// direct-import module tests stay green.

const EXTENSION_REVISION = '0.2.13';
const PAGE_ADAPTER_REVISION = '2026-10-31-fork.1';
const HELPER_REVISION = `sha512:${'0'.repeat(128)}`;

function createInjectionFixture() {
  const dom = new JSDOM(
    `<!doctype html><body>
      <main id="messages"></main>
      <div id="prompt-textarea" contenteditable="true"></div>
      <button data-testid="send-button">Send</button>
    </body>`,
    { url: 'https://chatgpt.com/c/conversation-7', runScripts: 'outside-only', pretendToBeVisual: true },
  );
  const { window } = dom;
  const composer = window.document.querySelector('#prompt-textarea');
  window.document.execCommand = (command, _showUi, value) => {
    if (command === 'insertText' && typeof value === 'string') {
      composer.textContent = value;
      composer.dispatchEvent(
        new window.InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: value }),
      );
      return true;
    }
    if (command === 'delete') {
      composer.replaceChildren();
      return true;
    }
    return false;
  };
  window.document.querySelector('[data-testid="send-button"]').addEventListener('click', (event) => {
    event.preventDefault();
    const unit = window.document.createElement('div');
    unit.setAttribute('data-content-search-unit-key', 'fallback-turn-1:0:user');
    unit.setAttribute('data-message-id', 'host-message-bundle-1');
    const bubble = window.document.createElement('div');
    bubble.setAttribute('data-user-message-bubble', 'true');
    bubble.textContent = composer.textContent;
    unit.append(bubble);
    window.document.querySelector('#messages').append(unit);
    composer.replaceChildren();
  });
  const listeners = [];
  const outbound = [];
  window.chrome = {
    runtime: {
      onMessage: { addListener: (listener) => listeners.push(listener) },
      sendMessage: async (message) => {
        outbound.push(message);
        return { accepted: true };
      },
    },
  };
  return { dom, window, listeners, outbound };
}

async function evaluateBundle(window) {
  const source = await readFile(new URL('content-script.js', extensionRoot()), 'utf8');
  window.eval(source);
}

function sendAppendMessage(fixture, overrides = {}) {
  const message = {
    v: 2,
    kind: 'append_message_v2',
    requestId: 'request-bundle-injection',
    conversationId: 'conversation-7',
    text: 'hello from the injected bundle',
    idempotencyKey: 'source-message-bundle-injection',
    expectedRevisions: {
      helper: HELPER_REVISION,
      extension: EXTENSION_REVISION,
      pageAdapter: PAGE_ADAPTER_REVISION,
    },
    ...overrides,
  };
  const [listener] = fixture.listeners;
  assert.ok(typeof listener === 'function', 'bundle did not register a chrome.runtime.onMessage listener');
  const progress = fixture.outbound.map((message) => `${message.kind}:${message.status ?? ''}`).join(',');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`injection append stalled; progress=[${progress}] outbound=${fixture.outbound.length}`)),
      10_000,
    );
    const done = (value) => {
      clearTimeout(timer);
      resolve(value);
    };
    const handled = listener(message, {}, done);
    assert.equal(handled, true, 'listener must claim async handling for append_message_v2');
  });
}

describe('content-script bundle injection boundary', () => {
  it('registers the adapter contract on the page and observes a roleless receipt end to end', async () => {
    const fixture = createInjectionFixture();
    await evaluateBundle(fixture.window);
    assert.ok(fixture.window.__catCafePersonalChromeAdapterV2, 'bundle did not expose the v2 adapter contract');
    assert.equal(fixture.window.__catCafePersonalChromeAdapterV2.extensionRevision, EXTENSION_REVISION);

    const result = await sendAppendMessage(fixture);
    assert.equal(result.status, 'host_observed');
    assert.equal(result.hostMessageId, 'host-message-bundle-1');
    // Cross-realm object from the jsdom window: compare field by field.
    assert.equal(result.observedRevisions.extension, EXTENSION_REVISION);
    assert.equal(result.observedRevisions.pageAdapter, PAGE_ADAPTER_REVISION);
    assert.equal(result.observedRevisions.helper, HELPER_REVISION);
  });

  it('rejects stale page-adapter revisions instead of running the appended message', async () => {
    const fixture = createInjectionFixture();
    await evaluateBundle(fixture.window);
    const result = await sendAppendMessage(fixture, {
      idempotencyKey: 'source-message-bundle-stale',
      expectedRevisions: {
        helper: HELPER_REVISION,
        extension: EXTENSION_REVISION,
        pageAdapter: '2026-09-24.1',
      },
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.errorCode, 'STALE_PAGE_ADAPTER');
  });
});
