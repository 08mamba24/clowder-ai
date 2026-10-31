import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { constrainedGhApiOperation } from './native-effect-github-classifier.mjs';
import { observedGhOperation } from './native-effect-invocation-targets.mjs';

// The pinned repository gh wrapper chain: an absolute-path invocation of the
// content-verified guarded gh (deployed under a cat-cafe-runtime component)
// normalizes to its delegated argv and classifies with an honest effect.
// Anything else — tampered bytes, unpinned binaries — proves nothing.

// The delegate proof requires the real gh binary to resolve as an ordinary
// executable. Interactive machines often front PATH with another guarded
// wrapper; deployments carry CAT_CAFE_REAL_GH_PATH for exactly this reason.
const REAL_GH = '/opt/homebrew/bin/gh';
if (process.env.CAT_CAFE_REAL_GH_PATH === undefined && existsSync(REAL_GH)) {
  process.env.CAT_CAFE_REAL_GH_PATH = REAL_GH;
}

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function runtimeWrapperFixture({ tamper = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gh-wrapper-chain-'));
  roots.push(root);
  const dir = join(root, 'cat-cafe-runtime', 'scripts', 'guarded-bin');
  mkdirSync(dir, { recursive: true });
  const wrapper = join(dir, 'gh');
  copyFileSync(resolve('scripts/guarded-bin/gh'), wrapper);
  chmodSync(wrapper, 0o755);
  if (tamper) writeFileSync(wrapper, '#!/bin/sh\nexec gh "$@"\n');
  return { root, wrapper };
}

describe('pinned repository gh wrapper chain (allow paths)', () => {
  it('classifies a verified wrapper pr view as an honest read', () => {
    const { root, wrapper } = runtimeWrapperFixture();
    const operation = observedGhOperation(`${wrapper} pr view 123`, root);
    assert.deepEqual(operation, { effect: 'read', target: 'github://current/pull/123' });
  });

  it('classifies a verified wrapper api read as an honest read', () => {
    const { root, wrapper } = runtimeWrapperFixture();
    const operation = observedGhOperation(`${wrapper} api repos/o/r`, root);
    assert.deepEqual(operation, { effect: 'read', target: 'github://api/repos/o/r' });
  });

  it('keeps inline GraphQL documents honest: query reads, mutations report as remote mutations', () => {
    const { root, wrapper } = runtimeWrapperFixture();
    const read = observedGhOperation(`${wrapper} api graphql -f 'query=query{viewer{login}}'`, root);
    assert.equal(read?.effect, 'read');
    const mutation = observedGhOperation(
      `${wrapper} api graphql -f 'query=mutation{deleteIssue(input:{id:"x"}){clientMutationId}}'`,
      root,
    );
    // #59/#60 semantics: a document mentioning mutation/subscription anywhere
    // is conservatively a remote mutation — honest effect, never a certified read.
    assert.equal(mutation?.effect, 'remote_mutation');
  });
});

describe('pinned repository gh wrapper chain (deny paths)', () => {
  it('classifies wrapper PR creation as a remote mutation', () => {
    const { root, wrapper } = runtimeWrapperFixture();
    const operation = observedGhOperation(`${wrapper} pr create --title x --head y`, root);
    assert.deepEqual(operation, { effect: 'remote_mutation', target: 'github://current/pulls' });
  });

  it('refuses a wrapper whose bytes do not match the pin', () => {
    const { root, wrapper } = runtimeWrapperFixture({ tamper: true });
    assert.equal(observedGhOperation(`${wrapper} pr view 123`, root), null);
  });

  it('never certifies an unpinned gh binary outside the guarded wrapper', () => {
    const { root } = runtimeWrapperFixture();
    if (!existsSync(REAL_GH)) return; // environment without a real gh binary
    assert.equal(observedGhOperation(`${REAL_GH} pr view 123`, root), null);
  });

  it('refuses a wrapper body-file input that names a protected path (PR60)', () => {
    const { root, wrapper } = runtimeWrapperFixture();
    const protectedBody = join(root, 'cat-cafe-runtime', 'private.md');
    writeFileSync(protectedBody, 'runtime secret\n');
    // The file channel is the whole point of the refusal: -F and --body-file are the
    // same input, and neither may be certified as a remote operation when the body
    // they read comes out of the runtime sanctuary.
    for (const flag of ['--body-file', '-F']) {
      assert.equal(
        observedGhOperation(`${wrapper} pr create --repo a/b --title t ${flag} '${protectedBody}'`, root),
        null,
        flag,
      );
    }
  });

  it('keeps payload-free reads free of header inputs, and raw fields stay uncertified reads never', () => {
    // A header input alone still classifies as a plain read (GET), but the
    // payload-free view must refuse it: headers can attach content to requests.
    assert.notEqual(constrainedGhApiOperation('gh api repos/o/r -H X:1'), null);
    assert.equal(constrainedGhApiOperation('gh api repos/o/r -H X:1', { payloadFree: true }), null);
    // Raw -f fields make the request a POST; they are never certified as reads
    // with or without the payload-free view.
    assert.equal(constrainedGhApiOperation('gh api repos/o/r -f key=value'), null);
    assert.equal(constrainedGhApiOperation('gh api repos/o/r -f key=value', { payloadFree: true }), null);
    // GraphQL documents carry inline body semantics; the payload-free view must
    // never certify them even when the document reads as a pure query (R6).
    assert.notEqual(constrainedGhApiOperation("gh api graphql -f 'query=query{viewer{login}}'"), null);
    assert.equal(
      constrainedGhApiOperation("gh api graphql -f 'query=query{viewer{login}}'", { payloadFree: true }),
      null,
    );
  });
});
