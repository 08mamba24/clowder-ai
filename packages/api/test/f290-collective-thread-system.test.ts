import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type IThreadStore, ThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.js';

export async function verify(store: IThreadStore) {
  const thread = await store.create('owner', 'Collective endpoint');
  assert.equal(await store.claimSystemKind(thread.id, 'other', 'collective_channel'), false);
  assert.equal(await store.claimSystemKind(thread.id, 'owner', 'collective_channel'), true);
  assert.equal((await store.get(thread.id))?.systemKind, 'collective_channel');
  assert.equal(await store.claimSystemKind(thread.id, 'owner', 'collective_channel'), true);
  assert.equal(await store.claimSystemKind(thread.id, 'owner', 'cat_bedroom'), false);
  const deleted = await store.create('owner', 'Deleted endpoint');
  await store.softDelete(deleted.id);
  assert.equal(await store.claimSystemKind(deleted.id, 'owner', 'collective_channel'), false);
}

test('system classification is exact-owner CAS without overwriting another system kind', async () =>
  verify(new ThreadStore()));
