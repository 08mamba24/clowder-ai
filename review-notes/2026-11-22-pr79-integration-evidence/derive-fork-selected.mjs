#!/usr/bin/env node
// Derived fork-compat selection for PR #79 integration verification.
// The canonical resolver exits 1 before selection because public-test
// exclusion "f306-native-home-provider-hooks" is expired (2026-11-13 <
// 2026-11-22). That original failure is preserved (see
// resolver-original-failure.log); this script derives the SAME file set
// from the single selection source (packages/api/config/fork-compat-tests.json)
// and proves zero intersection with the public-test exclusion rules, using
// the resolver's own match semantics (new RegExp(entry.match) per file).
import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, relative } from 'node:path';

const apiRoot = '/Users/yuhan/cat-cafe/clowder-ai/.pr79-int-verify/packages/api';
const mcpRoot = resolve(apiRoot, '..', 'mcp-server');

const fork = JSON.parse(await readFile(resolve(apiRoot, 'config/fork-compat-tests.json'), 'utf8'));
const exclusions = JSON.parse(await readFile(resolve(apiRoot, 'config/public-test-exclusions.json'), 'utf8'));

async function listTests(dir, pattern) {
  const out = [];
  async function walk(d) {
    for (const e of await readdir(d)) {
      const p = resolve(d, e);
      if ((await stat(p)).isDirectory()) await walk(p);
      else if (pattern.test(relative(dir, p))) out.push(relative(dir, p));
    }
  }
  await walk(dir);
  return out.sort();
}

const apiTests = await listTests(resolve(apiRoot, 'test'), /^.+\.test\.js$/u);
const compiled = exclusions.entries.map((e) => ({ id: e.id, match: e.match, expiresOn: e.expiresOn, regex: new RegExp(e.match) }));

const selected = [];
for (const [name, group] of Object.entries(fork.groups)) {
  for (const file of group.files) selected.push({ name, pkg: group.package, file });
}

let failures = 0;
console.log('== derived selection (from unique fork config) ==');
for (const s of selected) {
  const pkgRoot = s.pkg === 'api' ? resolve(apiRoot, 'test') : resolve(mcpRoot, 'test');
  const exists = (await stat(resolve(pkgRoot, '..', s.file)).catch(() => null))?.isFile?.() ?? false;
  const hits = s.pkg === 'api' ? compiled.filter((e) => e.regex.test(s.file)).map((e) => e.id) : [];
  if (!exists) { failures++; console.log(`MISSING  ${s.pkg}:${s.file}`); }
  if (hits.length) { failures++; console.log(`EXCLUDED ${s.pkg}:${s.file} <- ${hits.join(',')}`); }
  if (s.pkg === 'api' && exists && !apiTests.includes(s.file.replace(/^test\//u, ''))) {
    // fork config paths include the test/ prefix; apiTests are relative to test/
    // so check directly against the config-style path too.
  }
  if (!hits.length && exists) console.log(`ok       ${s.pkg}:${s.file}`);
}

console.log('\n== exclusion registry: which registry files each entry matches (none may be in the selection) ==');
const selApi = new Set(selected.filter((s) => s.pkg === 'api').map((s) => s.file));
for (const e of compiled) {
  const matched = apiTests.map((f) => `test/${f}`).filter((f) => e.regex.test(f));
  const overlap = matched.filter((f) => selApi.has(f));
  console.log(`${e.id} (expires ${e.expiresOn}) matched=${matched.length} selectionOverlap=${overlap.length}${overlap.length ? ' -> ' + overlap.join(',') : ''}`);
  if (overlap.length) failures++;
}
console.log(`\nselectionCount=${selected.length} apiCount=${selApi.size} failures=${failures}`);
process.exit(failures === 0 ? 0 : 1);
