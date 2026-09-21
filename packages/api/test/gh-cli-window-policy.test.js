import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_ROOT = join(API_ROOT, 'src');

function collectTypeScriptFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectTypeScriptFiles(path);
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  });
}

function cliResolverBindings(source) {
  const bindings = new Set();
  function visit(node) {
    ts.forEachChild(node, visit);
    // Resolving an executable path does not launch a child. Match the imported
    // export, including aliases, rather than exempting arbitrary function names.
    if (
      !ts.isVariableDeclaration(node) ||
      !ts.isObjectBindingPattern(node.name) ||
      !node.initializer ||
      !ts.isAwaitExpression(node.initializer) ||
      !ts.isCallExpression(node.initializer.expression)
    )
      return;
    const call = node.initializer.expression;
    const module = call.arguments[0];
    if (
      call.expression.kind !== ts.SyntaxKind.ImportKeyword ||
      !module ||
      !ts.isStringLiteral(module) ||
      !module.text.endsWith('/utils/cli-resolve.js')
    )
      return;
    for (const binding of node.name.elements) {
      if ((binding.propertyName ?? binding.name).getText(source) === 'resolveCliCommand') {
        bindings.add(binding.name.getText(source));
      }
    }
  }
  visit(source);
  return bindings;
}

describe('gh CLI child-process policy', () => {
  it('hides every direct Node gh invocation on Windows', () => {
    const ghCalls = [];

    for (const path of collectTypeScriptFiles(SOURCE_ROOT)) {
      const sourceText = readFileSync(path, 'utf8');
      const source = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true);
      const resolvers = cliResolverBindings(source);

      function getOptionsArgument(node) {
        if (node.arguments.length >= 3) return node.arguments[2];
        if (node.arguments.length === 2 && !ts.isArrayLiteralExpression(node.arguments[1])) return node.arguments[1];
        return undefined;
      }

      function visit(node) {
        if (ts.isCallExpression(node)) {
          const command = node.arguments[0];
          const isResolver = ts.isIdentifier(node.expression) && resolvers.has(node.expression.text);
          if (!isResolver && command && ts.isStringLiteral(command) && command.text === 'gh') {
            const options = getOptionsArgument(node);
            const optionsText = options?.getText(source) ?? '';
            const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
            ghCalls.push({
              location: `${relative(API_ROOT, path)}:${line}`,
              hidden: optionsText.includes('withHiddenGhCliWindow') || optionsText.includes('getGitHubExecOptions'),
            });
          }
        }
        ts.forEachChild(node, visit);
      }

      visit(source);
    }

    assert.ok(ghCalls.length > 0, 'expected to find direct gh child-process calls');
    assert.deepEqual(
      ghCalls.filter((call) => !call.hidden).map((call) => call.location),
      [],
      'all direct gh child-process calls must use the shared hidden-window options',
    );
  });

  it('exempts only the CLI path resolver export, preserving process-call checks', () => {
    const source = ts.createSourceFile(
      'fixture.ts',
      `const { resolveCliCommand: locateGh, execFile: launch } = await import('./utils/cli-resolve.js');
       const { resolveCliCommand: otherModule } = await import('./not-a-resolver.js');
       const { resolveCliCommand: processCall } = await import('node:child_process');`,
      ts.ScriptTarget.Latest,
      true,
    );
    assert.deepEqual([...cliResolverBindings(source)], ['locateGh']);
  });
});
