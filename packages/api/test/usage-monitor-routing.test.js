import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { freezeExecutionAccountBinding } from '../dist/domains/cats/services/agents/invocation/execution-account-binding.js';
import { freshTargetDecision } from '../dist/domains/routing-context/preflight/RoutingPreflightDecisionProjector.js';
import { buildRoutingSignalDecisionProjection } from '../dist/domains/routing-context/preflight/RoutingSignalDecisionProjection.js';
import { RoutingContextReadService } from '../dist/domains/routing-context/RoutingContextReadService.js';
import { RoutingContextResolver } from '../dist/domains/routing-context/RoutingContextResolver.js';
import { RuntimeRoutingDispatchPreflight } from '../dist/domains/routing-context/RoutingDispatchPreflightPort.js';
import { RoutingPreflightService } from '../dist/domains/routing-context/RoutingPreflightService.js';
import { reduceRoutingContext } from '../dist/domains/routing-context/routing-context-reducer.js';
import { RoutingSelectionService } from '../dist/domains/routing-context/selection/RoutingSelectionService.js';
import { readMonitorJson } from '../dist/domains/routing-context/UsageMonitorRoutingSource.js';
import { registerCallbackAuthHook } from '../dist/routes/callback-auth-prehandler.js';
import { registerCallbackThreadCatsRoutes } from '../dist/routes/callback-thread-cats-routes.js';
import { usageMonitorRoutingCommand } from '../dist/scripts/usage-monitor-routing.js';
import { accountCapacityFixture } from './helpers/account-routing-capacity-fixture.js';

async function fixture(t) {
  const f = accountCapacityFixture(t);
  const original = await f.source.load({ ownerId: 'owner', observedAt: f.now });
  const revision = original.candidates.find((c) => c.catId === 'first').capacityFacts.current.bindingRevision;
  const freeze = () =>
    freezeExecutionAccountBinding({
      catId: 'first',
      catConfig: f.configs.first,
      workspace: { usesDefaultWorkspace: true, workingProjectRoot: f.root },
    });
  const proof = () => {
    const frozen = freeze();
    return {
      catId: 'first',
      accountRevision: frozen.executionAccount?.accountRevision,
      providerId: frozen.catConfig?.provider || frozen.catConfig?.clientId,
      modelId: frozen.modelId,
      principalVerified: frozen.principalVerified,
    };
  };
  const cachePath = join(f.root, 'usage.json');
  const payload = { schemaVersion: 2 };
  const row = {
    id: 'codex',
    ok: true,
    kind: 'percent',
    pct: 100,
    accountKey: 'a'.repeat(64),
    observedAt: f.now,
    wins: [
      { label: '5h', pct: 100, usedPercent: 100, resetAt: f.now + 60000 },
      { label: '7d', pct: 20, usedPercent: 20, resetAt: f.now + 86400000 },
    ],
  };
  const config = {
    version: 1,
    cachePath,
    bindings: ['first', 'second'].map((catId) => ({
      catId,
      providerId: 'codex',
      clientId: 'openai',
      modelId: 'gpt-6.1-sol',
      accountRef: 'main-private-ref',
      accountRevision: revision,
      accountKey: row.accountKey,
      windows: ['5h', '7d'],
    })),
  };
  const save = () => {
    f.save();
    writeFileSync(cachePath, JSON.stringify({ ...payload, observedAt: f.now, providers: [row] }));
    utimesSync(cachePath, f.now / 1000, f.now / 1000);
    writeFileSync(join(f.root, '.cat-cafe', 'usage-monitor-routing.json'), JSON.stringify(config));
  };
  const load = async (execution = false, at = f.now) => {
    save();
    const catalog = await f.source.load({
      ownerId: 'owner',
      observedAt: at,
      ...(execution
        ? {
            executionBindings: [proof()],
          }
        : {}),
    });
    const snapshot = reduceRoutingContext({
      ownerId: 'owner',
      observedAt: at,
      catalogRevision: catalog.catalogRevision,
      candidates: catalog.candidates,
      profiles: [],
      signalEvents: [],
      preferenceRevisions: [],
    });
    return { catalog, snapshot, first: snapshot.candidates.find((c) => c.binding.catId === 'first') };
  };
  return { ...f, cachePath, row, payload, config, save, load, revision, freeze, proof };
}

