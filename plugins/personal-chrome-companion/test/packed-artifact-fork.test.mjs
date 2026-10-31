import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Fork-only equivalent of packed-artifact.test.mjs.
//
// The upstream test drives the clowder-ai-plugins repository-root publish
// scripts (../../../scripts/materialize-locked-dependencies.mjs and
// own-publish-members.mjs), which do not exist in the vendored in-tree copy, so
// it is skipped there. This test restores the packed-artifact guarantee without
// those scripts by driving the package's own publish pipeline in an isolated
// copy:
//
//   source copy -> npm pack (runs prepack: pnpm build) -> real .tgz
//   -> clean consumer: tar -xzf -> npm install --omit=dev (npm-shrinkwrap)
//   -> import dist/index.js and run native-host/native-host-cli.mjs from the
//      unpacked artifact itself.
//
// It deliberately does not read the worktree dist/, sibling repository scripts,
// or a parent-directory node_modules. The consumer directory has no
// node_modules before the install, and the resolved runtime dependency is
// asserted to live inside the unpacked artifact.
//
// Build toolchain: the package's own node_modules when the source repository is
// installed, otherwise PCC_TOOLCHAIN_DIR (a directory containing a node_modules
// with typescript + esbuild), otherwise the vendored integration build cache.
// pnpm must be on PATH because `npm pack` runs the package `prepack` script.
// The prod install resolves exact versions from the shipped npm-shrinkwrap.json
// and therefore needs registry access.

const packageDirectory = fileURLToPath(new URL('../', import.meta.url));

// Members the packed artifact must ship. Mirrors the upstream assertion list;
// plugin.yaml and npm-shrinkwrap.json are additionally required because the
// artifact is a published plugin package and because the consumer install below
// must resolve the locked production closure.
const requiredArtifactMembers = [
  'package/dist/index.js',
  'package/extension/manifest.json',
  'package/native-host/native-host-cli.mjs',
  'package/native-host/install-host.mjs',
  'package/native-host/setup-host.mjs',
  'package/native-host/setup-protocol.md',
  'package/README.md',
  'package/plugin.yaml',
  'package/npm-shrinkwrap.json',
];

// The package `files` allowlist must not leak development payloads into the
// published closure.
const forbiddenArtifactPrefixes = ['package/src/', 'package/test/', 'package/node_modules/', 'package/tsconfig'];

const hostConfigurationError = 'required personal Chrome host configuration is missing';
const sourceExclusions = new Set(['node_modules', 'dist', 'test', '.DS_Store']);
const toolchainDirectories = [
  process.env.PCC_TOOLCHAIN_DIR,
  packageDirectory,
  // Vendored integration worktree only: the fixed toolchain used by the
  // integration evidence pipeline. PCC_TOOLCHAIN_DIR takes precedence.
  '/tmp/pcc-build-1',
].filter(Boolean);

function run(command, args, cwd, options = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', ...options });
  const rendered = [command, ...args].join(' ');
  assert.equal(result.error, undefined, `${rendered} failed to start: ${result.error?.message ?? 'unknown error'}`);
  return { ...result, rendered };
}

