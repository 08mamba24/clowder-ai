/**
 * F202 W2-3 h3b — a cloud-cat message sent through the enabled package (ledger「h3b 实现设计」;
 * frozen h3 (d), (e), (a′)).
 *
 * HOST_UNAVAILABLE only where nothing can have been sent: no package holds the provider, or the
 * Host refused the call before the package's action ran. Once the action ran, a failure or an
 * answer outside the contract is AMBIGUOUS_EFFECT, never normalised into a failure. A `failed`
 * answer keeps its code and replay truth; its diagnostic stays only if the contract accepts it.
 * Through the bridge, the dispatch mapping (d) is the one F247 already has.
 */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { buildCloudBridgeStatusContent } from '../dist/domains/cats/services/cloud-bridge/cloud-bridge-fallback.js';
import { CloudInvokeBridge } from '../dist/domains/cats/services/cloud-bridge/cloud-invoke-bridge.js';
import { dispatchBoundConversationThroughHost } from '../dist/domains/cats/services/cloud-bridge/conversation-host-dispatch.js';
import { PluginConversationHostAdapter } from '../dist/domains/cats/services/cloud-bridge/plugin-conversation-host/plugin-conversation-host-adapter.js';
import { ExternalPluginRuntimeError } from '../dist/domains/plugin/external-runtime/types.js';
import { cleanup, conversationHostHarness, METHODS, validDiagnostic } from './f202-w2-3-h3b.fixture.js';

after(cleanup);

const invalidDiagnostic = { ...validDiagnostic, errorCode: ['STALE_EXTENSION'] };

async function enabledHost() {
  const h = await conversationHostHarness();
  await h.enable();
  return h;
}

function append(h, { text = 'hello', conversationId = 'conversation-1' } = {}) {
  return new PluginConversationHostAdapter({ registry: h.registry, provider: 'chatgpt' }).append_message(
    conversationId,
    text,
    'source-1',
  );
}

const coded =
  (code, check = () => true) =>
  (error) =>
    error?.code === code && check(error);

test('an appended answer is the receipt, and the package got exactly the contract input', async () => {
  const h = await enabledHost();
  h.script[METHODS.append] = { status: 'appended', providerMessageId: 'provider-7', idempotentReplay: true };

  assert.deepEqual(await append(h), { hostMessageId: 'provider-7', idempotentReplay: true });
  assert.deepEqual(
    h.calls(METHODS.append).map((call) => call.input),
    [{ conversationId: 'conversation-1', text: 'hello', idempotencyKey: 'source-1' }],
  );
});

test('HOST_UNAVAILABLE only where nothing can have been sent', async () => {
  const h = await conversationHostHarness();
  await assert.rejects(append(h), coded('HOST_UNAVAILABLE'), 'no package holds the provider');

  await h.enable();
  await h.store.transaction((transaction) => {
    const instance = transaction.instances.get(h.instances[0]);
    transaction.instances.put({ ...instance, activationState: 'disabled' });
  });
  await assert.rejects(
    append(h),
    coded('HOST_UNAVAILABLE', (error) => error.cause?.code === 'INSTANCE_NOT_RUNNABLE'),
    'the Host refused the call before the action ran',
  );
  assert.equal(h.calls(METHODS.append).length, 0);
});

test('once the action ran, a failure is AMBIGUOUS_EFFECT, whatever code it carries', async () => {
  const h = await enabledHost();
  for (const thrown of [
    new Error('package secret text'),
    new ExternalPluginRuntimeError('INSTANCE_NOT_RUNNABLE', 'a Host interface refused the package'),
  ]) {
    h.script[METHODS.append] = () => {
      throw thrown;
    };
    await assert.rejects(
      append(h),
      coded('AMBIGUOUS_EFFECT', (error) => error.cause === thrown && !error.message.includes(thrown.message)),
    );
  }
  assert.equal(h.calls(METHODS.append).length, 2);
});

