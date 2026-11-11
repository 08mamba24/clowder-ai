import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { NAMED_ALPHA_PORTS, namedAlphaFixture } from './lib/alpha-named-fixture.mjs';
import { unclaimed } from './lib/preview-unclaimed-test-fixture.mjs';

function runWrapper(scriptPath, args, cwd, env) {
  return spawnSync('bash', [scriptPath, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: env.HOME,
      TERM: 'xterm',
      CAT_CAFE_SKIP_NODE_RUNTIME_GUARD: '1',
      ...env,
    },
    timeout: 30_000,
  });
}

function makeThirdWorktree(f) {
  const thirdRoot = join(f.directory, 'cat-cafe-third');
  f.git(['worktree', 'add', '-b', 'feature-third', thirdRoot, 'origin/main']);
  return thirdRoot;
}

test('legacy start refuses when the wrapper runs from the alpha worktree itself', (t) => {
  const f = namedAlphaFixture(t);
  const result = runWrapper(join(f.alphaRoot, 'scripts/alpha-worktree.sh'), ['start'], f.alphaRoot, {
    HOME: join(f.directory, 'home'),
  });
  assert.notEqual(result.status, 0, 'must fail closed');
  assert.match(result.stderr, /primary checkout/);
  assert.match(result.stderr, /linked worktree/);
  assert.match(result.stderr, new RegExp(f.mainRoot.replaceAll('/', '\\/')));
  assert.equal(existsSync(join(f.directory, 'cat-cafe-alpha')), false, 'no side effects before refusal');
});

test('legacy start refuses from a third worktree even when it manages the real alpha', (t) => {
  const f = namedAlphaFixture(t);
  const thirdRoot = makeThirdWorktree(f);
  const result = runWrapper(join(thirdRoot, 'scripts/alpha-worktree.sh'), ['start'], thirdRoot, {
    HOME: join(f.directory, 'home'),
    CAT_CAFE_ALPHA_DIR: f.alphaRoot,
  });
  assert.notEqual(result.status, 0, 'must fail closed');
  assert.match(result.stderr, /primary checkout/);
});

test('legacy init refuses before creating anything when the target does not exist', (t) => {
  const f = namedAlphaFixture(t);
  const thirdRoot = makeThirdWorktree(f);
  const missingTarget = join(f.directory, 'alpha-not-created');
  const result = runWrapper(join(thirdRoot, 'scripts/alpha-worktree.sh'), ['init'], thirdRoot, {
    HOME: join(f.directory, 'home'),
    CAT_CAFE_ALPHA_DIR: missingTarget,
  });
  assert.notEqual(result.status, 0, 'must fail closed');
  assert.match(result.stderr, /primary checkout/);
  assert.equal(existsSync(missingTarget), false, 'refusal must precede target creation');
});

