import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { SessionSealer } from '../src/domains/cats/services/session/SessionSealer.js';
import { TranscriptWriter } from '../src/domains/cats/services/session/TranscriptWriter.js';
import {
  type ISessionChainStore,
  SessionChainStore,
} from '../src/domains/cats/services/stores/ports/SessionChainStore.js';

const base = { userId: 'owner', catId: createCatId('codex-sol'), threadId: 'public-endpoint' };
const scoped = (invocationId: string) => ({
  invocationId,
  executionScope: 'collective-participation' as const,
  originMessageId: `message:${invocationId}`,
});

export async function verifyScopedWithoutHome(store: ISessionChainStore) {
  const input = { ...base, threadId: 'no-home-endpoint' };
  const publicRecord = await store.create({ ...input, scopedInvocation: scoped('public-alone') });
  const privateRecord = await store.create({
    ...input,
    scopedInvocation: {
      ...scoped('private-alone'),
      executionScope: 'collective-work',
      taskId: 'task',
      executionRef: 'execution',
      executionRevision: 1,
      authorityRef: 'authority',
    },
  });
  await store.bindCliSessionIdIfUnbound(publicRecord.id, 'PUBLIC_NATIVE_CANARY');
  await store.bindCliSessionIdIfUnbound(privateRecord.id, 'PRIVATE_NATIVE_CANARY');
  for (let repeat = 0; repeat < 2; repeat++) {
    assert.equal(
      await store.getActive(input.catId, input.threadId, input.userId),
      null,
      'an owner fallback must not adopt either active scoped node',
    );
    assert.equal(await store.getActive(input.catId, input.threadId), null);
  }
  const home = await store.getOrCreateActive(input);
  assert.notEqual(home.id, publicRecord.id);
  assert.notEqual(home.id, privateRecord.id);
  assert.equal(home.cliSessionId, undefined);
  assert.equal((await store.getActive(input.catId, input.threadId, input.userId))?.id, home.id);
  await store.update(home.id, { status: 'sealed' });
  assert.equal(
    await store.getActive(input.catId, input.threadId, input.userId),
    null,
    'after home closes the still-running scoped nodes remain observation only',
  );
  assert.equal((await store.getChain(input.catId, input.threadId, input.userId)).length, 3);
}

test('scoped-only chains cannot be adopted by home fallback, even after a later home session closes', async () => {
  await verifyScopedWithoutHome(new SessionChainStore());
});

export async function verifyScopedSessionStore(store: ISessionChainStore) {
  const home = await store.create({ ...base, cliSessionId: 'HOME_SESSION_CANARY' });
  const [first, second] = await Promise.all(
    ['child-A', 'child-B'].map(async (id) => {
      const input = { ...base, scopedInvocation: scoped(id) };
      return store.create(input);
    }),
  );
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.seq, second.seq, 'concurrent scoped calls must atomically allocate unique sequence numbers');
  assert.equal(
    (await store.getActive(base.catId, base.threadId, base.userId))?.id,
    home.id,
    'scoped creation must never replace the ordinary home active/resume index',
  );
  assert.equal((await store.bindCliSessionIdIfUnbound(first.id, 'real-scoped-A'))?.cliSessionId, 'real-scoped-A');
  assert.equal(await store.bindCliSessionIdIfUnbound(first.id, 'wrong-scoped-B'), null);
  assert.equal(await store.bindCliSessionId(first.id, 'wrong-manual-bind'), null);
  await assert.rejects(
    async () => store.update(first.id, { cliSessionId: 'wrong-manual-update' }),
    /scoped_session_identity_immutable/,
  );
  const sealer = new SessionSealer(store);
  await sealer.requestSeal({ sessionId: first.id, reason: 'scoped_complete' });
  assert.equal((await sealer.finalize({ sessionId: first.id })).sealed, true);
  assert.equal((await store.getActive(base.catId, base.threadId, base.userId))?.id, home.id);
  assert.deepEqual((await store.get(first.id))?.scopedInvocation, scoped('child-A'));
  assert.equal(
    (
      await store.restoreActiveSession({
        targetSessionId: first.id,
        expectedActiveSessionId: home.id,
        displacedSealReason: 'manual',
      })
    ).status,
    'target_not_restorable',
  );
  assert.equal((await store.getActive(base.catId, base.threadId, base.userId))?.id, home.id);
  assert.equal((await store.get(home.id))?.status, 'active');
  await assert.rejects(async () => store.update(first.id, { status: 'active' }), /scoped_session_not_resumable/);
  await assert.rejects(
    async () => store.create({ ...base, cliSessionId: 'real-scoped-A', reuseExistingCliSession: true }),
    /scoped_session_not_resumable/,
  );
  await assert.rejects(
    async () => store.getOrCreateActive({ ...base, scopedInvocation: scoped('invalid-resume') }),
    /scoped_session_not_resumable/,
  );
  assert.equal((await store.get(first.id))?.status, 'sealed');
}

test('one-shot scoped records preserve home active identity through create, bind, seal and restore refusal', async () => {
  await verifyScopedSessionStore(new SessionChainStore());
});

test('scoped sealing archives the real transcript without home memory, generative digest or post-seal side effects', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'f290-scoped-seal-'));
  try {
    const store = new SessionChainStore();
    const writer = new TranscriptWriter({ dataDir: directory });
    const input = { ...base, scopedInvocation: scoped('child-archive') };
    const record = await store.create(input);
    await writer.appendDurableEvent(
      { sessionId: record.id, ...base, seq: record.seq },
      { type: 'text', catId: base.catId, content: 'Real public-only output' },
      'child-archive',
    );
    let privateReads = 0;
    let hooks = 0;
    const sealer = new SessionSealer(store, writer, undefined, undefined, {
      getBootstrapDepth() {
        privateReads++;
        return 'generative';
      },
      async resolveProfile() {
        privateReads++;
        return null;
      },
    });
    sealer.registerPostSealHook(async () => {
      hooks++;
    });
    await sealer.requestSeal({ sessionId: record.id, reason: 'scoped_complete' });
    assert.deepEqual(await sealer.finalize({ sessionId: record.id }), { sealed: true, clean: true });
    assert.equal(privateReads, 0, 'an external scoped call cannot start a home digest operation');
    assert.equal(hooks, 0, 'scoped completion cannot trigger ordinary home post-seal hooks');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