test('a failed answer keeps its code and replay truth, and only a diagnostic the contract accepts', async () => {
  const h = await enabledHost();
  const cases = [
    [{ status: 'failed', errorCode: 'STALE_EXTENSION', diagnostic: validDiagnostic, idempotentReplay: false }, true],
    [{ status: 'failed', errorCode: 'STALE_EXTENSION', diagnostic: invalidDiagnostic, idempotentReplay: false }, false],
    [{ status: 'failed', errorCode: 'NEEDS_BINDING' }, false],
  ];
  for (const [answer, keepsDiagnostic] of cases) {
    h.script[METHODS.append] = answer;
    await assert.rejects(append(h), (error) => {
      assert.equal(error.code, answer.errorCode);
      assert.equal(error.idempotentReplay, answer.idempotentReplay);
      assert.deepEqual(error.diagnostic, keepsDiagnostic ? validDiagnostic : undefined);
      return true;
    });
  }
});

test('an answer outside the contract is AMBIGUOUS_EFFECT, never a failure', async () => {
  const h = await enabledHost();
  const answers = [
    { status: 'appended', providerMessageId: 'provider-1', extra: true },
    { status: 'appended' },
    { status: 'failed', errorCode: 'not a code' },
    { status: 'failed', errorCode: 'STALE_EXTENSION', extra: true },
    { status: 'failed', errorCode: 'STALE_EXTENSION', extra: true, diagnostic: invalidDiagnostic },
    { status: 'failed', errorCode: 'STALE_EXTENSION', extra: true, diagnostic: validDiagnostic },
    { status: 'queued' },
    null,
    'appended',
    [{ status: 'failed', errorCode: 'STALE_EXTENSION', diagnostic: invalidDiagnostic }],
  ];
  for (const answer of answers) {
    h.script[METHODS.append] = answer;
    await assert.rejects(append(h), coded('AMBIGUOUS_EFFECT'), JSON.stringify(answer));
  }
});

test('a message outside the contract is refused before any call: INVALID_REQUEST', async () => {
  const h = await enabledHost();
  for (const input of [{ text: 'x'.repeat(128 * 1024 + 1) }, { text: '   ' }, { conversationId: 'not/an/id' }]) {
    await assert.rejects(append(h, input), coded('INVALID_REQUEST'));
  }
  assert.equal(h.calls(METHODS.append).length, 0);
});

function bridgeFor(h) {
  const bridge = new CloudInvokeBridge({
    hostAdapter: new PluginConversationHostAdapter({ registry: h.registry, provider: 'chatgpt' }),
    emitFallback: async () => {},
    threadStore: {
      get: async (threadId) => ({ id: threadId, title: threadId, participants: ['gpt-pro'] }),
      getCloudCatBindings: async () => ({ 'gpt-pro': 'https://chatgpt.com/c/conversation-1' }),
      updateCloudCatBinding: async () => {},
    },
  });
  const dispatch = (sourceMessageId) =>
    bridge.dispatchInternal({
      catId: 'gpt-pro',
      threadId: 'thread-1',
      userId: 'user-1',
      threadTitle: 'Test Thread',
      participants: [],
      calledBy: 'opus',
      intent: 'hello',
      sourceMessageId,
    });
  return { dispatch };
}

