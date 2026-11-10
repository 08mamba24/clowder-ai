import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import {
  readUnixProcessSnapshot,
  readUnixProcessSnapshotSync,
  sameUnixProcess,
} from '../dist/utils/cli-process-ownership.js';

const identity = (startedAt) => ({ pid: 42, ppid: 1, pgid: 42, startedAt });

test('macOS sync/async identity and environment snapshots are stable under Chinese locale', async (t) => {
  if (process.platform !== 'darwin') return t.skip('BSD ps locale regression');
  const previous = process.env.LC_ALL;
  process.env.LC_ALL = 'zh_CN.UTF-8';
  try {
    const expected = spawnSync('/bin/ps', ['-p', String(process.pid), '-o', 'lstart='], {
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
      encoding: 'utf8',
    });
    assert.equal(expected.status, 0);
    const startedAt = expected.stdout.trim().replace(/\s+/g, ' ');
    const localized = spawnSync('/bin/ps', ['-p', String(process.pid), '-o', 'lstart='], {
      env: { ...process.env, LC_ALL: 'zh_CN.UTF-8' },
      encoding: 'utf8',
    });
    assert.equal(localized.status, 0);
    for (const reader of [readUnixProcessSnapshotSync, readUnixProcessSnapshot]) {
      for (const includeEnvironment of [false, true]) {
        const snapshot = await reader({
          pids: [process.pid],
          includeEnvironment,
          ...(includeEnvironment ? { environmentMarkers: ['CAT_CAFE_LOCALE_FIXTURE=absent'] } : {}),
        });
        assert.notEqual(snapshot, null, 'a localized ps must not make cleanup evidence unavailable');
        const current = snapshot.get(process.pid);
        assert.equal(current?.startedAt, startedAt);
        assert.equal(
          sameUnixProcess(
            {
              ...current,
              startedAt: `${localized.stdout.trim()} ${process.execPath}`,
            },
            current,
          ),
          true,
          'a living legacy worker must not be treated as replaced',
        );
      }
    }
    assert.equal(process.env.LC_ALL, 'zh_CN.UTF-8', 'sampling must not change the parent locale');
  } finally {
    if (previous === undefined) delete process.env.LC_ALL;
    else process.env.LC_ALL = previous;
  }
});

test('legacy Chinese lstart records retain identity after sampling switches to C locale', () => {
  for (const [localized, canonical] of [
    ['二 11月/10 16:05:03 2026', 'Tue Nov 10 16:05:03 2026'],
    ['二 11月/10 16:06:32 2026 /opt/homebrew/Cellar/node@24/24.18.0/bin/node', 'Tue Nov 10 16:06:32 2026'],
    ['日 1月/4 00:00:01 2026 node', 'Sun Jan 4 00:00:01 2026'],
  ]) {
    assert.equal(sameUnixProcess(identity(localized), identity(canonical)), true);
    assert.equal(sameUnixProcess(identity(canonical), identity(localized)), true);
  }
});

test('legacy locale normalization preserves PID-reuse and malformed-identity fences', () => {
  const original = identity('二 11月/10 16:05:03 2026 /node');
  for (const changed of [
    'Tue Nov 10 16:05:04 2026',
    'Tue Nov 11 16:05:03 2026',
    'Tue Oct 10 16:05:03 2026',
    'Tue Nov 10 16:05:03 2025',
    'Wed Nov 10 16:05:03 2026',
    'Tue Nov 10 16:05:03 2026 /node',
    '二 11月/10 16:05:03 2026 /node extra',
    'unreadable',
  ])
    assert.equal(sameUnixProcess(original, identity(changed)), false, changed);
  assert.equal(sameUnixProcess(original, undefined), false);
});
