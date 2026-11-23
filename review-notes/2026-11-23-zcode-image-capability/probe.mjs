// Reproducible probe: does a ZCode app-server 0.18.0 `session/send` image
// attachment reach the provider request as an image block?
//
// Scope: isolated HOME, fake API key, own loopback anthropic-messages endpoint.
// Nothing touches the operator's ~/.zcode, the real provider, or production.
//
// Usage:
//   node probe.mjs                      # valid 64x64 PNG fixture (expected: exit 0)
//   FIXTURE_KIND=1x1 node probe.mjs     # original 1x1 fixture with a corrupt IDAT CRC (expected: exit 1)
//   FIXTURE_KIND=1x1-valid node probe.mjs  # same 1x1 pixels, only the CRC corrected (expected: exit 0)
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const bin = '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs';
const builtin = '/Applications/ZCode.app/Contents/Resources/config/provider/zcode-builtin.json';
const node = '/opt/homebrew/opt/node@24/bin/node';
// Case workspaces (session data) go to the system temp dir, never the repo.
const runRoot = process.env.PROBE_RUN_ROOT ?? join(tmpdir(), 'dsh-zcode-image-probe-runs');

// Original 1x1 fixture, preserved verbatim as the failing negative control.
// Its IDAT CRC is wrong: stored 0xefa3322a, actual 0xefa2a75b. IHDR and IEND are valid,
// so this is a genuine 1x1 PNG except for that one CRC field.
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jMioAAAAASUVORK5CYII=';
// Same 1x1 image with only the IDAT CRC field corrected; dimensions and compressed pixel
// data are byte-identical to PNG_1X1. This separates "1x1 size" from "bad CRC".
const PNG_1X1_VALID_CRC =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';
// 64x64 solid-red RGBA PNG: a normal image that survives resize.
const PNG_64X64 =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAlElEQVR4nO3QMREAMBDDsPAn/YWhoR60+7zb7mfTAVoDdIDWAB2gNUAHaA3QAVoDdIDWAB2gNUAHaA3QAVoDdIDWAB2gNUAHaA3QAVoDdIDWAB2gNUAHaA3QAVoDdIDWAB2gNUAHaA3QAVoDdIDWAB2gNUAHaA3QAVoDdIDWAB2gNUAHaA3QAVoDdIDWAB2gNUAHaA9DiOHSbdjxEgAAAABJRU5ErkJggg==';
const FIXTURES = { real: PNG_64X64, '1x1': PNG_1X1, '1x1-valid': PNG_1X1_VALID_CRC };
const fixtureKind = process.env.FIXTURE_KIND ?? 'real';
if (!(fixtureKind in FIXTURES)) {
  throw new Error(`unknown FIXTURE_KIND=${fixtureKind}; expected one of ${Object.keys(FIXTURES).join(', ')}`);
}
const png = FIXTURES[fixtureKind];
const pngBytes = Buffer.from(png, 'base64');