test('through the bridge the frozen mapping (d) holds', async () => {
  const h = await enabledHost();
  const { dispatch } = bridgeFor(h);
  let sends = 0;
  const outcomeFor = async (answer) => {
    h.script[METHODS.append] = answer;
    const { kind, reason, hostMessageId, failureDiagnostic } = await dispatch(`source-${sends++}`);
    return { kind, reason, hostMessageId, failureDiagnostic };
  };

  assert.deepEqual(await outcomeFor({ status: 'appended', providerMessageId: 'provider-1' }), {
    kind: 'sent',
    reason: undefined,
    hostMessageId: 'provider-1',
    failureDiagnostic: undefined,
  });
  const [sent] = h.calls(METHODS.append);
  assert.equal(sent.input.conversationId, 'conversation-1');
  assert.equal(sent.input.idempotencyKey, 'source-0');

  for (const code of ['NEEDS_BINDING', 'BOUND_CONVERSATION_MISMATCH']) {
    assert.equal((await outcomeFor({ status: 'failed', errorCode: code })).reason, 'needs-binding', code);
  }
  assert.equal((await outcomeFor({ status: 'failed', errorCode: 'HOST_UNAVAILABLE' })).reason, 'no-adapter');
  const stale = await outcomeFor({ status: 'failed', errorCode: 'STALE_EXTENSION', diagnostic: validDiagnostic });
  assert.equal(stale.reason, 'host-append-failed');
  assert.deepEqual(stale.failureDiagnostic, validDiagnostic);
  assert.equal((await outcomeFor({ status: 'failed', errorCode: 'SOMETHING_NEW' })).reason, 'host-append-failed');
  const ambiguous = await outcomeFor(() => {
    throw new Error('the page went away mid-send');
  });
  assert.deepEqual([ambiguous.kind, ambiguous.reason], ['error', 'host-append-failed']);

  await h.disable();
  const before = h.calls(METHODS.append).length;
  assert.equal((await outcomeFor({ status: 'appended', providerMessageId: 'never' })).reason, 'no-adapter');
  assert.equal(h.calls(METHODS.append).length, before, 'a disabled package is never called');
});

test('verified composer rejections remain unsent through the owner-facing receipt', async () => {
  const h = await enabledHost();
  const { dispatch } = bridgeFor(h);
  const cases = [
    { errorCode: 'COMPOSER_NOT_EMPTY', expectedMessage: /草稿/ },
    {
      errorCode: 'COMPOSER_NOT_FOUND',
      expectedMessage:
        '未发送给 @gpt-pro：未找到绑定会话的 ChatGPT 输入框，尚未点击发送。请检查原会话页面与扩展状态后，重新 @gpt-pro 发一条新消息。',
    },
    { errorCode: 'COMPOSER_DOM_UNSUPPORTED', phase: 'empty_check', expectedMessage: /输入框/ },
    { errorCode: 'COMPOSER_DOM_UNSUPPORTED', phase: 'before_submit', expectedMessage: /输入框/ },
  ];
  for (const [index, { errorCode, phase, expectedMessage }] of cases.entries()) {
    const sourceMessageId = `source-composer-${index}`;
    h.script[METHODS.append] = {
      status: 'failed',
      errorCode,
      idempotentReplay: false,
      ...(phase
        ? { diagnostic: { ...validDiagnostic, errorCode, fingerprint: { ...validDiagnostic.fingerprint, phase } } }
        : {}),
    };
    const outcome = await dispatch(sourceMessageId);
    const status = JSON.parse(
      buildCloudBridgeStatusContent({
        catId: 'gpt-pro',
        outcome,
        audit: {
          sourceMessageId,
          sourceSender: { kind: 'user', id: 'user-1' },
          dispatchInvocationId: `inv-composer-${index}`,
        },
      }),
    );
    assert.equal(status.outboundReceipt.status, 'failed', errorCode);
    assert.equal(outcome.errorCode, errorCode);
    assert.match(status.message, /^未发送给 @gpt-pro/);
    if (typeof expectedMessage === 'string') assert.equal(status.message, expectedMessage);
    else assert.match(status.message, expectedMessage);
    assert.equal(status.outboundReceipt.idempotency.disposition, 'fresh');
    assert.equal(h.calls(METHODS.append).length, index + 1, 'reporting a rejection must not retry the message');
  }
});