function writeGuardProbe(f) {
  const probePath = join(f.mainRoot, 'scripts', 'guard-probe.sh');
  writeFileSync(
    probePath,
    [
      '#!/bin/bash',
      'set -eu',
      'source "$(dirname "$0")/alpha-worktree.sh" --source-only',
      'assert_wrapper_primary_checkout',
      'echo GUARD_OK',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return probePath;
}

function probeEnv(f) {
  return {
    PATH: process.env.PATH,
    HOME: join(f.directory, 'home'),
    TERM: 'xterm',
    CAT_CAFE_SKIP_NODE_RUNTIME_GUARD: '1',
  };
}

test('the guard accepts the primary checkout on branch main (source-only)', (t) => {
  const f = namedAlphaFixture(t);
  const result = spawnSync('bash', [writeGuardProbe(f)], {
    cwd: f.mainRoot,
    encoding: 'utf8',
    env: probeEnv(f),
    timeout: 15_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /GUARD_OK/);
});

test('status stays available from a linked worktree and only warns', (t) => {
  const f = namedAlphaFixture(t);
  const result = runWrapper(join(f.alphaRoot, 'scripts/alpha-worktree.sh'), ['status'], f.alphaRoot, {
    HOME: join(f.directory, 'home'),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /WARN:.*primary checkout/);
});

test('the primary checkout guard rejects a detached HEAD even in the primary root', (t) => {
  const f = namedAlphaFixture(t);
  f.git(['checkout', '--detach']);
  const result = spawnSync('bash', [writeGuardProbe(f)], {
    cwd: f.mainRoot,
    encoding: 'utf8',
    env: probeEnv(f),
    timeout: 15_000,
  });
  // A detached HEAD is not the managed main checkout; the guard must refuse it.
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /primary checkout/);
});

function writeProbeAt(f, dir) {
  const probePath = join(dir, 'guard-probe.sh');
  writeFileSync(
    probePath,
    [
      '#!/bin/bash',
      'set -eu',
      'source "$(dirname "$0")/alpha-worktree.sh" --source-only',
      'assert_wrapper_primary_checkout',
      'echo GUARD_OK',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return probePath;
}

test('a main-repo subdirectory reached via a scripts symlink is refused', (t) => {
  const f = namedAlphaFixture(t);
  writeProbeAt(f, join(f.mainRoot, 'scripts'));
  mkdirMainSubdirHelper(f);
  const result = spawnSync('bash', [join(f.mainRoot, 'tools', 'scripts', 'guard-probe.sh')], {
    cwd: f.mainRoot,
    encoding: 'utf8',
    env: probeEnv(f),
    timeout: 15_000,
  });
  assert.notEqual(result.status, 0, 'must fail closed');
  assert.match(result.stderr, /primary checkout/);
});

test('an inherited GIT_DIR cannot smuggle a third worktree past the guard', (t) => {
  const f = namedAlphaFixture(t);
  const thirdRoot = makeThirdWorktree(f);
  writeProbeAt(f, join(thirdRoot, 'scripts'));
  const result = spawnSync('bash', [join(thirdRoot, 'scripts', 'guard-probe.sh')], {
    cwd: thirdRoot,
    encoding: 'utf8',
    env: { ...probeEnv(f), GIT_DIR: join(f.mainRoot, '.git') },
    timeout: 15_000,
  });
  assert.notEqual(result.status, 0, 'must fail closed');
  assert.match(result.stderr, /primary checkout/);
});

test('a whole-repo symlink alias of the main checkout stays legal', (t) => {
  const f = namedAlphaFixture(t);
  writeProbeAt(f, join(f.mainRoot, 'scripts'));
  const alias = join(f.directory, 'main-alias');
  symlinkSync(f.mainRoot, alias);
  const result = spawnSync('bash', [join(alias, 'scripts', 'guard-probe.sh')], {
    cwd: alias,
    encoding: 'utf8',
    env: probeEnv(f),
    timeout: 15_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /GUARD_OK/);
});

function mkdirMainSubdirHelper(f) {
  mkdirSync(join(f.mainRoot, 'tools'), { recursive: true });
  symlinkSync(join(f.mainRoot, 'scripts'), join(f.mainRoot, 'tools', 'scripts'));
}

function makeSecondRepo(f, name) {
  const root = join(f.directory, name);
  const ex = (args) => execFileSync('git', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  ex(['init', '-q', '-b', 'main', root]);
  ex(['-C', root, 'config', 'user.name', 'Second Repo']);
  ex(['-C', root, 'config', 'user.email', 'second@example.invalid']);
  ex(['-C', root, 'commit', '--allow-empty', '-m', 'second repo']);
  ex(['-C', root, 'remote', 'add', 'origin', join(f.directory, 'remote.git')]);
  return root;
}

const GIT_LOCATION_KEYS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG',
];

function foreignGitEnvironment(root) {
  return {
    GIT_DIR: join(root, '.git'),
    GIT_WORK_TREE: root,
    GIT_COMMON_DIR: join(root, '.git'),
    GIT_INDEX_FILE: join(root, '.git/index'),
    GIT_OBJECT_DIRECTORY: join(root, '.git/objects'),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: join(root, '.git/objects'),
    GIT_CONFIG: join(root, '.git/config'),
  };
}

function foreignGitState(f, root) {
  const fetchHead = join(root, '.git', 'FETCH_HEAD');
  return {
    registry: f.git(['worktree', 'list', '--porcelain'], root),
    refs: f.git(['show-ref'], root),
    fetchHead: existsSync(fetchHead) ? readFileSync(fetchHead, 'utf8') : null,
  };
}

for (const attributes of ['exported', 'mixed']) {
  test(`source and subsequent init preserve the caller's ${attributes} Git environment and target`, (t) => {
    const f = namedAlphaFixture(t);
    const other = makeSecondRepo(f, `source-foreign-${attributes}`);
    const before = foreignGitState(f, other);
    const target = join(f.directory, 'source-init-target');
    const probe = join(f.mainRoot, 'scripts', 'source-environment-probe.sh');
    writeFileSync(
      probe,
      `#!/bin/bash
set -euo pipefail
GIT_DIR="$FOREIGN_ROOT/.git"
GIT_WORK_TREE="$FOREIGN_ROOT"
GIT_COMMON_DIR="$FOREIGN_ROOT/.git"
GIT_INDEX_FILE="$FOREIGN_ROOT/.git/index"
GIT_OBJECT_DIRECTORY="$FOREIGN_ROOT/.git/objects"
GIT_ALTERNATE_OBJECT_DIRECTORIES="$FOREIGN_ROOT/.git/objects"
GIT_CONFIG="$FOREIGN_ROOT/.git/config"
export ${GIT_LOCATION_KEYS.join(' ')}
if [ "$ATTRIBUTES" = mixed ]; then
  export -n GIT_INDEX_FILE GIT_CONFIG
  GIT_CONFIG=''
  unset GIT_ALTERNATE_OBJECT_DIRECTORIES
fi
snapshot() {
  local key
  for key in ${GIT_LOCATION_KEYS.join(' ')}; do
    declare -p "$key" 2>/dev/null || printf 'unset:%s\\n' "$key"
  done
}

before="$(snapshot)"
git_before="$(git rev-parse --absolute-git-dir)"
source "$(dirname "$0")/alpha-worktree.sh" --source-only
[ "$(snapshot)" = "$before" ] || { echo 'source changed caller Git declarations' >&2; exit 21; }
[ "$(git rev-parse --absolute-git-dir)" = "$git_before" ] || exit 22
ALPHA_DIR="$TEST_ALPHA_TARGET"
RUN_INSTALL=false
init_alpha_worktree
[ "$(snapshot)" = "$before" ] || { echo 'init changed caller Git declarations' >&2; exit 23; }
[ "$(git rev-parse --absolute-git-dir)" = "$git_before" ] || exit 24
printf 'CALLER_TARGET=%s\\n' "$git_before"
`,
    );
    const result = spawnSync('bash', [probe], {
      cwd: f.mainRoot,
      encoding: 'utf8',
      env: { ...probeEnv(f), FOREIGN_ROOT: other, ATTRIBUTES: attributes, TEST_ALPHA_TARGET: target },
      timeout: 30_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /CALLER_TARGET=.*source-foreign/);
    assert.deepEqual(foreignGitState(f, other), before, 'the foreign registry, refs and FETCH_HEAD must be unchanged');
    assert.ok(f.git(['worktree', 'list', '--porcelain']).includes(target), 'source-loaded init must register in A');
  });
}

for (const mode of ['legacy', 'named']) {
  test(`${mode} launch scrubs inherited and dotenv Git variables from the child`, (t) => {
    const f = namedAlphaFixture(t);
    const other = makeSecondRepo(f, `launch-foreign-${mode}`);
    const before = foreignGitState(f, other);
    const foreign = foreignGitEnvironment(other);
    writeFileSync(
      join(f.mainRoot, '.env'),
      Object.entries(foreign)
        .map(([key, value]) => `export ${key}='${value.replaceAll("'", "'\"'\"'")}'`)
        .join('\n'),
    );
    const child = `#!/bin/bash\nnode -e 'console.log(JSON.stringify(${JSON.stringify(GIT_LOCATION_KEYS)}.map(key => process.env[key] ?? null)))'\n`;
    writeFileSync(join(f.mainRoot, 'scripts/start-dev.sh'), child, { mode: 0o755 });
    f.git(['add', 'scripts/start-dev.sh']);
    f.git(['commit', '-m', 'capture Git environment instead of starting services']);
    f.git(['push', 'origin', 'main']);
    let result;
    if (mode === 'named') {
      result = f.run(['start', '--instance', 'f290-communication', '--ports', NAMED_ALPHA_PORTS], {
        env: foreign,
      });
    } else {
      f.git(['merge', '--ff-only', 'main'], f.alphaRoot);
      f.preparedBuilds();
      const probe = join(f.mainRoot, 'scripts', 'source-launch-probe.sh');
      writeFileSync(
        probe,
        `#!/bin/bash
source "$(dirname "$0")/alpha-worktree.sh" --source-only
ALPHA_DIR="$TEST_ALPHA_ROOT"
SYNC_BEFORE_START=false
ensure_alpha_dependencies() { :; }
assert_alpha_redis_isolated() { :; }
assert_alpha_redis_seeded() { :; }
start_alpha_worktree
`,
      );
      result = spawnSync('bash', [probe], {
        cwd: f.mainRoot,
        encoding: 'utf8',
        env: { ...f.env, ...foreign, TEST_ALPHA_ROOT: f.alphaRoot },
        timeout: 30_000,
      });
    }
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      JSON.parse(result.stdout.trim().split('\n').at(-1)),
      GIT_LOCATION_KEYS.map(() => null),
    );
    assert.deepEqual(foreignGitState(f, other), before, 'launch must not change the foreign repository');
  });
}

test('stop retires the named registration in A without inheriting the caller Git repository B', (t) => {
  const f = unclaimed(t);
  const other = makeSecondRepo(f, 'stop-foreign');
  const before = foreignGitState(f, other);
  const foreignDump = join(other, '.cat-cafe', 'redis', 'dump.rdb');
  mkdirSync(join(other, '.cat-cafe', 'redis'), { recursive: true });
  writeFileSync(foreignDump, 'foreign fixture data');
  const originalData = [f.dumpFile, foreignDump].map((path) => readFileSync(path));
  const completion = readFileSync(f.record.completionPath);
  const payload = join(f.directory, 'stop-fixture.json');
  writeFileSync(payload, JSON.stringify({ config: f.config, record: f.record, registryDir: f.recovery.registryDir }));
  const stopModule = new URL('./lib/preview-process-stop.mjs', import.meta.url).href;
  // Stub only daemon lookup and OS observations. The preview helper exercises
  // real named registration settlement, coordinates, and Git verification.
  writeFileSync(
    join(f.mainRoot, 'scripts', 'daemon-state.mjs'),
    `import assert from 'node:assert/strict';
assert.equal(process.argv[2], 'path');
process.stdout.write(${JSON.stringify(join(f.directory, 'missing-daemon.json'))});
`,
  );
  writeFileSync(
    join(f.mainRoot, 'scripts', 'preview-process.mjs'),
    `import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stopManagedPreview } from ${JSON.stringify(stopModule)};
const { config, record, registryDir } = JSON.parse(readFileSync(process.env.STOP_FIXTURE_PAYLOAD, 'utf8'));
assert.deepEqual(process.argv.slice(2), ['stop', '--port', String(config.port), '--cwd', config.cwd, '--json']);
const recovery = {
  registryDir,
  isRunning: () => false,
  groupRunning: () => false,
  readListeners: () => [],
  readCwds: () => [],
  run: () => { throw new Error('stop fixture must never contact Redis'); },
};
const result = await stopManagedPreview(config, { record, status: 'stopped' }, { recovery });
console.log(JSON.stringify(result));
`,
  );
  f.git(['add', 'scripts/daemon-state.mjs', 'scripts/preview-process.mjs']);
  f.git(['commit', '-m', 'exercise stopped registration with no real process or Redis']);
  const result = f.run(['stop', '--dir', f.alphaRoot], {
    env: {
      ...foreignGitEnvironment(other),
      STOP_FIXTURE_PAYLOAD: payload,
      CAT_CAFE_ALPHA_FRONTEND_PORT: String(f.config.port),
      CAT_CAFE_ALPHA_API_PORT: '5312',
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).settlement.status, 'registration_retired');
  assert.equal(existsSync(f.config.recordPath), false, 'only the terminated registration must be retired');
  assert.deepEqual(readFileSync(f.record.completionPath), completion);
  assert.deepEqual(
    [f.dumpFile, foreignDump].map((path) => readFileSync(path)),
    originalData,
  );
  assert.deepEqual(foreignGitState(f, other), before);
  assert.doesNotMatch(f.readCalls(), /redis-cli/);
});

test('an inherited GIT_COMMON_DIR pointing elsewhere does not refute a legit primary', (t) => {
  const f = namedAlphaFixture(t);
  writeGuardProbe(f);
  const other = makeSecondRepo(f, 'other-commondir');
  const result = spawnSync('bash', [join(f.mainRoot, 'scripts', 'guard-probe.sh')], {
    cwd: f.mainRoot,
    encoding: 'utf8',
    env: { ...probeEnv(f), GIT_COMMON_DIR: join(other, '.git') },
    timeout: 15_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /GUARD_OK/);
});

test('a full init with an inherited GIT_DIR never registers into the foreign repository', (t) => {
  const f = namedAlphaFixture(t);
  const other = makeSecondRepo(f, 'other-gitdir');
  const before = foreignGitState(f, other);
  const target = join(f.directory, 'alpha-init-target');
  const result = spawnSync(
    'bash',
    [join(f.mainRoot, 'scripts/alpha-worktree.sh'), 'init', '--dir', target, '--no-install'],
    {
      cwd: f.mainRoot,
      encoding: 'utf8',
      env: { ...probeEnv(f), GIT_DIR: join(other, '.git') },
      timeout: 60_000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(foreignGitState(f, other), before, 'the foreign registry, refs and FETCH_HEAD must be unchanged');
  const ownList = f.git(['worktree', 'list', '--porcelain'], f.mainRoot);
  assert.match(
    ownList,
    new RegExp(target.replaceAll('/', '\\/')),
    'the worktree must register under the wrapper repository',
  );
});