const result = {
  bundleSha256: createHash('sha256').update(readFileSync(bin)).digest('hex'),
  nodeVersion: process.version,
  fixtureKind,
  fixtureBytes: pngBytes.length,
  scope: 'isolated fake credentials and own loopback model endpoint',
  checks: [],
  cases: [],
};
const check = (name, condition) => result.checks.push({ name, pass: Boolean(condition) });
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const server = createServer(async (req, res) => {
  let raw = '';
  for await (const part of req) raw += part;
  const body = JSON.parse(raw || '{}');
  const images = (body.messages ?? [])
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((b) => b.type === 'image');
  captures.push({
    model: body.model,
    path: req.url,
    imageCount: images.length,
    imageMediaTypes: images.map((i) => i.source?.media_type),
    exactFixtureBytes: images.some((i) => i.source?.data === png),
    userTail: (body.messages ?? [])
      .filter((m) => m.role === 'user')
      .map((m) =>
        Array.isArray(m.content)
          ? m.content
              .map((c) => (c.type === 'text' ? c.text : `[${c.type}]`))
              .filter((t) => t.includes('Attached') || t.includes('Media omitted') || t === '[image]')
          : [],
      ),
  });
  if (body.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    emit('message_start', {
      message: {
        id: 'msg_dsh',
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    });
    emit('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    emit('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'OK' } });
    emit('content_block_stop', { index: 0 });
    emit('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } });
    emit('message_stop', {});
    res.end();
  } else {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'msg_dsh',
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [{ type: 'text', text: 'OK' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
  }
});
let captures = [];
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

function envFor(home, personal) {
  return {
    PATH: '/opt/homebrew/opt/node@24/bin:/usr/bin:/bin',
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local/share'),
    XDG_STATE_HOME: join(home, '.local/state'),
    XDG_CACHE_HOME: join(home, '.cache'),
    ZCODE_DATA_BASE_DIR: home,
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtin,
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personal,
    NO_COLOR: '1',
    TERM: 'dumb',
  };
}

async function runCase(name, supportsImage, attachmentFactory) {
  const dir = join(runRoot, `${fixtureKind}-${name}`);
  const home = join(dir, 'home');
  const ws = join(dir, 'workspace');
  mkdirSync(home, { recursive: true });
  mkdirSync(ws, { recursive: true });
  const imgPath = join(ws, 'probe.png');
  writeFileSync(imgPath, pngBytes);
  const personal = join(dir, 'provider.json');
  writeFileSync(
    personal,
    JSON.stringify({
      schemaVersion: 1,
      config: {
        providerConfigRules: {
          providerRules: [
            {
              providerId: 'anthropic',
              providerName: 'DSH fake provider',
              config: {
                group: 'standard-personal',
                access: { type: 'api-key', apiKey: 'dummy-dsh-not-a-secret' },
                api: { type: 'anthropic-messages', baseUrl: `http://127.0.0.1:${port}/v1` },
                personalModelIds: ['glm-5.4'],
                modelOrder: ['glm-5.4'],
              },
            },
          ],
        },
        modelConfigRules: {
          providerModelRules: [
            {
              providerId: 'anthropic',
              modelId: 'glm-5.4',
              config: { properties: { inputFormat: { supportsImage } } },
            },
          ],
          manualProviderModelRules: [],
        },
        defaultModelSelection: {
          providerId: 'anthropic',
          modelId: 'glm-5.4',
          options: { reasoningLevel: 'enabled' },
        },
      },
    }),
    { mode: 0o600 },
  );
  const env = envFor(home, personal);
  if (!result.cliVersion) {
    result.cliVersion = spawnSync(node, [bin, '--version'], { env, cwd: ws, encoding: 'utf8', timeout: 8000 })
      .stdout.trim();
  }
  const child = spawn(node, [bin, 'app-server', '--surface', 'terminal', '--mode', 'yolo'], {
    cwd: ws,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  const events = [];
  let id = 1;
  let stderr = '';
  let childExit;
  child.stderr.on('data', (b) => (stderr += b.toString()));
  child.on('exit', (code, signal) => (childExit = { code, signal }));
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m.id != null && m.method) {
      child.stdin.write(
        `${JSON.stringify({
          id: m.id,
          result:
            m.method === 'session/requestRuntimePreferences'
              ? {
                  nativeSearchEnhancementsEnabled: false,
                  memoryEnabled: false,
                  askUserQuestionAutoResolutionEnabled: false,
                }
              : { decision: 'deny' },
        })}\n`,
      );
      return;
    }
    if (m.method) events.push(m);
    const p = pending.get(m.id);
    if (p) {
      clearTimeout(p.timer);
      pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    }
  });
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const key = id++;
      const timer = setTimeout(() => {
        pending.delete(key);
        reject(
          new Error(`timeout ${method}; exit=${JSON.stringify(childExit)}; stderrTail=${stderr.slice(-600)}`),
        );
      }, 20000);
      pending.set(key, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id: key, method, params })}\n`);
    });
  try {
    await rpc('session/list', {});
    const workspace = { workspacePath: ws, workspaceKey: ws };
    const created = await rpc('session/create', {
      workspace,
      mode: 'yolo',
      thoughtLevel: 'enabled',
      persistence: 'immediate',
      titleGenerationEnabled: false,
      mcpServers: [],
      model: { providerId: 'anthropic', modelId: 'glm-5.4', options: { reasoningLevel: 'enabled' } },
    });
    const sessionId = created.sessionId ?? created.session?.sessionId;
    check(`session created ${name}`, typeof sessionId === 'string');
    await rpc('session/subscribe', {
      sessionId,
      deliveryKind: 'desktop-continuous',
      includeSnapshot: true,
      afterSeq: 0,
    });
    captures = [];
    const attachment = attachmentFactory({ imgPath, png });
    const admitted = await rpc('session/send', {
      sessionId,
      content: 'Reply OK only. Do not use tools.',
      attachments: [attachment],
    });
    for (
      let i = 0;
      i < 160 && !events.some((e) => e.params?.type === 'turn.completed' || e.params?.type === 'turn.failed');
      i++
    )
      await delay(100);
    let messages;
    try {
      messages = await rpc('session/messages', { sessionId, limit: 30 });
    } catch (e) {
      messages = { error: String(e) };
    }
    const userParts = (messages.messages ?? [])
      .filter((m) => m.info?.role === 'user')
      .flatMap((m) =>
        (m.parts ?? []).map((p) => ({ type: p.type, mime: p.mime, metadata: p.metadata, filename: p.filename })),
      );
    result.cases.push({
      name,
      supportsImage,
      attachment: {
        kind: attachment.kind,
        hasLocalPath: Boolean(attachment.localPath),
        hasDataBase64: Boolean(attachment.dataBase64),
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
      },
      admitted,
      captures: [...captures],
      userParts,
      terminalEvents: events
        .filter((e) => e.params?.type === 'turn.failed' || e.params?.type === 'turn.completed')
        .map((e) => ({ type: e.params.type, response: e.params.payload?.response })),
    });
    check(`model request observed ${name}`, captures.length > 0);
    check(
      `image capability gate ${name}`,
      supportsImage
        ? captures.some((c) => c.imageCount === 1 && c.exactFixtureBytes)
        : captures.every((c) => c.imageCount === 0),
    );
  } finally {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('probe teardown'));
    }
    pending.clear();
    child.stdin.end();
    if (child.exitCode === null) child.kill('SIGTERM');
    if (!childExit) await Promise.race([new Promise((r) => child.once('exit', r)), delay(3000)]);
    if (child.exitCode === null && !childExit) child.kill('SIGKILL');
    writeFileSync(join(dir, 'stderr.log'), stderr, { mode: 0o600 });
    lines.close();
    child.stdout.destroy();
    child.stderr.destroy();
    child.stdin.destroy();
  }
}

try {
  await runCase('base64-on', true, ({ png }) => ({
    kind: 'image',
    filename: 'probe.png',
    mimeType: 'image/png',
    sizeBytes: pngBytes.length,
    dataBase64: png,
  }));
  await runCase('base64-off', false, ({ png }) => ({
    kind: 'image',
    filename: 'probe.png',
    mimeType: 'image/png',
    sizeBytes: pngBytes.length,
    dataBase64: png,
  }));
  await runCase('localpath-on', true, ({ imgPath }) => ({
    kind: 'image',
    filename: 'probe.png',
    mimeType: 'image/png',
    sizeBytes: pngBytes.length,
    localPath: imgPath,
  }));
  await runCase('localpath-off', false, ({ imgPath }) => ({
    kind: 'image',
    filename: 'probe.png',
    mimeType: 'image/png',
    sizeBytes: pngBytes.length,
    localPath: imgPath,
  }));
} catch (e) {
  result.error = String(e);
} finally {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  result.pass = result.checks.length > 0 && result.checks.every((c) => c.pass) && !result.error;
  writeFileSync(join(root, `result-${fixtureKind}.json`), JSON.stringify(result, null, 2));
  process.exitCode = result.pass ? 0 : 1;
  const brief = {
    fixtureKind,
    pass: result.pass,
    cliVersion: result.cliVersion,
    bundleSha256: result.bundleSha256,
    checks: result.checks,
    cases: result.cases.map((c) => ({
      name: c.name,
      captured: c.captures.map((x) => ({
        imageCount: x.imageCount,
        imageMediaTypes: x.imageMediaTypes,
        exactFixtureBytes: x.exactFixtureBytes,
        userTail: x.userTail,
      })),
      storedUserParts: c.userParts,
    })),
  };
  console.log(JSON.stringify(brief, null, 2));
}