test('post-submit observation failures and unproven effects stay unknown', async () => {
  const h = await enabledHost();
  const { dispatch } = bridgeFor(h);
  const cases = [
    { status: 'failed', errorCode: 'HOST_MESSAGE_NOT_OBSERVED' },
    { status: 'failed', errorCode: 'HOST_MESSAGE_ID_UNAVAILABLE' },
    { status: 'failed', errorCode: 'AMBIGUOUS_EFFECT' },
    { status: 'failed', errorCode: 'COMPOSER_DOM_UNSUPPORTED' },
    {
      status: 'failed',
      errorCode: 'COMPOSER_DOM_UNSUPPORTED',
      diagnostic: {
        ...validDiagnostic,
        errorCode: 'COMPOSER_DOM_UNSUPPORTED',
        fingerprint: { ...validDiagnostic.fingerprint, phase: 'inserted' },
      },
    },
    () => {
      throw Object.assign(new Error('unverified rejection'), { code: 'COMPOSER_NOT_EMPTY' });
    },
  ];
  for (const [index, answer] of cases.entries()) {
    const sourceMessageId = `source-unknown-${index}`;
    h.script[METHODS.append] = answer;
    const outcome = await dispatch(sourceMessageId);
    const status = JSON.parse(
      buildCloudBridgeStatusContent({
        catId: 'gpt-pro',
        outcome,
        audit: {
          sourceMessageId,
          sourceSender: { kind: 'user', id: 'user-1' },
          dispatchInvocationId: `inv-unknown-${index}`,
        },
      }),
    );
    assert.equal(status.outboundReceipt.status, 'unknown');
    assert.match(status.message, /结果未知/);
    assert.equal(h.calls(METHODS.append).length, index + 1, 'an unknown effect must not trigger another append');
  }
});

test('a mismatched diagnostic code cannot prove a pre-submit composer rejection', async () => {
  const h = await enabledHost();
  const { dispatch } = bridgeFor(h);
  h.script[METHODS.append] = {
    status: 'failed',
    errorCode: 'COMPOSER_DOM_UNSUPPORTED',
    diagnostic: {
      ...validDiagnostic,
      errorCode: 'COMPOSER_NOT_FOUND',
      fingerprint: { ...validDiagnostic.fingerprint, phase: 'empty_check' },
    },
  };
  const sourceMessageId = 'source-mismatched-diagnostic';
  const outcome = await dispatch(sourceMessageId);
  assert.equal(outcome.errorCode, 'COMPOSER_DOM_UNSUPPORTED');
  assert.equal(outcome.failureDiagnostic.errorCode, 'COMPOSER_NOT_FOUND');
  const status = JSON.parse(
    buildCloudBridgeStatusContent({
      catId: 'gpt-pro',
      outcome,
      audit: {
        sourceMessageId,
        sourceSender: { kind: 'user', id: 'user-1' },
        dispatchInvocationId: 'inv-mismatched-diagnostic',
      },
    }),
  );
  assert.equal(status.outboundReceipt.status, 'unknown');
  assert.match(status.message, /结果未知/);
});

test('an untyped adapter error cannot prove a composer rejection', async () => {
  const { outcome } = await dispatchBoundConversationThroughHost({
    adapter: {
      async append_message() {
        throw Object.assign(new Error('unverified rejection'), { code: 'COMPOSER_NOT_EMPTY' });
      },
    },
    boundUrl: 'https://chatgpt.com/c/conversation-1',
    renderedPrompt: 'hello',
    params: { sourceMessageId: 'source-untyped' },
  });
  const status = JSON.parse(
    buildCloudBridgeStatusContent({
      catId: 'gpt-pro',
      outcome,
      audit: {
        sourceMessageId: 'source-untyped',
        sourceSender: { kind: 'user', id: 'user-1' },
        dispatchInvocationId: 'inv-untyped',
      },
    }),
  );
  assert.equal(outcome.errorCode, undefined);
  assert.equal(status.outboundReceipt.status, 'unknown');
  assert.match(status.message, /结果未知/);
});
