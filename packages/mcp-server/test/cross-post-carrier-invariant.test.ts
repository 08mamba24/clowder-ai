/**
 * Cross-post carrier invariant — upstream #577/#1397 mitigation pin.
 *
 * The sender-side rule lives in tool descriptions (prompt layer can be
 * re-budgeted; these schema surfaces must keep the rule):
 *   - carrier is decided by subject ownership, not recipient name/activity;
 *   - stay in-thread only when the current thread owns the subject;
 *   - feature-id lookup to locate an owner thread stays legal.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { crossPostMessageInputSchema, listThreadsInputSchema } from '../src/tools/callback-tools.js';

describe('cross-post carrier invariant (F193 round-2, upstream #577/#1397)', () => {
  test('cross_post_message threadId description states the subject-ownership carrier rule', () => {
    const desc = crossPostMessageInputSchema.threadId.description ?? '';
    assert.ok(/Carrier-ownership rule/.test(desc), 'must name the carrier-ownership rule');
    assert.ok(
      /Stay in-thread .* when the current thread owns the subject/.test(desc),
      'stay-in-thread must be conditioned on current-thread subject ownership',
    );
    assert.ok(
      /picking a thread by recipient name or recent activity is not/.test(desc),
      'must forbid carrier selection by recipient name/activity',
    );
  });

  test('list_threads keyword description marks the lookup-aid boundary', () => {
    const desc = listThreadsInputSchema.keyword.description ?? '';
    assert.ok(/Lookup aid only/.test(desc), 'must be marked as a lookup aid');
    assert.ok(
      /locating a subject-owner thread by feature id is fine/.test(desc),
      'feature-id owner-thread lookup must stay legal',
    );
    assert.ok(
      /cat-name\/activity matches as the delivery destination .* is not/.test(desc),
      'must forbid cat-name/activity matches as delivery destination',
    );
  });
});
