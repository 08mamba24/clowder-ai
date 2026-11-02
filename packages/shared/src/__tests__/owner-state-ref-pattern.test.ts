import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { OWNER_STATE_REF_PATTERN, ownerTruthRefV1Schema } from '../types/capability-evolution-refs.js';

describe('OWNER_STATE_REF_PATTERN (DSH-portable kind:id)', () => {
  it('accepts canonical kind:id shapes used in fixtures', () => {
    for (const ownerStateRef of [
      'feature:abc',
      'approval:F266:microduck-adopt-v1:accepted',
      'asset-version:video-forge-v1',
      'measurement-proof:../escape',
      'eval-trigger:evolve-video-skill',
      'capability:%E7%8C%AB%E7%8C%AB',
      'hf-model:owner/microduck-push-range@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa#exported/policy.onnx',
      'capture:sha256:4444444444444444444444444444444444444444444444444444444444444444',
    ]) {
      assert.equal(OWNER_STATE_REF_PATTERN.test(ownerStateRef), true, ownerStateRef);
      assert.equal(
        ownerTruthRefV1Schema.safeParse({ ownerFeatureId: 'F311', ownerStateRef }).success,
        true,
        ownerStateRef,
      );
    }
  });

  it('rejects whitespace and JSON-looking payload characters', () => {
    for (const ownerStateRef of [
      'bad:has space',
      'bad:has{brace}',
      'bad:has[bracket]',
      'bad:has"quote"',
      "bad:has'quote'",
      'NotKind:id',
      ':missing-kind',
      'prefix capability:valid',
      'capability:valid suffix',
    ]) {
      assert.equal(OWNER_STATE_REF_PATTERN.test(ownerStateRef), false, ownerStateRef);
      assert.equal(
        ownerTruthRefV1Schema.safeParse({ ownerFeatureId: 'F311', ownerStateRef }).success,
        false,
        ownerStateRef,
      );
    }
  });

  it('advertises an allowlist id class (no denylist brackets that break DSH ACP)', () => {
    // The DSH-rejected form embeds `[^\s{}[\]...]` — a raw `[` after `{`.
    const source = OWNER_STATE_REF_PATTERN.source;
    assert.equal(source.includes('{}['), false, source);
    const delivered = new RegExp(JSON.parse(JSON.stringify({ pattern: source })).pattern);
    assert.equal(delivered.test('capability:%E7%8C%AB%E7%8C%AB'), true);
    assert.equal(delivered.test('prefix capability:valid'), false);
    assert.equal(delivered.test('capability:valid suffix'), false);
  });
});
