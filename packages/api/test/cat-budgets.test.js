import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

const { clearBudgetCache, getAllCatCapacities, getCatCapacity } = await import('../dist/config/cat-budgets.js');

describe('cat capacity projections (#1208)', () => {
  before(() => clearBudgetCache());

  it('exposes capacity provenance without prompt-policy knobs', () => {
    const capacity = getCatCapacity('opus');
    assert.equal(typeof capacity.windowTokens, 'number');
    assert.equal(typeof capacity.inputCeilingTokens, 'number');
    assert.equal(typeof capacity.source, 'string');
    assert.equal(typeof capacity.actionable, 'boolean');
    assert.equal('budget' in capacity, false);
    assert.equal('maxPromptTokens' in capacity, false);
    assert.equal('maxMessages' in capacity, false);
  });

  it('projects every registered member', () => {
    const capacities = getAllCatCapacities();
    assert.ok(Object.keys(capacities).length > 0);
    for (const capacity of Object.values(capacities)) {
      assert.equal(typeof capacity.provenance, 'string');
      assert.equal('bindingKey' in capacity, false);
      assert.equal('fingerprint' in capacity, false);
      assert.equal('observedAt' in capacity, false);
    }
  });

  it('empty-UI helper cats resolve to origin 400k-class defaults', () => {
    for (const catId of ['glm', 'deepseek', 'minimax']) {
      const capacity = getCatCapacity(catId);
      assert.ok(
        capacity.windowTokens >= 400_000,
        `${catId} windowTokens=${capacity.windowTokens} should be origin 400k-class, not GLOBAL_FALLBACK`,
      );
      assert.notEqual(capacity.source, 'unresolved', `${catId} empty-UI must not stay unresolved`);
      assert.equal('maxPromptTokens' in capacity, false);
    }
  });
});
