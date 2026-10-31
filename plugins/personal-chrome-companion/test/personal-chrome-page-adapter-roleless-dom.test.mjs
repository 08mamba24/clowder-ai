import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { JSDOM } from 'jsdom';

import { createChatGptPageAdapter } from '../extension/chatgpt-page-adapter.mjs';

// Generalized fixtures for the roleless ChatGPT DOM (observed 2026-10-28):
// user bubbles use [data-user-message-bubble="true"] inside
// [data-content-search-unit-key="fallback-turn-N:0:user"] units, assistant
// replies use "...:N:assistant" units, and neither data-message-author-role,
// data-message-id, nor conversation-turn-* test ids are exposed. Unit keys are
// page-local markers and must never surface as hostMessageId.
//
// Ported 1:1 from fork PR #59
// (packages/api/test/personal-chrome-page-adapter-roleless-dom.test.js,
// squash commit 3f1380a22ddd02832d8e7ab238005f71e86b15dc) into the official
// plugin package boundary; only the adapter import path changed.

function appendRolelessUserMessage({ document, unitKey, sentText, hostMessageId = null }) {
  const unit = document.createElement('div');
  unit.setAttribute('data-content-search-unit-key', unitKey);
  const bubble = document.createElement('div');
  bubble.setAttribute('data-user-message-bubble', 'true');
  const wrapper = document.createElement('div');
  const depth = document.createElement('div');
  depth.textContent = sentText;
  wrapper.append(depth);
  const caret = document.createElement('span');
  caret.textContent = '\n';
  wrapper.append(caret);
  bubble.append(wrapper);
  const affordance = document.createElement('button');
  const affordanceLabel = document.createElement('span');
  affordanceLabel.textContent = 'Edit';
  affordance.append(affordanceLabel);
  bubble.append(affordance);
  if (hostMessageId) unit.setAttribute('data-message-id', hostMessageId);
  unit.append(bubble);
  document.querySelector('#messages').append(unit);
  return unit;
}

function appendRolelessAssistantMessage({ document, unitKey, content, hostMessageId = null }) {
  const unit = document.createElement('div');
  unit.setAttribute('data-content-search-unit-key', unitKey);
  const body = document.createElement('div');
  const paragraph = document.createElement('p');
  const span = document.createElement('span');
  span.textContent = content;
  paragraph.append(span);
  body.append(paragraph);
  unit.append(body);
  if (hostMessageId) unit.setAttribute('data-message-id', hostMessageId);
  document.querySelector('#messages').append(unit);
  return unit;
}

function createRolelessFixture({ conversationId = 'conversation-7' } = {}) {
  const dom = new JSDOM(
    `<!doctype html><body>
      <main id="messages"></main>
      <div id="prompt-textarea" contenteditable="true"></div>
      <button data-testid="send-button">Send</button>
    </body>`,
    { url: `https://chatgpt.com/c/${conversationId}`, pretendToBeVisual: true },
  );
  const document = dom.window.document;
  const composer = document.querySelector('#prompt-textarea');
  document.execCommand = (command, _showUi, value) => {
    if (command === 'insertText' && typeof value === 'string') {
      composer.textContent = value;
      composer.dispatchEvent(
        new dom.window.InputEvent('input', {
          bubbles: true,
          composed: true,
          inputType: 'insertText',
          data: value,
        }),
      );
      return true;
    }
    if (command === 'delete') {
      composer.replaceChildren();
      composer.dispatchEvent(
        new dom.window.InputEvent('input', {
          bubbles: true,
          composed: true,
          inputType: 'deleteContentBackward',
          data: null,
        }),
      );
      return true;
    }
    return false;
  };
  let sendCount = 0;
  const sentTexts = [];
  const onSendHandlers = [];
  document.querySelector('[data-testid="send-button"]').addEventListener('click', (event) => {
    event.preventDefault();
    sendCount += 1;
    const sentText = composer.textContent;
    sentTexts.push(sentText);
    for (const handler of onSendHandlers) handler({ sendCount, sentText });
    composer.replaceChildren();
  });
  return { dom, document, onSendHandlers, getSendCount: () => sendCount, sentTexts };
}

