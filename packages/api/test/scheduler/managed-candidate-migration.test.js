import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { applyMigrations } from '../../dist/domains/memory/schema.js';
import { DynamicTaskStore } from '../../dist/infrastructure/scheduler/DynamicTaskStore.js';
import { MANAGED_COMMAND_CANDIDATE_FILTER } from '../../dist/infrastructure/scheduler/managed-command-candidate-schema.js';

test('V51 survives restart, rolls back atomically on failure, and leaves canonical task bytes unchanged', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'managed-candidates-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'fixture.sqlite');
  let db = new Database(path);
  applyMigrations(db);
  db.exec('DROP INDEX idx_dynamic_managed_candidates; DELETE FROM schema_version WHERE version >= 51');
  new DynamicTaskStore(db).insert({
    id: 'live-retired',
    templateId: 'reminder',
    trigger: { type: 'once', fireAt: 1 },
    params: {
      triggerUserId: 'u',
      holdLifecycle: {
        mode: 'wake_when',
        status: 'retired_by_replacement',
        managedCommand: { state: 'command_running' },
      },
    },
    display: { label: 'gate', category: 'system' },
    deliveryThreadId: 't',
    enabled: false,
    createdBy: 'hold-ball:codex-astra',
    createdAt: '2026-10-03',
  });
  const before = db.prepare('SELECT * FROM dynamic_task_defs').all();
  db.exec(
    "CREATE TRIGGER fail_v51 BEFORE INSERT ON schema_version WHEN NEW.version = 51 BEGIN SELECT RAISE(ABORT, 'injected failure'); END",
  );
  assert.throws(() => applyMigrations(db), /injected failure/);
  assert.equal(
    db.prepare("SELECT name FROM sqlite_master WHERE name='idx_dynamic_managed_candidates'").get(),
    undefined,
  );
  assert.equal(db.prepare('SELECT version FROM schema_version WHERE version=51').get(), undefined);
  assert.deepEqual(db.prepare('SELECT * FROM dynamic_task_defs').all(), before);
  db.exec('DROP TRIGGER fail_v51');
  db.close();
  db = new Database(path);
  applyMigrations(db);
  assert.deepEqual(db.prepare('SELECT * FROM dynamic_task_defs').all(), before);
  assert.equal(new DynamicTaskStore(db).listManagedCommandCandidates()[0]?.id, 'live-retired');
  assert.equal(new DynamicTaskStore(db).getAll().length, 1, 'older read path still accepts the database');
  db.close();
});

test('no-spawn admission recovery updates an existing index without rewriting task bytes', () => {
  const db = new Database(':memory:');
  try {
    applyMigrations(db);
    db.exec(`DROP INDEX idx_dynamic_managed_candidates;
      DELETE FROM schema_version WHERE version > 62;
      CREATE INDEX idx_dynamic_managed_candidates ON dynamic_task_defs(created_at DESC)
        WHERE template_id = 'reminder' AND json_extract(params_json, '$.holdLifecycle.managedCommand.state') = 'command_running';`);
    const before = db.prepare('SELECT * FROM dynamic_task_defs').all();
    applyMigrations(db);
    assert.match(
      db.prepare("SELECT sql FROM sqlite_master WHERE name='idx_dynamic_managed_candidates'").get().sql,
      /not_started/,
    );
    assert.deepEqual(db.prepare('SELECT * FROM dynamic_task_defs').all(), before);
  } finally {
    db.close();
  }
});

test('V75 atomically upgrades the deployed V74 candidate index without changing task bytes', () => {
  const db = new Database(':memory:');
  try {
    applyMigrations(db);
    const store = new DynamicTaskStore(db);
    store.insert({
      id: 'hold-ball-consumed-cancel',
      templateId: 'reminder',
      trigger: { type: 'once', fireAt: 1 },
      display: { label: 'fixture', category: 'system' },
      deliveryThreadId: 'thread',
      enabled: false,
      createdBy: 'hold-ball:cat',
      createdAt: '2026-11-10',
      params: {
        holdLifecycle: {
          mode: 'wake_when',
          status: 'cancel_requested',
          managedCommand: { state: 'consumed', command: 'true', startedAt: 1 },
        },
      },
    });
    db.exec(`DELETE FROM schema_version WHERE version >= 75; DROP INDEX idx_dynamic_managed_candidates;
      CREATE INDEX idx_dynamic_managed_candidates ON dynamic_task_defs(created_at DESC)
      WHERE template_id = 'reminder' AND json_extract(params_json, '$.holdLifecycle.mode') = 'wake_when'
      AND ((enabled = 1 AND json_extract(params_json, '$.holdLifecycle.status') = 'active')
        OR json_extract(params_json, '$.holdLifecycle.managedCommand.state') IN ('command_running', 'condition_met')
        OR (json_extract(params_json, '$.holdLifecycle.managedCommand.state') = 'not_started'
          AND json_extract(params_json, '$.holdLifecycle.managedCommand.admissionFactAppended') = 0));`);
    const oldIndex = db.prepare("SELECT sql FROM sqlite_master WHERE name='idx_dynamic_managed_candidates'").get();
    const before = db.prepare('SELECT * FROM dynamic_task_defs').all();
    db.exec(
      "CREATE TRIGGER fail_v75 BEFORE INSERT ON schema_version WHEN NEW.version = 75 BEGIN SELECT RAISE(ABORT, 'fixture failure'); END",
    );
    assert.throws(() => applyMigrations(db), /fixture failure/);
    assert.deepEqual(
      db.prepare("SELECT sql FROM sqlite_master WHERE name='idx_dynamic_managed_candidates'").get(),
      oldIndex,
    );
    assert.deepEqual(db.prepare('SELECT * FROM dynamic_task_defs').all(), before);
    db.exec('DROP TRIGGER fail_v75');
    applyMigrations(db);
    applyMigrations(db);
    assert.deepEqual(db.prepare('SELECT * FROM dynamic_task_defs').all(), before);
    assert.deepEqual(
      store.listManagedCommandCandidates().map((t) => t.id),
      ['hold-ball-consumed-cancel'],
    );
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT * FROM dynamic_task_defs WHERE ${MANAGED_COMMAND_CANDIDATE_FILTER} ORDER BY created_at DESC`,
      )
      .all();
    assert.ok(
      plan.some((row) => row.detail.includes('idx_dynamic_managed_candidates')),
      JSON.stringify(plan),
    );
    assert.equal(db.prepare('SELECT version FROM schema_version WHERE version=75').get().version, 75);
  } finally {
    db.close();
  }
});