function runExpectingSuccess(command, args, cwd, options = {}) {
  const result = run(command, args, cwd, options);
  assert.equal(
    result.status,
    0,
    `${result.rendered} exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result;
}

function resolveBuildNodeModules() {
  for (const directory of toolchainDirectories) {
    const nodeModules = join(directory, 'node_modules');
    if (
      existsSync(join(nodeModules, 'typescript', 'bin', 'tsc')) &&
      existsSync(join(nodeModules, 'esbuild', 'package.json'))
    ) {
      return nodeModules;
    }
  }
  assert.fail(
    'packed-artifact-fork: no build toolchain found; install the package devDependencies or set ' +
      'PCC_TOOLCHAIN_DIR to a directory containing a node_modules with typescript and esbuild',
  );
}

async function copyPackageSource(source, destination) {
  await cp(source, destination, {
    recursive: true,
    filter: (entry) => {
      const name = basename(entry);
      return !sourceExclusions.has(name) && !name.endsWith('.tgz');
    },
  });
}

async function toolchainDescription(nodeModules) {
  const typescript = JSON.parse(await readFile(join(nodeModules, 'typescript', 'package.json'), 'utf8'));
  const esbuild = JSON.parse(await readFile(join(nodeModules, 'esbuild', 'package.json'), 'utf8'));
  return { typescript: typescript.version, esbuild: esbuild.version, node: process.version };
}

test('packs the vendored companion closure and validates the published artifact from a clean consumer', async () => {
  const buildNodeModules = resolveBuildNodeModules();
  const temporary = await mkdtemp(join(tmpdir(), 'f247-companion-pack-fork-'));
  try {
    // Build a source copy without the worktree dist/ so the packed artifact
    // can only be produced by the package's own publish pipeline.
    const sourceCopy = join(temporary, 'package-source');
    await copyPackageSource(packageDirectory, sourceCopy);
    await symlink(
      buildNodeModules,
      join(sourceCopy, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    // npm pack -> prepack -> pnpm build (build:extension verify + clean + tsc).
    runExpectingSuccess('npm', ['pack'], sourceCopy, {
      env: { ...process.env, npm_config_ignore_scripts: 'false' },
    });

    const sourcePackageJson = JSON.parse(await readFile(join(sourceCopy, 'package.json'), 'utf8'));
    const archiveName = `${sourcePackageJson.name.replace(/^@/, '').replace('/', '-')}-${sourcePackageJson.version}.tgz`;
    const archive = join(sourceCopy, archiveName);
    assert.equal(existsSync(archive), true, `npm pack did not produce ${archiveName}`);

    // Member listing of the real .tgz.
    const listing = runExpectingSuccess('tar', ['-tzf', archive], temporary).stdout.split('\n').filter(Boolean);
    for (const member of requiredArtifactMembers) {
      assert.equal(listing.includes(member), true, `${member} is missing from packed artifact`);
    }
    for (const prefix of forbiddenArtifactPrefixes) {
      assert.equal(
        listing.some((entry) => entry.startsWith(prefix)),
        false,
        `packed artifact leaked development payload under ${prefix}`,
      );
    }

    // Published package metadata (source contract, as asserted upstream).
    assert.equal(sourcePackageJson.private, undefined);
    assert.equal(sourcePackageJson.bin['clowder-personal-chrome-host'], 'native-host/native-host-cli.mjs');

    // Clean consumer: no parent/sibling node_modules can satisfy the imports.
    const consumer = join(temporary, 'consumer');
    await mkdir(consumer);
    assert.equal(existsSync(join(consumer, 'node_modules')), false);
    assert.equal(existsSync(join(temporary, 'node_modules')), false);
    runExpectingSuccess('tar', ['-xzf', archive, '-C', consumer], temporary);

    const unpacked = join(consumer, 'package');
    const unpackedPackageJson = JSON.parse(await readFile(join(unpacked, 'package.json'), 'utf8'));
    assert.equal(unpackedPackageJson.private, undefined);
    assert.equal(unpackedPackageJson.bin['clowder-personal-chrome-host'], 'native-host/native-host-cli.mjs');
    assert.equal(unpackedPackageJson.version, sourcePackageJson.version);

    // Materialize the locked production closure from the shipped shrinkwrap.
    runExpectingSuccess('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], unpacked);
    for (const dependency of ['@clowder-ai/plugin-contract', '@clowder-ai/plugin-sdk']) {
      assert.equal(
        existsSync(join(unpacked, 'node_modules', dependency, 'package.json')),
        true,
        `${dependency} was not installed from npm-shrinkwrap.json`,
      );
    }
    assert.equal(
      existsSync(join(unpacked, 'node_modules', 'typescript')),
      false,
      'npm install --omit=dev materialized a devDependency into the consumer closure',
    );

    // The runtime dependency must resolve inside the artifact, not a parent.
    const resolvedUrl = runExpectingSuccess(
      process.execPath,
      ['--input-type=module', '--eval', "console.log(import.meta.resolve('@clowder-ai/plugin-sdk'));"],
      unpacked,
    ).stdout.trim();
    const installedSdk = realpathSync(join(unpacked, 'node_modules', '@clowder-ai', 'plugin-sdk'));
    assert.equal(
      realpathSync(fileURLToPath(resolvedUrl)).startsWith(installedSdk),
      true,
      `@clowder-ai/plugin-sdk resolved outside the unpacked artifact: ${resolvedUrl}`,
    );

    // Import the module entrypoint from the unpacked artifact.
    const importResult = runExpectingSuccess(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        "const module = await import('./dist/index.js'); if (typeof module.default?.create !== 'function') throw new Error('Packed module entrypoint unavailable'); console.log('PACKED_MODULE_IMPORTED');",
      ],
      unpacked,
    );
    assert.equal(
      importResult.stdout.includes('PACKED_MODULE_IMPORTED'),
      true,
      `packed module entrypoint did not report PACKED_MODULE_IMPORTED\nstdout:\n${importResult.stdout}`,
    );

    // Run the shipped native-host CLI from the unpacked artifact. Missing
    // host configuration is the expected, honest failure path.
    const cliResult = run(process.execPath, [join(unpacked, 'native-host', 'native-host-cli.mjs')], unpacked);
    assert.equal(
      cliResult.stderr.includes(hostConfigurationError),
      true,
      `packed native-host CLI did not report the missing host configuration\nstderr:\n${cliResult.stderr}`,
    );
    assert.equal(cliResult.status, 1, `packed native-host CLI should fail closed, exited ${cliResult.status}`);

    const archiveSha256 = createHash('sha256')
      .update(await readFile(archive))
      .digest('hex');
    console.log(
      JSON.stringify({
        archive: archiveName,
        bytes: statSync(archive).size,
        sha256: archiveSha256,
        members: listing.length,
        toolchain: await toolchainDescription(buildNodeModules),
      }),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
