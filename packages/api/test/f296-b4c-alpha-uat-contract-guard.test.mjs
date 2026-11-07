import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { invocationRequestBody } from '../../../scripts/f296-alpha-uat.mjs';
import { sendMessageSchema } from '../dist/routes/messages.schema.js';

// Anti-drift guard for the F296 Alpha UAT harness: upstream unified the
// message delivery lifecycle (#1398) and removed `deliveryMode`, which the
// harness kept sending — the drift only surfaced as a 400 on a real Alpha
// acceptance run. The schema's catId validation depends on the live roster and
// its strict+refine chain hides the raw shape, so membership is probed through
// the public parse behavior: an unknown key reports `unrecognized_keys`, a
// known key reports any other issue class.
function isUnrecognizedKey(key) {
  const parsed = sendMessageSchema.safeParse({ [key]: 'sentinel' });
  if (parsed.success) return false;
  return parsed.error.issues.some(
    (issue) => issue.code === 'unrecognized_keys' && (issue.keys ?? []).includes(key),
  );
}

describe('f296 alpha UAT contract guard', () => {
  test('invocation request body keys stay inside the live sendMessageSchema', () => {
    const body = invocationRequestBody({
      threadId: 'thread_f296guard',
      catId: 'codex',
      content: 'Reply with the single word OK.',
    });
    const unknownKeys = Object.keys(body).filter((key) => isUnrecognizedKey(key));
    assert.deepEqual(
      unknownKeys,
      [],
      `UAT POST /api/messages body keys drifted outside sendMessageSchema: ${JSON.stringify(unknownKeys)}`,
    );
  });

  test('the guard probe itself detects a removed key (self-check)', () => {
    assert.equal(isUnrecognizedKey('deliveryMode'), true);
    assert.equal(isUnrecognizedKey('content'), false);
  });

  test('legacy deliveryMode key is not reintroduced', () => {
    const body = invocationRequestBody({
      threadId: 'thread_f296guard',
      catId: 'codex',
      content: 'Reply with the single word OK.',
    });
    assert.equal('deliveryMode' in body, false);
  });
});