test('selection reads used percentages as remaining and warns before launching a model', async (t) => {
  const f = await fixture(t);
  const { first, snapshot } = await f.load();
  assert.equal(first.binding.capacityFacts.current.source, 'usage_monitor');
  assert.deepEqual(
    first.binding.capacityFacts.current.windows.map((w) => w.remainingPercent),
    [0, 80],
  );
  assert.equal(first.availability, 'scarce');
  assert.equal(
    snapshot.candidates.find((c) => c.binding.catId === 'unbound').binding.capacityFacts.current.source,
    undefined,
  );
});

test('only the exact frozen execution is rejected; shared-account siblings retain the same pool', async (t) => {
  const f = await fixture(t);
  const { first, snapshot } = await f.load(true);
  assert.equal(f.freeze().principalVerified, true);
  assert.equal(first.availability, 'unavailable');
  const second = snapshot.candidates.find((c) => c.binding.catId === 'second');
  assert.equal(
    first.binding.capacityFacts.current.windows[0].poolId,
    second.binding.capacityFacts.current.windows[0].poolId,
  );
  assert.equal(second.availability, 'scarce');
  const verdict = freshTargetDecision({}, { status: 'fresh', snapshot }, 'first');
  assert.equal(verdict.disposition, 'rejected');
});

for (const clientId of ['openai', 'anthropic', 'google']) {
  test(`${clientId} CLI-owned login cannot gain hard-block authority from a config revision`, async (t) => {
    const f = await fixture(t);
    const account = f.accounts['main-private-ref'];
    const home = account.codex.credentialHome;
    delete account.codex;
    account.clientId = clientId;
    account.envVars = { CODEX_HOME: home, CLAUDE_CONFIG_DIR: home, GEMINI_CLI_HOME: home };
    f.configs.first.clientId = clientId;
    f.configs.first.defaultModel = { openai: 'gpt-6.1-sol', anthropic: 'claude-opus-4-8', google: 'gemini-3-pro' }[
      clientId
    ];
    const binding = f.config.bindings[0];
    binding.clientId = clientId;
    binding.modelId = f.configs.first.defaultModel;
    f.save();
    const before = f.freeze();
    binding.accountRevision = before.executionAccount.accountRevision;
    const oldLogin = readFileSync(join(home, 'auth.json'), 'utf8');
    const nextLogin = oldLogin.replaceAll('private-principal-main', 'replacement-principal');
    writeFileSync(join(home, 'auth.json'), nextLogin);
    assert.notEqual(oldLogin, nextLogin);
    const after = f.freeze();
    assert.equal(after.executionAccount.accountRevision, before.executionAccount.accountRevision);
    assert.equal(after.principalVerified, false);
    const { first, snapshot } = await f.load(true);
    assert.ok(first.binding.capacityFacts.current.windows.every((window) => window.applicability === 'unknown'));
    assert.notEqual(freshTargetDecision({}, { status: 'fresh', snapshot }, 'first').disposition, 'rejected');
  });
}

test('managed login mismatch fails admission and missing frozen proof keeps quota advisory', async (t) => {
  const f = await fixture(t);
  assert.equal(f.freeze().principalVerified, true);
  const home = f.accounts['main-private-ref'].codex.credentialHome;
  writeFileSync(
    join(home, 'auth.json'),
    readFileSync(join(home, 'auth.json'), 'utf8').replaceAll('private-principal-main', 'replacement-principal'),
  );
  assert.throws(() => f.freeze(), /身份已改变/);
  f.save();
  const catalog = await f.source.load({
    ownerId: 'owner',
    observedAt: f.now,
    executionBindings: [{ catId: 'first', accountRevision: f.revision, providerId: 'openai', modelId: 'gpt-6.1-sol' }],
  });
  assert.equal(
    catalog.candidates.find((candidate) => candidate.catId === 'first').capacityFacts.current.windows[0].applicability,
    'unknown',
  );
});

