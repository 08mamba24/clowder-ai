/**
 * Live acceptance found fresh MCP quota while an actual execution had no
 * causal.routingPreflight. Fixtures supplied the port themselves and missed
 * the deliberately retired global gate. Only quota-scoped execution may be
 * connected; callback admission and terminal feedback must stay disconnected.
 * Check production object boundaries without booting the real API/data.
 * Runtime behavior is exercised by usage-monitor-routing and routing-preflight.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import ts from 'typescript';

const file = ts.createSourceFile(
  'index.ts',
  readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);

function findNode(predicate) {
  let found;
  function visit(node) {
    if (found) return;
    if (predicate(node)) found = node;
    else ts.forEachChild(node, visit);
  }
  visit(file);
  assert.ok(found, 'production composition boundary must exist');
  return found;
}

function compositionProperties(object) {
  while (ts.isSatisfiesExpression(object) || ts.isAsExpression(object) || ts.isParenthesizedExpression(object)) {
    object = object.expression;
  }
  assert.ok(ts.isObjectLiteralExpression(object));
  return object.properties.flatMap((node) => {
    if (ts.isPropertyAssignment(node)) return [node];
    if (!ts.isSpreadAssignment(node)) return [];
    let value = node.expression;
    while (ts.isParenthesizedExpression(value)) value = value.expression;
    if (!ts.isConditionalExpression(value)) return [];
    if (value.condition.getText(file) !== 'routingContextRuntime') return [];
    return ts.isObjectLiteralExpression(value.whenTrue) ? [...value.whenTrue.properties] : [];
  });
}

function assertLivePreflightPort(object, boundary) {
  const properties = compositionProperties(object);
  const property = properties.find(
    (node) => ts.isPropertyAssignment(node) && node.name.getText(file) === 'routingDispatchPreflight',
  );
  assert.ok(property, `${boundary} must receive the live routingDispatchPreflight port`);
  assert.equal(property.initializer.getText(file), 'routingContextRuntime.usageMonitorDispatchPreflight');
  assert.ok(
    !properties.some(
      (node) => ts.isPropertyAssignment(node) && node.name.getText(file) === 'routingDispatchSignalObserver',
    ),
  );
}

describe('usage-monitor production dispatch composition', () => {
  it('supplies the live quota preflight to actual serial/parallel execution', () => {
    const router = findNode((node) => ts.isNewExpression(node) && node.expression.getText(file) === 'AgentRouter');
    assertLivePreflightPort(router.arguments[0], 'AgentRouter');
  });

  it('keeps callback queue admission and terminal availability feedback retired', () => {
    const callbacks = findNode((node) => ts.isVariableDeclaration(node) && node.name.getText(file) === 'callbackOpts');
    const properties = compositionProperties(callbacks.initializer);
    for (const name of ['routingDispatchPreflight', 'routingDispatchSignalObserver']) {
      assert.ok(
        !properties.some((node) => ts.isPropertyAssignment(node) && node.name.getText(file) === name),
        `${name} must stay disconnected from callbacks`,
      );
    }
  });
});