function adapterFor(fixture, overrides = {}) {
  return createChatGptPageAdapter({
    document: fixture.document,
    location: fixture.dom.window.location,
    MutationObserver: fixture.dom.window.MutationObserver,
    observationTimeoutMs: 40,
    sendButtonTimeoutMs: 20,
    assistantObservationTimeoutMs: 80,
    assistantQuietMs: 10,
    ...overrides,
  });
}

async function rejectionOf(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail('expected the adapter call to reject');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The 2026-10-31 page exposes real UUIDs on a search owner outside the user
// content unit; assistant owners expose the same UUID twice. Unit keys remain
// fallback-turn markers and are only used to bound the identity projection.
function exposeSearchMessageIds(unit, messageIds) {
  const document = unit.ownerDocument;
  const key = unit.getAttribute('data-content-search-unit-key');
  const owner = key.endsWith(':user') ? document.createElement('div') : unit;
  if (owner !== unit) {
    unit.replaceWith(owner);
    owner.append(unit);
  }
  owner.setAttribute('data-chatgpt-search-unit-key', key);
  owner.setAttribute('data-chatgpt-search-message-ids', messageIds);
  return owner;
}

describe('ChatGPT page adapter roleless DOM', () => {
  it('captures the real search UUIDs and assistant body from the current roleless page', async () => {
    const fixture = createRolelessFixture();
    const userId = '11111111-1111-4111-8111-111111111111';
    const assistantId = '22222222-2222-4222-8222-222222222222';
    const finals = [];
    fixture.onSendHandlers.push(({ sentText }) => {
      exposeSearchMessageIds(appendRolelessUserMessage({
        document: fixture.document, unitKey: 'fallback-turn-6:0:user', sentText,
      }), userId);
      const assistant = appendRolelessAssistantMessage({
        document: fixture.document, unitKey: 'fallback-turn-6:2:assistant', content: 'L3_OK',
      });
      exposeSearchMessageIds(assistant, `${assistantId} ${assistantId}`);
      assistant.firstElementChild.setAttribute('data-markdown-text-style', 'assistant-message');
      const label = fixture.document.createElement('h4');
      label.textContent = 'ChatGPT says:';
      assistant.prepend(label);
      const control = fixture.document.createElement('button');
      control.textContent = 'Copy';
      assistant.append(control);
    });
    const adapter = adapterFor(fixture, { onAssistantFinal: (final) => finals.push(final) });
    const result = await adapter.appendMessage({
      requestId: 'request-search-uuid', conversationId: 'conversation-7',
      text: 'current roleless receipt and return', idempotencyKey: 'source-search-uuid',
    });
    await sleep(40);
    assert.equal(result.hostMessageId, userId);
    assert.equal(fixture.getSendCount(), 1);
    assert.equal(finals.length, 1);
    assert.equal(finals[0].assistantMessageId, assistantId);
    assert.equal(finals[0].content, 'L3_OK');
  });

  const invalidSearchIdentities = {
    multiple_ids: (_unit, owner) => owner.setAttribute('data-chatgpt-search-message-ids',
      '11111111-1111-4111-8111-111111111111 22222222-2222-4222-8222-222222222222'),
    fallback_key: (_unit, owner) => owner.setAttribute('data-chatgpt-search-message-ids', 'fallback-turn-6:0:user'),
    wrong_unit: (_unit, owner) => owner.setAttribute('data-chatgpt-search-unit-key', 'fallback-turn-5:0:user'),
    sibling_unit: (unit, owner) => {
      const sibling = unit.ownerDocument.createElement('div');
      sibling.setAttribute('data-content-search-unit-key', 'fallback-turn-5:0:user');
      owner.append(sibling);
    },
    conflicting_legacy_id: (unit) => unit.setAttribute('data-message-id', 'different-host-id'),
  };
  for (const [scenario, invalidate] of Object.entries(invalidSearchIdentities)) {
    it(`does not confirm a search identity with ${scenario}`, async () => {
      const fixture = createRolelessFixture();
      const userId = '11111111-1111-4111-8111-111111111111';
      fixture.onSendHandlers.push(({ sentText }) => {
        const unit = appendRolelessUserMessage({
          document: fixture.document, unitKey: 'fallback-turn-6:0:user', sentText,
        });
        const owner = exposeSearchMessageIds(unit, userId);
        invalidate(unit, owner);
      });
      const error = await rejectionOf(adapterFor(fixture).appendMessage({
        requestId: `request-search-${scenario}`, conversationId: 'conversation-7',
        text: 'identity must be unique and local', idempotencyKey: `source-search-${scenario}`,
      }));
      assert.equal(error.code, 'HOST_MESSAGE_ID_UNAVAILABLE');
      assert.equal(fixture.getSendCount(), 1);
    });
  }

  it('reports HOST_MESSAGE_ID_UNAVAILABLE when the roleless bubble carries the exact text but no real Host ID', async () => {
    const fixture = createRolelessFixture();
    const progress = [];
    fixture.onSendHandlers.push(({ sendCount, sentText }) => {
      appendRolelessUserMessage({
        document: fixture.document,
        unitKey: `fallback-turn-${sendCount}:0:user`,
        sentText,
      });
    });
    const adapter = adapterFor(fixture, { onProgress: (status) => progress.push(status) });

    const error = await rejectionOf(
      adapter.appendMessage({
        requestId: 'request-roleless-no-id',
        conversationId: 'conversation-7',
        text: 'hello roleless cloud cat',
        idempotencyKey: 'source-message-roleless-no-id',
      }),
    );

    assert.equal(error.code, 'HOST_MESSAGE_ID_UNAVAILABLE');
    assert.equal(fixture.getSendCount(), 1);
    assert.deepEqual(progress, ['inserted', 'submitted']);
    assert.equal(error.diagnostic?.userBubbleTextExactMatchCount, 1);
    assert.equal(error.diagnostic?.rolelessUserBubbleCount, 1);
    assert.equal(error.diagnostic?.legacyUserMessageCount, 0);
    assert.equal(error.diagnostic?.ambiguousMatch, false);
  });

  it('never surfaces the fallback-turn unit key as hostMessageId', async () => {
    const fixture = createRolelessFixture();
    fixture.onSendHandlers.push(({ sendCount, sentText }) => {
      appendRolelessUserMessage({
        document: fixture.document,
        unitKey: `fallback-turn-${sendCount}:0:user`,
        sentText,
      });
    });
    const adapter = adapterFor(fixture);

    const error = await rejectionOf(
      adapter.appendMessage({
        requestId: 'request-fallback-key-not-an-id',
        conversationId: 'conversation-7',
        text: 'unit keys are page markers, not Host IDs',
        idempotencyKey: 'source-message-fallback-key-not-an-id',
      }),
    );

    assert.notEqual(error.code, 'HOST_MESSAGE_NOT_OBSERVED');
    assert.ok(!/fallback-turn/.test(String(error.diagnostic?.hostMessageId ?? '')));
    assert.ok(error.hostMessageId === undefined);
  });

  it('keeps HOST_MESSAGE_NOT_OBSERVED when the roleless bubble text differs from the dispatched text', async () => {
    const fixture = createRolelessFixture();
    fixture.onSendHandlers.push(({ sendCount }) => {
      appendRolelessUserMessage({
        document: fixture.document,
        unitKey: `fallback-turn-${sendCount}:0:user`,
        sentText: 'the page rewrote or truncated the dispatched text',
      });
    });
    const adapter = adapterFor(fixture);

    const error = await rejectionOf(
      adapter.appendMessage({
        requestId: 'request-roleless-text-changed',
        conversationId: 'conversation-7',
        text: 'the exact dispatched text',
        idempotencyKey: 'source-message-roleless-text-changed',
      }),
    );

    assert.equal(error.code, 'HOST_MESSAGE_NOT_OBSERVED');
    assert.equal(fixture.getSendCount(), 1);
    assert.equal(error.diagnostic?.userBubbleTextExactMatchCount, 0);
  });

  it('resolves the real Host ID when a roleless unit exposes data-message-id', async () => {
    const fixture = createRolelessFixture();
    const progress = [];
    fixture.onSendHandlers.push(({ sendCount, sentText }) => {
      appendRolelessUserMessage({
        document: fixture.document,
        unitKey: `fallback-turn-${sendCount}:0:user`,
        sentText,
        hostMessageId: 'host-message-roleless-1',
      });
    });
    const adapter = adapterFor(fixture, { onProgress: (status) => progress.push(status) });

    const result = await adapter.appendMessage({
      requestId: 'request-roleless-with-id',
      conversationId: 'conversation-7',
      text: 'roleless unit that later exposes a real Host ID',
      idempotencyKey: 'source-message-roleless-with-id',
    });

    assert.equal(result.hostMessageId, 'host-message-roleless-1');
    assert.equal(fixture.getSendCount(), 1);
    assert.deepEqual(progress, ['inserted', 'submitted', 'host_observed']);
  });

  it('reports an ambiguous roleless match instead of confirming one of two identical bubbles', async () => {
    const fixture = createRolelessFixture();
    const duplicateText = 'the same text was dispatched twice into roleless bubbles';
    appendRolelessUserMessage({
      document: fixture.document,
      unitKey: 'fallback-turn-0:0:user',
      sentText: duplicateText,
    });
    fixture.onSendHandlers.push(({ sendCount, sentText }) => {
      appendRolelessUserMessage({
        document: fixture.document,
        unitKey: `fallback-turn-${sendCount}:0:user`,
        sentText,
      });
    });
    const adapter = adapterFor(fixture);

    const error = await rejectionOf(
      adapter.appendMessage({
        requestId: 'request-roleless-ambiguous',
        conversationId: 'conversation-7',
        text: duplicateText,
        idempotencyKey: 'source-message-roleless-ambiguous',
      }),
    );

    assert.equal(error.code, 'HOST_MESSAGE_ID_UNAVAILABLE');
    assert.equal(error.diagnostic?.userBubbleTextExactMatchCount, 2);
    assert.equal(error.diagnostic?.ambiguousMatch, true);
  });

  it('does not misanchor a roleless dispatch onto a legacy user message with different text', async () => {
    const fixture = createRolelessFixture();
    const legacyTurn = fixture.document.createElement('article');
    const legacyMessage = fixture.document.createElement('div');
    legacyMessage.dataset.messageAuthorRole = 'user';
    legacyMessage.dataset.messageId = 'host-message-legacy-1';
    legacyMessage.textContent = 'an older legacy message with other content';
    legacyTurn.append(legacyMessage);
    fixture.document.querySelector('#messages').append(legacyTurn);
    fixture.onSendHandlers.push(({ sendCount, sentText }) => {
      appendRolelessUserMessage({
        document: fixture.document,
        unitKey: `fallback-turn-${sendCount}:0:user`,
        sentText,
      });
    });
    const adapter = adapterFor(fixture);

    const error = await rejectionOf(
      adapter.appendMessage({
        requestId: 'request-mixed-dom-dispatch',
        conversationId: 'conversation-7',
        text: 'the newly dispatched roleless text',
        idempotencyKey: 'source-message-mixed-dom-dispatch',
      }),
    );

    assert.equal(error.code, 'HOST_MESSAGE_ID_UNAVAILABLE');
    assert.notEqual(error.diagnostic?.legacyUserMessageCount, 0);
    assert.equal(fixture.getSendCount(), 1);
  });

  it('observes a roleless assistant final when both units expose real Host IDs', async () => {
    const fixture = createRolelessFixture();
    const finals = [];
    fixture.onSendHandlers.push(({ sendCount, sentText }) => {
      appendRolelessUserMessage({
        document: fixture.document,
        unitKey: `fallback-turn-${sendCount}:0:user`,
        sentText,
        hostMessageId: 'host-message-roleless-user-1',
      });
      appendRolelessAssistantMessage({
        document: fixture.document,
        unitKey: `fallback-turn-${sendCount}:2:assistant`,
        content: 'the causal assistant final for the roleless dispatch',
        hostMessageId: 'host-message-roleless-assistant-1',
      });
    });
    const adapter = adapterFor(fixture, {
      onAssistantFinal: (final) => finals.push(final),
    });

    const result = await adapter.appendMessage({
      requestId: 'request-roleless-assistant-final',
      conversationId: 'conversation-7',
      text: 'roleless dispatch whose assistant reply exposes a real Host ID',
      idempotencyKey: 'source-message-roleless-assistant-final',
    });
    await sleep(150);

    assert.equal(result.hostMessageId, 'host-message-roleless-user-1');
    assert.equal(finals.length, 1);
    assert.equal(finals[0].hostMessageId, 'host-message-roleless-user-1');
    assert.equal(finals[0].assistantMessageId, 'host-message-roleless-assistant-1');
    assert.equal(finals[0].content, 'the causal assistant final for the roleless dispatch');
  });

  it('counts roleless assistant units in the observation failure diagnostic', async () => {
    const fixture = createRolelessFixture();
    const failures = [];
    fixture.onSendHandlers.push(({ sendCount, sentText }) => {
      const legacyTurn = fixture.document.createElement('article');
      const legacyMessage = fixture.document.createElement('div');
      legacyMessage.dataset.messageAuthorRole = 'user';
      legacyMessage.dataset.messageId = 'host-message-legacy-anchor';
      legacyMessage.textContent = sentText;
      legacyTurn.append(legacyMessage);
      fixture.document.querySelector('#messages').append(legacyTurn);
      appendRolelessAssistantMessage({
        document: fixture.document,
        unitKey: `fallback-turn-${sendCount}:2:assistant`,
        content: 'a roleless assistant reply without any real Host ID',
      });
    });
    const adapter = adapterFor(fixture, {
      onAssistantObservationFailure: (failure) => failures.push(failure),
    });

    await adapter.appendMessage({
      requestId: 'request-roleless-assistant-diagnostic',
      conversationId: 'conversation-7',
      text: 'legacy anchor with a roleless assistant reply',
      idempotencyKey: 'source-message-roleless-assistant-diagnostic',
    });
    await sleep(150);

    assert.equal(failures.length, 1);
    assert.equal(failures[0].errorCode, 'ASSISTANT_FINAL_NOT_OBSERVED');
    assert.equal(failures[0].diagnostic.rolelessAssistantUnitCount, 1);
    assert.ok(failures[0].diagnostic.assistantCandidateCount >= 1);
    assert.equal(failures[0].diagnostic.assistantHostIdStatus, 'missing_or_ambiguous');
  });

  it('binds the receipt to the new dispatch when an older roleless bubble repeats the text with a real Host ID', async () => {
    const fixture = createRolelessFixture();
    const repeatedText = 'the operator once sent this exact text and the page kept the older bubble';
    appendRolelessUserMessage({
      document: fixture.document,
      unitKey: 'fallback-turn-0:0:user',
      sentText: repeatedText,
      hostMessageId: 'old-message-id',
    });
    fixture.onSendHandlers.push(({ sendCount, sentText }) => {
      appendRolelessUserMessage({
        document: fixture.document,
        unitKey: `fallback-turn-${sendCount}:0:user`,
        sentText,
        hostMessageId: 'new-message-id',
      });
    });
    const adapter = adapterFor(fixture);

    const result = await adapter.appendMessage({
      requestId: 'request-roleless-preexisting-with-id',
      conversationId: 'conversation-7',
      text: repeatedText,
      idempotencyKey: 'source-message-roleless-preexisting-with-id',
    });

    assert.equal(result.hostMessageId, 'new-message-id');
    assert.equal(fixture.getSendCount(), 1);
  });

  it('matches a multi-block roleless bubble whose paragraphs render as separate text blocks', async () => {
    const fixture = createRolelessFixture();
    const firstLine = 'first dispatched paragraph';
    const secondLine = 'second dispatched paragraph';
    fixture.onSendHandlers.push(({ sendCount }) => {
      const unit = fixture.document.createElement('div');
      unit.setAttribute('data-content-search-unit-key', `fallback-turn-${sendCount}:0:user`);
      const bubble = fixture.document.createElement('div');
      bubble.setAttribute('data-user-message-bubble', 'true');
      const wrapper = fixture.document.createElement('div');
      for (const line of [firstLine, secondLine]) {
        const block = fixture.document.createElement('div');
        const paragraph = fixture.document.createElement('p');
        paragraph.textContent = line;
        block.append(paragraph);
        wrapper.append(block);
      }
      bubble.append(wrapper);
      unit.append(bubble);
      fixture.document.querySelector('#messages').append(unit);
    });
    const adapter = adapterFor(fixture);

    const error = await rejectionOf(
      adapter.appendMessage({
        requestId: 'request-roleless-multiblock',
        conversationId: 'conversation-7',
        text: `${firstLine}\n${secondLine}`,
        idempotencyKey: 'source-message-roleless-multiblock',
      }),
    );

    assert.equal(error.code, 'HOST_MESSAGE_ID_UNAVAILABLE');
    assert.equal(error.diagnostic?.userBubbleTextExactMatchCount, 1);
    assert.equal(fixture.getSendCount(), 1);
  });
});