for (const scenario of [
  'stale',
  'future',
  'fetch_failed',
  'reset_elapsed',
  'credential_changed',
  'model_changed',
  'account_changed',
]) {
  test(`${scenario} becomes unknown without inventing recovery or preventing an attempt`, async (t) => {
    const f = await fixture(t);
    if (scenario === 'stale') f.row.observedAt -= 121000;
    if (scenario === 'future') f.row.observedAt += 1000;
    if (scenario === 'fetch_failed') f.row.ok = false;
    if (scenario === 'reset_elapsed') f.row.wins[0].resetAt = f.now;
    if (scenario === 'credential_changed') f.row.accountKey = 'b'.repeat(64);
    if (scenario === 'model_changed') f.configs.first.defaultModel = 'another-model';
    if (scenario === 'account_changed') f.configs.first.accountRef = 'spare-private-ref';
    const { first } = await f.load(true);
    assert.equal(first.availability, 'unknown');
    assert.notEqual(first.effect, 'blocked');
  });
}

test('legacy cache is advisory even when a binding and execution revision were configured', async (t) => {
  const f = await fixture(t);
  delete f.payload.schemaVersion;
  delete f.row.accountKey;
  delete f.row.observedAt;
  const { first } = await f.load(true);
  assert.equal(first.availability, 'scarce');
  assert.ok(first.binding.capacityFacts.current.windows.every((w) => w.applicability === 'unknown'));
});

test('rounded 100% and enabled paid overage cannot falsely hard-block a model', async (t) => {
  const f = await fixture(t);
  f.row.wins[0].usedPercent = 99.6;
  assert.equal((await f.load(true)).first.availability, 'scarce');
  f.row.wins[0].usedPercent = 100;
  f.row.quotaEnforced = false;
  assert.equal((await f.load(true)).first.availability, 'scarce');
});

test('a partial cache, missing window or non-regular source is unknown and never hangs dispatch', async (t) => {
  const f = await fixture(t);
  f.row.wins.pop();
  assert.equal((await f.load(true)).first.availability, 'unknown');
  f.save();
  writeFileSync(f.cachePath, '{"providers":');
  const catalog = await f.source.load({ ownerId: 'owner', observedAt: f.now });
  assert.equal(catalog.candidates.find((c) => c.catId === 'first').capacityFacts.current.reason, 'source_unavailable');
  assert.throws(() => readMonitorJson(f.root));
});

test('operator CLI previews and atomically saves a binding while preserving existing cats', async (t) => {
  const f = await fixture(t);
  f.save();
  const savedTemplate = process.env.CAT_TEMPLATE_PATH;
  const savedRoot = process.env.CAT_CAFE_CONFIG_ROOT;
  const template = JSON.parse(readFileSync(savedTemplate, 'utf8'));
  const breed = template.breeds.find((item) => item.catId === 'codex');
  const variant = breed.variants.find((item) => item.id === breed.defaultVariantId);
  variant.accountRef = 'main-private-ref';
  variant.defaultModel = 'gpt-6.1-sol';
  const templatePath = join(f.root, 'cat-template.json');
  writeFileSync(templatePath, JSON.stringify(template));
  process.env.CAT_TEMPLATE_PATH = templatePath;
  process.env.CAT_CAFE_CONFIG_ROOT = f.root;
  t.after(() => {
    process.env.CAT_TEMPLATE_PATH = savedTemplate;
    if (savedRoot === undefined) delete process.env.CAT_CAFE_CONFIG_ROOT;
    else process.env.CAT_CAFE_CONFIG_ROOT = savedRoot;
  });
  const args = ['--cache', f.cachePath, '--cat', 'codex', '--provider', 'codex', '--windows', '5h,7d'];
  const path = join(f.root, '.cat-cafe', 'usage-monitor-routing.json');
  const original = readFileSync(path, 'utf8');
  const preview = usageMonitorRoutingCommand(args);
  assert.equal(readFileSync(path, 'utf8'), original);
  assert.equal(preview.bindings.length, 3);
  assert.equal(preview.bindings.find((item) => item.catId === 'codex').accountRevision, f.revision);
  assert.equal(usageMonitorRoutingCommand([...args, '--write']).mode, 'execution_checked');
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).bindings.length, 3);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const account = f.accounts['main-private-ref'];
  account.envVars = { CODEX_HOME: account.codex.credentialHome };
  delete account.codex;
  f.save();
  assert.equal(usageMonitorRoutingCommand([...args, '--write']).mode, 'advisory');
});

