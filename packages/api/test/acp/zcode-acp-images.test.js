import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { assistantText, ZCODE_TEST_PNG as PNG, startAdapter } from './helpers/zcode-acp-test-harness.mjs';

const IMAGE = { type: 'image', mimeType: 'image/png', data: PNG };
const providers = await import(
  '../../dist/domains/cats/services/agents/providers/acp/zcode/zcode-acp-provider-paths.js'
);

async function withAdapter(run, model = 'glm-5.4') {
  const dir = mkdtempSync(join(tmpdir(), 'zcode-image-contract-'));
  const acp = startAdapter(dir, { ZCODE_MODEL: model });
  try {
    const init = await acp.request('initialize', { protocolVersion: 1 });
    const created = await acp.request('session/new', { cwd: dir, mcpServers: [] });
    await run(acp, created.result.sessionId, init);
  } finally {
    acp.child.kill('SIGTERM');
  }
}

it('GLM-5.4 has one consistent image declaration in provider rules and ACP negotiation', async () => {
  const home = mkdtempSync(join(tmpdir(), 'zcode-image-provider-'));
  const personal = providers.createZcodeProviderConfig(home, { ZCODE_MODEL: 'glm-5.4' });
  try {
    const config = JSON.parse(readFileSync(personal.path, 'utf8')).config;
    assert.equal(config.modelConfigRules.providerModelRules[0]?.config.properties.inputFormat.supportsImage, true);
  } finally {
    personal.dispose();
  }
  await withAdapter(async (_acp, _id, init) => {
    assert.equal(init.result.agentCapabilities.promptCapabilities.image, true);
  });
});

it('image-only ACP input reaches the native attachment channel with identical bytes', async () => {
  await withAdapter(async (acp, sessionId) => {
    const out = await acp.request('session/prompt', { sessionId, prompt: [IMAGE] });
    assert.equal(out.error, undefined);
    const send = acp.rpcLog().find((row) => row.method === 'session/send');
    assert.equal(send.attachments?.length, 1);
    assert.equal(send.attachments[0].dataBase64, PNG);
    assert.equal(send.attachments[0].mimeType, 'image/png');
    assert.equal(send.attachments[0].kind, 'image');
    assert.equal(assistantText(acp.updates, sessionId), 'PONG');
  });
});

it('mixed text and multiple images preserve text order and all image bytes', async () => {
  await withAdapter(async (acp, sessionId) => {
    const out = await acp.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'first' }, IMAGE, { type: 'text', text: 'last' }, IMAGE],
    });
    assert.equal(out.error, undefined);
    const send = acp.rpcLog().find((row) => row.method === 'session/send');
    assert.equal(send.attachments?.length, 2);
    assert.ok(send.attachments.every((image) => image.dataBase64 === PNG));
    assert.notEqual(send.attachments[0].filename, send.attachments[1].filename);
  });
});

it('image proof stays bound to the new turn across history and a long tool exchange', async () => {
  await withAdapter(async (acp, sessionId) => {
    await acp.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'prior turn' }] });
    for (let index = 0; index < 2; index++) {
      const out = await acp.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'LONG_TOOL_CHAIN' }, IMAGE],
      });
      assert.equal(out.error, undefined);
      assert.equal(out.result.stopReason, 'end_turn');
    }
  });
});

for (const [name, images] of [
  ['invalid base64', [{ ...IMAGE, data: 'not base64' }]],
  [
    'corrupt PNG',
    [
      {
        ...IMAGE,
        data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jMioAAAAASUVORK5CYII=',
      },
    ],
  ],
  ['MIME mismatch', [{ ...IMAGE, mimeType: 'image/jpeg' }]],
  ['too many images', Array.from({ length: 6 }, () => IMAGE)],
]) {
  it(`${name} fails before native send`, async () => {
    await withAdapter(async (acp, sessionId) => {
      const out = await acp.request('session/prompt', { sessionId, prompt: images });
      assert.ok(out.error, 'invalid images must visibly fail');
      assert.equal(
        acp.rpcLog().some((row) => row.method === 'session/send'),
        false,
      );
    });
  });
}

it('cancellation during image preprocessing never starts a native turn', async () => {
  await withAdapter(async (acp, sessionId) => {
    const prompt = acp.request('session/prompt', { sessionId, prompt: [IMAGE] });
    acp.notify('session/cancel', { sessionId });
    const out = await prompt;
    assert.equal(out.result?.stopReason, 'cancelled');
    assert.equal(
      acp.rpcLog().some((row) => row.method === 'session/send'),
      false,
    );
  });
});

it('an unverified model does not advertise or silently accept images', async () => {
  await withAdapter(async (acp, sessionId, init) => {
    assert.equal(init.result.agentCapabilities.promptCapabilities.image, false);
    const out = await acp.request('session/prompt', { sessionId, prompt: [IMAGE] });
    assert.ok(out.error);
    assert.equal(
      acp.rpcLog().some((row) => row.method === 'session/send'),
      false,
    );
  }, 'GLM-5.2');
});

it('native attachment materialization failure never surfaces an unverified answer', async () => {
  await withAdapter(async (acp, sessionId) => {
    const out = await acp.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'DROP_IMAGE' }, IMAGE],
    });
    assert.ok(out.error, 'accepted:true must not hide an omitted attachment');
    assert.match(out.error.message, /image|图片/i);
    assert.equal(assistantText(acp.updates, sessionId), '');
  });
});
