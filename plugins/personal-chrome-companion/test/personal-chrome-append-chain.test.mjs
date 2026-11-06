import assert from 'node:assert/strict';
import test from 'node:test';
import { healthChainFixture } from './helpers/health-chain-fixture.mjs';

const input = { conversationId: 'conversation-7', text: 'hello', idempotencyKey: 'source-message-7' };

for (const [name, tabs, errorCode] of [
  ['closed', [], 'BOUND_TAB_NOT_FOUND'],
  ['duplicate', [{ id: 7, url: 'https://chatgpt.com/c/conversation-7' },
    { id: 8, url: 'https://chatgpt.com/c/conversation-7' }], 'AMBIGUOUS_BOUND_TABS'],
]) {
  test(`an append with ${name} tabs preserves its failure without requesting extension reload`, async (t) => {
    const f = await healthChainFixture(t, { tabs });
    assert.equal((await f.hostTest()).ok, true);
    const result = await f.hostAppend(input);
    assert.equal(result.errorCode, errorCode);
    assert.equal((await f.hostStatus()).data.delivery.reloadRequired, false);
    assert.equal(f.contentRequests.length, 0, 'no page was asked to append');
    const [entry] = await f.ledger();
    assert.equal(entry.errorCode, errorCode);
    assert.equal(entry.submitted, undefined);
    assert.equal(entry.observedRevisions.pageAdapter, 'unobserved');
  });
}

test('a submitted append with a lost page receipt remains unknown through the entire chain and is never replayed', async (t) => {
  const f = await healthChainFixture(t, { appendOutcome: 'lost' });
  assert.equal((await f.hostTest()).ok, true);
  const result = await f.hostAppend(input);
  assert.equal(result.errorCode, 'SUBMISSION_OUTCOME_UNKNOWN');
  assert.equal((await f.hostStatus()).data.delivery.reloadRequired, false);
  const [entry] = await f.ledger();
  assert.equal(entry.errorCode, 'SUBMISSION_OUTCOME_UNKNOWN');
  assert.equal(entry.submitted, true, 'unknown must retain the evidence of an actual submission');
  assert.equal(typeof entry.submittedAt, 'string');
  const replay = await f.hostAppend(input);
  assert.equal(replay.errorCode, 'SUBMISSION_OUTCOME_UNKNOWN');
  assert.equal(replay.idempotentReplay, true);
  assert.equal(f.contentRequests.filter(({ request }) => request.kind === 'append_message_v2').length, 1);
  assert.equal(f.nativeRequests.filter(({ kind }) => kind === 'append_message').length, 1);
});

test('an unavailable content adapter is a page failure rather than an extension revision mismatch', async (t) => {
  const f = await healthChainFixture(t, { appendOutcome: 'content-unavailable' });
  assert.equal((await f.hostTest()).ok, true);
  assert.equal((await f.hostAppend(input)).errorCode, 'CONTENT_SCRIPT_UNAVAILABLE');
  assert.equal((await f.hostStatus()).data.delivery.reloadRequired, false);
  assert.equal(f.contentRequests.filter(({ request }) => request.kind === 'append_message_v2').length, 0);
});

test('the worker treats an unobserved successful page receipt as unknown rather than certifying an append', async (t) => {
  const f = await healthChainFixture(t, { appendOutcome: 'unobserved-success' });
  assert.equal((await f.hostTest()).ok, true);
  assert.equal((await f.hostAppend(input)).errorCode, 'SUBMISSION_OUTCOME_UNKNOWN');
  assert.equal((await f.hostStatus()).data.delivery.reloadRequired, false);
  assert.equal((await f.ledger())[0].hostMessageId, undefined);
});

test('a stale page remains a page warning rather than requesting a global extension reload', async (t) => {
  const f = await healthChainFixture(t);
  assert.equal((await f.hostTest()).ok, true);
  f.state.pageAdapter = '2026-09-02.1';
  assert.equal((await f.hostAppend(input)).errorCode, 'STALE_PAGE_ADAPTER');
  const delivery = (await f.hostStatus()).data.delivery;
  assert.equal(delivery.pageReloadRequired, true);
  assert.equal(delivery.reloadRequired, false);
  assert.equal((await f.ledger())[0].errorCode, 'STALE_PAGE_ADAPTER');
});

for (const [name, options, errorCode] of [
  ['helper', { helper: `sha512:${'0'.repeat(128)}` }, 'STALE_HELPER'],
  ['extension', { extension: '0.2.11' }, 'STALE_EXTENSION'],
  ['page adapter', { pageAdapter: '2026-09-02.1' }, 'STALE_PAGE_ADAPTER'],
]) {
  test(`an append still rejects a genuinely mismatched ${name}`, async (t) => {
    const f = await healthChainFixture(t, options);
    const result = await f.hostAppend(input);
    assert.equal(result.errorCode, errorCode);
    assert.equal((await f.hostStatus()).data.delivery.reloadRequired, true);
    assert.equal(f.contentRequests.filter(({ request }) => request.kind === 'append_message_v2').length, 0);
  });
}