test('model bucket selection never applies another Gemini model zero to this model', async (t) => {
  const f = await fixture(t);
  f.row.quotaWindows = [
    { label: 'pro', pct: 20, usedPercent: 20 },
    { label: 'flash', pct: 100, usedPercent: 100 },
  ];
  for (const binding of f.config.bindings) binding.windows = ['pro'];
  const { first } = await f.load(true);
  assert.deepEqual(
    first.binding.capacityFacts.current.windows.map((w) => w.remainingPercent),
    [80],
  );
  assert.equal(first.availability, 'available');
});

test('real MCP callback discovery → fresh execution check → changed cache → expired unknown', async (t) => {
  const f = await fixture(t);
  f.save();
  let now = f.now;
  const originals = catRegistry.getAllConfigs();
  catRegistry.reset();
  for (const [id, config] of Object.entries(f.configs)) catRegistry.register(id, config);
  t.after(() => {
    catRegistry.reset();
    for (const [id, config] of Object.entries(originals)) catRegistry.register(id, config);
  });
  const resolver = new RoutingContextResolver({
    signalStore: {
      getOwnerRevision: async () => 0,
      readDecisionProjection: async () =>
        buildRoutingSignalDecisionProjection({ ownerId: 'owner', revision: 0, events: [] }),
    },
    preferenceStore: { listByOwner: async () => [] },
    profileRevisionSource: { load: async () => ({ status: 'fresh', profiles: [] }) },
  });
  const readService = new RoutingContextReadService({ catalogSource: f.source, resolver });
  const app = Fastify();
  t.after(() => app.close());
  registerCallbackAuthHook(app, {
    verify: async (id, token) =>
      id === 'source' && token === 'test-token'
        ? { ok: true, record: { invocationId: id, catId: 'first', userId: 'owner', threadId: 'journey' } }
        : { ok: false, reason: 'invalid' },
  });
  registerCallbackThreadCatsRoutes(app, {
    threadStore: {
      get: async () => ({ id: 'journey', createdBy: 'owner' }),
      getParticipantsWithActivity: async () => [],
    },
    agentRegistry: { getAllEntries: () => new Map(Object.keys(f.configs).map((id) => [id, {}])) },
    routingSelection: new RoutingSelectionService({ readService, now: () => now }),
  });
  const response = await app.inject({
    method: 'GET',
    url: '/api/callbacks/thread-cats?forRole=review',
    headers: { 'x-invocation-id': 'source', 'x-callback-token': 'test-token' },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.match(response.json().selection.facts, /second.*0%/);
  assert.match(response.json().selection.facts, /usage_monitor_quota_low/);
  const port = new RuntimeRoutingDispatchPreflight({
    catalogSource: f.source,
    preflightService: new RoutingPreflightService({ resolver }),
    now: () => now,
  });
  const input = {
    ownerId: 'owner',
    targetCatIds: ['first'],
    executionBindings: [f.proof()],
  };
  assert.equal((await port.preflight(input)).targets[0].disposition, 'rejected');
  f.row.wins[0].usedPercent = 40;
  f.row.wins[0].pct = 40;
  f.save();
  assert.equal((await port.preflight(input)).targets[0].disposition, 'allowed');
  now += 121000;
  assert.equal((await port.preflight(input)).targets[0].disposition, 'warned');
});

test('source errors preserve manual/provider blocking signals and never export private configuration', async (t) => {
  const f = await fixture(t);
  f.row.ok = false;
  const { catalog } = await f.load(true);
  const snapshot = reduceRoutingContext({
    ownerId: 'owner',
    observedAt: f.now,
    catalogRevision: catalog.catalogRevision,
    candidates: catalog.candidates,
    profiles: [],
    preferenceRevisions: [],
    signalEvents: [
      {
        v: 1,
        eventId: 'manual',
        commandId: 'manual',
        ownerId: 'owner',
        subjectRef: { type: 'cat', catId: 'first' },
        eventType: 'asserted',
        state: 'unavailable',
        source: 'manual_cvo',
        reasonCode: 'maintenance',
        observedAt: f.now,
        validUntil: f.now + 10000,
        evidenceRef: 'human:maintenance',
      },
    ],
  });
  assert.equal(snapshot.candidates.find((c) => c.binding.catId === 'first').availability, 'unavailable');
  const serialized = JSON.stringify(catalog);
  for (const secret of [f.root, 'main-private-ref', 'a'.repeat(64)]) assert.ok(!serialized.includes(secret), secret);
});
