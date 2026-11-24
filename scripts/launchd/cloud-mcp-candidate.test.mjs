// Candidate-stage proof tests for the F247 cloud MCP LaunchAgent set (v2.1).
// No launchctl side effects: the watchdog is exercised only through injected
// fakes (deps.run / deps.dryRun / fixture dirs). CONNECT tests bind local
// loopback fixture servers only — never the real proxy or any external host.
// Run: node --test scripts/launchd/cloud-mcp-candidate.test.mjs
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync, writeSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  DEFAULTS,
  WATCHDOG_PLIST_ENV_ALLOW,
  computeCloudReadiness,
  probeConnectReadiness,
  probeHttpHealth,
  probeTunnelRuntime,
  readState,
  rotateLogs,
  runWatchdogOnce,
  shouldKickstart,
  validateConnectTarget,
  writeState,
} from './cloud-mcp-watchdog.mjs';

const DIR = new URL('.', import.meta.url).pathname;
const read = (f) => readFileSync(join(DIR, f), 'utf8');
// Strip comments (XML + shell) so negative assertions scan executable content
// only — the templates deliberately *document* what they avoid.
const code = (src) =>
  src
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

const SECRET_NAMES = ['CAT_CAFE_REMOTE_TOKEN', 'CAT_CAFE_AGENT_KEY_FILES', 'token', 'secret'];
const LABELS = ['com.cat-cafe.cloud-mcp-origin', 'com.cat-cafe.cloud-mcp-tunnel', 'com.cat-cafe.cloud-mcp-watchdog'];

test('P1-1 runbook mapping: every launchd label has an identically named plist template; runbook loop derives names from $L', () => {
  const runbook = read('INSTALL-cloud-mcp.md');
  for (const label of LABELS) {
    assert.ok(existsSync(join(DIR, `${label}.plist.template`)), `missing template for ${label}`);
    assert.ok(runbook.includes(`LABELS=(${LABELS.join(' ')})`), 'runbook must declare the exact label set');
    assert.ok(runbook.includes('"$SRC/$L.plist.template"'), 'runbook must derive template path from label');
  }
});

test('plists: exact labels, no credential values; origin/tunnel carry no EnvironmentVariables; watchdog env is name-allowlisted', () => {
  for (const label of LABELS) {
    const xml = code(read(`${label}.plist.template`));
    assert.ok(xml.includes(`<string>${label}</string>`), `${label} plist must carry its own label`);
    assert.ok(!xml.includes('connect-tunnel.py'), `${label} plist must not reference connect-tunnel.py`);
    for (const s of SECRET_NAMES) {
      const re = new RegExp(`${s}\\s*=[^<\\s]`, 'i');
      assert.ok(!re.test(xml), `${label} appears to embed a value for ${s}`);
    }
  }
  const origin = code(read('com.cat-cafe.cloud-mcp-origin.plist.template'));
  const tunnel = code(read('com.cat-cafe.cloud-mcp-tunnel.plist.template'));
  assert.ok(!origin.includes('EnvironmentVariables'), 'origin env enters only via wrapper/env file');
  assert.ok(!tunnel.includes('EnvironmentVariables'), 'tunnel env enters only via wrapper');
  const wd = readFileSync(join(DIR, 'com.cat-cafe.cloud-mcp-watchdog.plist.template'), 'utf8');
  const envSection = /EnvironmentVariables[\s\S]*?<\/dict>/.exec(wd)?.[0] ?? '';
  const wdKeys = [...envSection.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1]);
  assert.ok(wdKeys.length > 0, 'watchdog plist must pin a deterministic env allowlist');
  for (const k of wdKeys) {
    assert.ok(WATCHDOG_PLIST_ENV_ALLOW.includes(k), `watchdog plist env key ${k} not in non-sensitive allowlist`);
  }
});

test('wrappers: placeholders refuse execution; tokens never interpolated into argv; no env-file sourcing', () => {
  for (const f of ['cloud-mcp-origin-wrapper.sh', 'cloud-mcp-tunnel-wrapper.sh']) {
    const src = read(f);
    assert.match(src, /unreplaced placeholder/, `${f} must refuse while placeholders remain`);
    const execLines = src.split('\n').filter((l) => l.trim().startsWith('exec '));
    assert.ok(execLines.length > 0, `${f} must exec its service`);
    for (const line of execLines) {
      for (const s of ['CAT_CAFE_REMOTE_TOKEN', 'AGENT_KEY']) {
        assert.ok(!line.includes(`$${s}`) && !line.includes(`\${${s}}`), `argv leak in ${f}: ${line}`);
      }
    }
    const r = spawnSync('bash', ['-n', join(DIR, f)], { encoding: 'utf8' });
    assert.equal(r.status, 0, `bash -n failed for ${f}: ${r.stderr}`);
  }
  const origin = code(read('cloud-mcp-origin-wrapper.sh'));
  assert.ok(!/^[\s]*source[\s]/m.test(origin), 'origin wrapper must never source (strict parser only)');
  assert.ok(!origin.includes('. "$ENV_FILE"'), 'origin wrapper must not dot-source the env file');
});

test('P2 tunnel wrapper: proxy env exported (upper+lower), cwd = verified owner cwd, isolated HOME kept, no connect-tunnel.py', () => {
  const src = read('cloud-mcp-tunnel-wrapper.sh');
  const c = code(src);
  assert.ok(!c.includes('connect-tunnel.py'), 'tunnel wrapper must never call connect-tunnel.py');
  assert.match(c, /exec "\$TUNNEL_BIN" run --profile-dir/, 'must exec foreground tunnel-client run');
  assert.match(c, /export HOME="\$ISO_HOME"/, 'must pin isolated HOME');
  assert.match(c, /TUNNEL_CWD="\/Users\/yuhan\/cat-cafe\/clowder-ai"/, 'cwd must stay at the verified owner cwd (lsof 2026-11-23)');
  assert.match(c, /cd "\$TUNNEL_CWD"/, 'must cd to TUNNEL_CWD, not ISO_HOME');
  for (const v of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
    assert.ok(new RegExp(`export ${v}="\\$PROXY_URL"`).test(c), `missing explicit export ${v}`);
  }
  assert.match(src, /export NO_PROXY="\$NO_PROXY_LIST"/, 'NO_PROXY must be exported explicitly');
  // v2.1.6: NO_PROXY/XDG were resolved from the live owner process env; the
  // comments must carry the VERIFIED marker (twice: proxy block + XDG block)
  // and must NOT keep the old TODO(#128) wording.
  assert.equal((src.match(/VERIFIED 2026-11-23 from the live owner/g) || []).length, 2, 'both #128 TODO blocks must become verified wording');
  assert.doesNotMatch(src, /TODO\(#128\)/, 'no TODO(#128) may remain in the tunnel wrapper');
  assert.match(src, /ENV-VALUE PARITY ONLY/, 'verified wording must not overclaim proxy reachability');
  assert.doesNotMatch(src, /ps eww/, 'the stale unreadable-env excuse must be gone');
  assert.match(c, /owner_probe/, 'owner detection must use bound-identity probe');
});

test('P2/v2.1.6 origin wrapper: HOME pinned to the LIVE isolated home (data-root parity), strict parser seam present', () => {
  const src = read('cloud-mcp-origin-wrapper.sh');
  assert.match(code(src), /export HOME="\$ORIGIN_HOME"/);
  assert.match(src, /ORIGIN_HOME="\/Users\/yuhan\/\.cat-cafe\/zcode\/app-server-home"/, 'must pin the live origin HOME, not the user home');
  assert.doesNotMatch(src, /ORIGIN_HOME="\/Users\/yuhan"\n/, 'the old /Users/yuhan pin must be gone (data-root drift)');
  assert.match(src, /path-validator\.ts:39/, 'HOME rationale must cite the os.homedir() fallback consumer');
  assert.match(src, /os\.homedir\(\) RETURNS the process HOME/, 'rationale must state the corrected causality');
  assert.doesNotMatch(src, /must see the REAL user home/, 'the inverted v2.x rationale must not survive anywhere');
  assert.match(src, /CAT_CAFE_DATA_DIR stays deliberately UNSET|Keep CAT_CAFE_DATA_DIR unset/, 'live fallback semantics must be documented');
  assert.match(src, /--verify-env/, 'verification seam must exist (v2.1.4: parse + required-key completeness)');
});

test('watchdog: kickstart needs 2 consecutive fails then 15min cooldown (no double pull-up storm)', () => {
  const cfg = DEFAULTS;
  const t0 = 1_000_000;
  assert.deepEqual(shouldKickstart({ fails: 1, lastKickstartAt: 0 }, t0, cfg), { kick: false, reason: 'below-fail-threshold' });
  assert.equal(shouldKickstart({ fails: 2, lastKickstartAt: 0 }, t0, cfg).kick, true);
  assert.equal(shouldKickstart({ fails: 5, lastKickstartAt: t0 }, t0 + 60_000, cfg).kick, false);
  assert.equal(shouldKickstart({ fails: 5, lastKickstartAt: t0 }, t0 + 16 * 60_000, cfg).kick, true);
});

function fakeWorld({ originHealthStatus = 500, tunnelLoaded = true, originLoaded = true } = {}) {
  const calls = [];
  const deps = {
    uid: 501,
    nowMs: Date.parse('2026-11-23T09:00:00Z'),
    dryRun: false,
    run: (cmd, args) => {
      assert.equal(cmd, '/bin/launchctl', 'watchdog must invoke launchctl by absolute path');
      calls.push(args.join(' '));
      if (args[0] === 'print') {
        const label = args[1].split('/').pop();
        const loaded = label.endsWith('-origin') ? originLoaded : tunnelLoaded;
        if (!loaded) return { status: 113, stdout: '' };
        return { status: 0, stdout: 'gui/501/com.cat-cafe.x = {\n  state = running\n  pid = 4242\n}\n' };
      }
      return { status: 0, stdout: '' };
    },
    fetch: async () => ({ status: originHealthStatus }),
  };
  return { calls, deps };
}

test('P1-2/P1-3 watchdog: tunnel running without runtime probe is unknown-not-healthy; cloud never claims ready; origin failures drive bounded kickstart', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'cloud-mcp-wd-'));
  const logDir = mkdtempSync(join(tmpdir(), 'cloud-mcp-lg-'));
  const cfg = { ...DEFAULTS, stateDir, logDir };
  const { calls, deps } = fakeWorld({ originHealthStatus: 500 });

  const r1 = await runWatchdogOnce(cfg, deps);
  assert.equal(r1.cloud, 'not-ready', 'origin health failing => not-ready');
  assert.ok(r1.line.includes('tunnel.launchd=running/unknown'), r1.line);
  const tunnelState = JSON.parse(readFileSync(join(stateDir, 'watchdog.com.cat-cafe.cloud-mcp-tunnel.json'), 'utf8'));
  assert.equal(tunnelState.fails, 0, 'unknown must never increment tunnel fails');
  const st1 = JSON.parse(readFileSync(join(stateDir, 'watchdog.com.cat-cafe.cloud-mcp-origin.json'), 'utf8'));
  assert.equal(st1.fails, 1);
  assert.ok(!calls.some((c) => c.startsWith('kickstart')), 'no kickstart on first failure');

  const r2 = await runWatchdogOnce(cfg, deps);
  assert.ok(calls.some((c) => c.startsWith('kickstart -k gui/501/com.cat-cafe.cloud-mcp-origin')), 'second deterministic fail round kicks origin');
  assert.ok(!calls.some((c) => c.startsWith('kickstart') && c.includes('tunnel')), 'tunnel must never be kicked on unknown health');
  assert.ok(r2.line.includes('cloud='), r2.line);

  calls.length = 0;
  await runWatchdogOnce(cfg, { ...deps, nowMs: deps.nowMs + 60_000 });
  assert.ok(!calls.some((c) => c.startsWith('kickstart')), 'cooldown must gate repeat kickstarts');

  // recovery: health 200 resets fails; cloud stays 'unknown' (tunnel probe
  // missing + CONNECT disabled) — NOT 'ready'.
  const r3 = await runWatchdogOnce(cfg, { ...deps, nowMs: deps.nowMs + 20 * 60_000, fetch: async () => ({ status: 200 }) });
  assert.equal(r3.cloud, 'unknown', 'cloud readiness must cap at unknown without runtime probe + CONNECT pass');
  const st3 = JSON.parse(readFileSync(join(stateDir, 'watchdog.com.cat-cafe.cloud-mcp-origin.json'), 'utf8'));
  assert.equal(st3.fails, 0);
  const latest = JSON.parse(readFileSync(join(stateDir, 'watchdog.latest.json'), 'utf8'));
  assert.equal(latest.cloud, 'unknown');
  const status = readFileSync(join(logDir, 'watchdog-status.tsv'), 'utf8');
  for (const secret of ['CAT_CAFE_REMOTE_TOKEN=', 'token=']) assert.ok(!status.includes(secret));
});

test('watchdog: unloaded job => needs-operator verdict, fail counted, NO kickstart attempt', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'cloud-mcp-wd-'));
  const logDir = mkdtempSync(join(tmpdir(), 'cloud-mcp-lg-'));
  const cfg = { ...DEFAULTS, stateDir, logDir };
  const { calls, deps } = fakeWorld({ originLoaded: false });
  deps.nowMs += 60_000;
  const r = await runWatchdogOnce(cfg, deps);
  assert.equal(r.cloud, 'not-ready', 'origin unloaded is a deterministic unhealthy signal');
  assert.ok(r.results.some((x) => x.verdict === 'unloaded-needs-operator'));
  assert.ok(!calls.some((c) => c.startsWith('kickstart')), 'kickstart cannot fix an unloaded job');
});

test('P1-4 connect: strict target validation matrix', () => {
  assert.deepEqual(validateConnectTarget('api.openai.com:443'), { ok: true, host: 'api.openai.com', port: 443 });
  assert.equal(validateConnectTarget('api.openai.com').ok, false, 'implicit port must be rejected');
  assert.equal(validateConnectTarget('api.openai.com:443/path').ok, false);
  assert.equal(validateConnectTarget('user:pw@proxy:443').ok, false, 'userinfo/CRLF-injection surface rejected');
  assert.equal(validateConnectTarget('a b:443').ok, false);
  assert.equal(validateConnectTarget('evil\r\nX-Injected: 1:443').ok, false);
  assert.equal(validateConnectTarget(':443').ok, false);
  assert.equal(validateConnectTarget('host:0').ok, false);
  assert.equal(validateConnectTarget('host:70000').ok, false);
});

async function withConnectFixture(handler, fn) {
  const server = net.createServer((sock) => handler(sock));
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const port = server.address().port;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

test('P1-4 connect: wire format is real CRLF, status parsed strictly, fragmented responses handled', async () => {
  let seen = null;
  await withConnectFixture(
    (sock) => {
      const chunks = [];
      sock.on('data', (d) => {
        chunks.push(d);
        const buf = Buffer.concat(chunks);
        if (buf.includes(Buffer.from('\r\n\r\n', 'latin1'))) {
          seen = buf.toString('latin1');
          // fragment the response across two writes
          sock.write('HTTP/1.1 ');
          setTimeout(() => sock.write('200 Connection established\r\n\r\n'), 10);
        }
      });
    },
    async (proxyUrl) => {
      const r = await probeConnectReadiness(proxyUrl, 'api.openai.com:443', 2_000);
      assert.deepEqual(r, { state: 'pass', code: 'status-200' });
      assert.equal(
        seen,
        'CONNECT api.openai.com:443 HTTP/1.1\r\nHost: api.openai.com:443\r\n\r\n',
        'request bytes must be real CRLF framing, not literal backslashes',
      );
    },
  );
});

test('P1-4 connect: non-200 => classified fail without echoing proxy text; silent proxy => timeout', async () => {
  await withConnectFixture(
    (sock) => {
      sock.on('data', () => sock.write('HTTP/1.1 403 Forbidden secret-reason-line\r\n\r\n'));
    },
    async (proxyUrl) => {
      const r = await probeConnectReadiness(proxyUrl, 'example.com:443', 2_000);
      assert.deepEqual(r, { state: 'fail', code: 'status-403' });
      assert.ok(!JSON.stringify(r).includes('Forbidden'), 'raw proxy content must not leak into results');
    },
  );
  await withConnectFixture(
    () => {},
    async (proxyUrl) => {
      const r = await probeConnectReadiness(proxyUrl, 'example.com:443', 120);
      assert.equal(r.state, 'fail');
      assert.equal(r.code, 'timeout');
    },
  );
});

test('connect: disabled-not-passed without operator target', async () => {
  const r = await probeConnectReadiness('http://127.0.0.1:1', null);
  assert.equal(r.state, 'disabled');
});

test('v2.1 P2-6 connect: oversized status line with NO CRLF ever => bad-status-line, not timeout-hang', async () => {
  await withConnectFixture(
    (sock) => {
      // never terminates the line with CRLF — exercises the >1024-byte guard
      sock.on('data', () => sock.write('A'.repeat(2048)));
    },
    async (proxyUrl) => {
      const r = await probeConnectReadiness(proxyUrl, 'example.com:443', 3_000);
      assert.deepEqual(r, { state: 'fail', code: 'bad-status-line' });
    },
  );
});

test('v2.1 P1-1 cloud readiness matrix: tunnelLoaded is a distinct deterministic dimension', () => {
  assert.equal(computeCloudReadiness({ originHealthy: true, tunnelLoaded: true, tunnelRuntime: 'healthy', connectState: 'pass' }), 'ready');
  assert.equal(computeCloudReadiness({ originHealthy: true, tunnelLoaded: true, tunnelRuntime: 'unknown', connectState: 'pass' }), 'unknown');
  assert.equal(computeCloudReadiness({ originHealthy: true, tunnelLoaded: true, tunnelRuntime: 'healthy', connectState: 'disabled' }), 'unknown');
  assert.equal(computeCloudReadiness({ originHealthy: true, tunnelLoaded: true, tunnelRuntime: 'healthy', connectState: 'fail' }), 'not-ready');
  assert.equal(computeCloudReadiness({ originHealthy: false, tunnelLoaded: true, tunnelRuntime: 'healthy', connectState: 'pass' }), 'not-ready');
  // the v2 gap: everything else green, but the tunnel job is not in launchd
  assert.equal(computeCloudReadiness({ originHealthy: true, tunnelLoaded: false, tunnelRuntime: 'unknown', connectState: 'pass' }), 'not-ready');
  assert.equal(computeCloudReadiness({ originHealthy: true, tunnelLoaded: false, tunnelRuntime: 'unknown', connectState: 'disabled' }), 'not-ready');
});

test('v2.1 P1-1 watchdog integration: tunnel unloaded + origin healthy => cloud not-ready, no tunnel kickstart', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'cloud-mcp-wd-'));
  const logDir = mkdtempSync(join(tmpdir(), 'cloud-mcp-lg-'));
  const cfg = { ...DEFAULTS, stateDir, logDir };
  const { calls, deps } = fakeWorld({ originHealthStatus: 200, tunnelLoaded: false });
  const r = await runWatchdogOnce(cfg, deps);
  assert.equal(r.cloud, 'not-ready', 'unloaded tunnel must not be masked as unknown when CONNECT is disabled');
  assert.ok(r.results.some((x) => x.label.endsWith('-tunnel') && x.verdict === 'unloaded-needs-operator'));
  assert.ok(!calls.some((c) => c.startsWith('kickstart') && c.includes('tunnel')), 'unloaded is operator-bootstrap, never kickstart');
});

test('v2.1 P2-3 tunnel runtime probe: fresh ready => healthy; stale ready => unknown/probe-stale; unconfigured => unknown', () => {
  assert.deepEqual(probeTunnelRuntime(null), { runtime: 'unknown', code: 'probe-not-configured' });
  const dir = mkdtempSync(join(tmpdir(), 'cloud-mcp-rt-'));
  const p = join(dir, 'status');
  const nowMs = Date.parse('2026-11-23T09:00:00Z');
  writeFileSync(p, 'ready\n');
  utimesSync(p, new Date(nowMs - 10_000), new Date(nowMs - 10_000));
  assert.deepEqual(probeTunnelRuntime(p, nowMs, 120_000), { runtime: 'healthy', code: 'probe-ready' });
  utimesSync(p, new Date(nowMs - 130_000), new Date(nowMs - 130_000));
  assert.deepEqual(probeTunnelRuntime(p, nowMs, 120_000), { runtime: 'unknown', code: 'probe-stale' }, 'a stale ready file must never count as healthy');
  // v2.1.1 P2: future mtime (clock rollback / bogus timestamp / touch) is not freshness
  utimesSync(p, new Date(nowMs + 60_000), new Date(nowMs + 60_000));
  assert.deepEqual(probeTunnelRuntime(p, nowMs, 120_000), { runtime: 'unknown', code: 'probe-invalid-time' }, 'future mtime must never pass as ready');
  writeFileSync(p, 'connecting');
  utimesSync(p, new Date(nowMs), new Date(nowMs));
  assert.deepEqual(probeTunnelRuntime(p, nowMs, 120_000), { runtime: 'unknown', code: 'probe-not-ready' });
});

test('P2 rotation: active launchd logs copytruncate (inode preserved for live fds); watchdog-closed TSV rename-shifts', () => {
  const logDir = mkdtempSync(join(tmpdir(), 'cloud-mcp-rot-'));
  const p = join(logDir, 'origin.out.log');
  writeFileSync(p, 'x'.repeat(100));
  const fd = openSync(p, 'a'); // simulate launchd's long-lived fd
  const inoBefore = statSync(p).ino;
  const cfg = { maxBytes: 50, keep: 2 };
  const rot = rotateLogs(logDir, cfg);
  assert.deepEqual(rot, [{ name: 'origin.out.log', mode: 'copytruncate' }]);
  assert.equal(statSync(p).ino, inoBefore, 'active file inode must be preserved');
  assert.equal(readFileSync(p, 'utf8'), '');
  assert.equal(readFileSync(`${p}.1`, 'utf8').length, 100);
  writeSync(fd, 'after'); // old fd keeps writing the LIVE file
  assert.equal(readFileSync(p, 'utf8'), 'after');
  closeSync(fd);
  // second rotation shifts .1 -> .2 and caps at keep
  writeFileSync(p, 'y'.repeat(100));
  rotateLogs(logDir, cfg);
  assert.ok(existsSync(`${p}.2`));
  writeFileSync(p, 'z'.repeat(100));
  rotateLogs(logDir, cfg);
  assert.ok(!existsSync(`${p}.3`), 'must not grow beyond keep');
  // TSV is rename-mode (watchdog holds no fd between rounds)
  writeFileSync(join(logDir, 'watchdog-status.tsv'), 't'.repeat(100));
  const rot2 = rotateLogs(logDir, cfg);
  assert.deepEqual(rot2, [{ name: 'watchdog-status.tsv', mode: 'rename' }]);
  assert.ok(!existsSync(join(logDir, 'watchdog-status.tsv')), 'renamed away, recreated on next append');
  // small files untouched
  writeFileSync(join(logDir, 'b.log'), 'tiny');
  assert.deepEqual(rotateLogs(logDir, cfg), []);
});

test('P2 state: atomic write leaves no temp; corrupt state resets with corrupt flag; latest.json written', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'cloud-mcp-st-'));
  writeState(stateDir, 'x', { fails: 3, lastKickstartAt: 9 });
  assert.deepEqual(readState(stateDir, 'x'), { state: { fails: 3, lastKickstartAt: 9 }, corrupt: false });
  assert.ok(!readdirSync(stateDir).some((n) => n.includes('.tmp-')), 'no temp residue after atomic write');
  writeFileSync(join(stateDir, 'watchdog.x.json'), '{truncated');
  const r = readState(stateDir, 'x');
  assert.equal(r.corrupt, true);
  assert.deepEqual(r.state, { fails: 0, lastKickstartAt: 0 });
});

test('probeHttpHealth: 200 passes, non-200 and timeout fail', async () => {
  assert.deepEqual(await probeHttpHealth('http://x/health', 100, async () => ({ status: 200 })), { ok: true, status: 200 });
  const slow = await probeHttpHealth('http://x/health', 20, () => new Promise((res) => setTimeout(() => res({ status: 200 }), 1000)));
  assert.equal(slow.ok, false);
});

test('P2 env parser: allowlist + syntax hardening; malicious values never execute', () => {
  const wrapper = join(DIR, 'cloud-mcp-origin-wrapper.sh');
  const tmp = mkdtempSync(join(tmpdir(), 'cloud-mcp-env-'));
  const good = join(tmp, 'good.env');
  writeFileSync(good, [
    '# operator env file',
    'export CAT_CAFE_REMOTE_PORT=3098',
    'CAT_CAFE_DESKTOP_MODE="cloud-pro-phase0"',
    `CAT_CAFE_AGENT_KEY_FILES='{"gpt-pro":"/Users/yuhan/.cat-cafe/keys/gpt-pro.json"}'`,
    "CAT_CAFE_REMOTE_TOKEN='opaque-value-with-dash_and.dot'",
  ].join('\n'));
  const r1 = spawnSync('bash', [wrapper, '--verify-env', good], { encoding: 'utf8' });
  assert.equal(r1.status, 0, r1.stderr);
  for (const k of ['CAT_CAFE_REMOTE_PORT', 'CAT_CAFE_DESKTOP_MODE', 'CAT_CAFE_AGENT_KEY_FILES', 'CAT_CAFE_REMOTE_TOKEN']) {
    assert.ok(r1.stdout.includes(k), `parsed key ${k} missing from name list`);
  }
  assert.ok(!r1.stdout.includes('opaque-value'), 'parser seam must print names only, never values');

  const marker = join(tmp, 'PWNED');
  const evil = [
    join(tmp, 'evil1.env'),
    join(tmp, 'evil2.env'),
    join(tmp, 'evil3.env'),
    join(tmp, 'evil4.env'),
  ];
  writeFileSync(evil[0], `CAT_CAFE_REMOTE_TOKEN=$(touch ${marker})\n`);
  writeFileSync(evil[1], 'CAT_CAFE_REMOTE_TOKEN=`touch ' + marker + '`\n');
  writeFileSync(evil[2], 'SOME_OTHER_KEY=x\n');
  writeFileSync(evil[3], 'CAT_CAFE_REMOTE_TOKEN=a; rm -rf ' + tmp + '\n');
  for (const f of evil) {
    const r = spawnSync('bash', [wrapper, '--verify-env', f], { encoding: 'utf8' });
    assert.equal(r.status, 78, `must refuse ${f}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /env-file-/);
    assert.ok(!existsSync(marker), 'command substitution must never execute');
  }
});

test('v2.1 P2-2 env parser: CRLF file and duplicate keys refused with stable markers', () => {
  const wrapper = join(DIR, 'cloud-mcp-origin-wrapper.sh');
  const tmp = mkdtempSync(join(tmpdir(), 'cloud-mcp-env2-'));
  const crlf = join(tmp, 'crlf.env');
  writeFileSync(crlf, "CAT_CAFE_REMOTE_TOKEN='opaque'\r\nCAT_CAFE_AGENT_KEY_FILES='{}'\r\n");
  const r1 = spawnSync('bash', [wrapper, '--verify-env', crlf], { encoding: 'utf8' });
  assert.equal(r1.status, 78, r1.stderr);
  assert.match(r1.stderr, /env-file-crlf/, 'CR must be refused, never smuggled into values');
  assert.ok(!r1.stdout.includes('opaque'), 'refusal path must not print values');
  const dup = join(tmp, 'dup.env');
  writeFileSync(dup, 'CAT_CAFE_REMOTE_PORT=3098\nCAT_CAFE_REMOTE_PORT=3099\n');
  const r2 = spawnSync('bash', [wrapper, '--verify-env', dup], { encoding: 'utf8' });
  assert.equal(r2.status, 78, r2.stderr);
  assert.match(r2.stderr, /env-file-duplicate/, 'last-wins masking must be refused');
});

test('P2 owner probe: bound-identity match on fixture argv; profile isolation; no false match on unrelated processes', () => {
  const wrapper = join(DIR, 'cloud-mcp-tunnel-wrapper.sh');
  const fakeDir = '/Users/yuhan/.cat-cafe/cloud-tunnel/profiles-fixture';
  const fakeProf = 'fixture-prof';
  // `sh -c 'sleep …' <arg>` keeps the fixture's full argv only if the command
  // isn't a single exec-optimized builtin (`& wait` forces sh to stay resident
  // with the pattern-bearing argv visible to pgrep).
  const noise = spawn('sh', ['-c', '/bin/sleep 20 & wait', 'tunnel-client run --profile-dir /some/other/profiles --profile other-prof'], { stdio: 'ignore' });
  const owner = spawn('sh', ['-c', '/bin/sleep 20 & wait', `tunnel-client run --profile-dir ${fakeDir} --profile ${fakeProf}`], { stdio: 'ignore' });
  spawnSync('sleep', ['0.3']); // let both fixtures finish exec so pgrep sees their argv
  try {
    const hit = spawnSync('bash', [wrapper, '--owner-probe', fakeDir, fakeProf], { encoding: 'utf8' });
    assert.equal(hit.status, 0, hit.stderr);
    assert.match(hit.stdout, new RegExp(`owner ${owner.pid}`), 'must find the fixture owner pid');
    const miss = spawnSync('bash', [wrapper, '--owner-probe', fakeDir, 'no-such-profile'], { encoding: 'utf8' });
    assert.equal(miss.status, 1);
    assert.equal(miss.stdout.trim(), 'no-owner');
    const other = spawnSync('bash', [wrapper, '--owner-probe', '/other/dir', fakeProf], { encoding: 'utf8' });
    assert.equal(other.stdout.trim(), 'no-owner', 'profile-dir must be part of the identity');
  } finally {
    owner.kill();
    noise.kill();
  }
});

test('v2.1 runbook: fail-fast binary resolution, exact-path uninstall, probe contract + staleness, grep false-refusal, IPv6 boundary', () => {
  const runbook = read('INSTALL-cloud-mcp.md');
  // P1-2: binaries resolved before sed; empty/non-absolute/non-executable refuse
  assert.match(runbook, /NODE_BIN="\$\(command -v node \|\| true\)"/, 'node resolution must be captured, not inline-expanded');
  assert.ok(runbook.includes('[ -x "$NODE_BIN" ]'), 'node must be test -x gated');
  assert.ok(runbook.includes('TUNNEL_BIN_OVERRIDE'), 'tunnel-client must use the verified absolute path with explicit override');
  assert.ok(runbook.includes('/Users/yuhan/.cat-cafe/cloud-tunnel/bin/tunnel-client'), 'host-verified tunnel-client path must be named');
  assert.match(runbook, /s\|__NODE_BIN__\|\$NODE_BIN\|/, 'sed must consume the gated variables');
  assert.ok(runbook.includes('<string></string>'), 'post-generation empty-argument lint must exist');
  // P2-1: uninstall removes the ACTUAL generated location
  assert.ok(runbook.includes('"$DST/LaunchAgents/com.cat-cafe.cloud-mcp-origin.plist"'), 'uninstall must remove generated plists by exact name (v2.1.2: no * globs)');
  assert.ok(runbook.includes('foreign file, refusing'), 'uninstall must refuse on foreign files anywhere under DST');
  // P2-3: probe contract documented with staleness + writer TODO + capability ceiling
  assert.match(runbook, /mtime is in the past AND younger than 120s/, 'probe freshness contract must be stated');
  assert.ok(runbook.includes('probe-stale'), 'staleness code must be documented');
  assert.match(runbook, /no verified writer/, 'the missing writer must be stated, not glossed');
  assert.ok(runbook.includes('does NOT detect or repair a tunnel hang'), 'capability ceiling must be explicit');
  // P2-4: operational grep false-refusal disclosed
  assert.match(runbook, /conservative false-refusal/, 'owner-probe grep pitfall must be in switchover docs');
  // P2-5: IPv6 literal rejection stated
  assert.match(runbook, /rejects IPv6 literals/, 'IPv6 target boundary must be documented');
});

test('v2.1.1 P1 guards: if/fi semantics — hit refuses, miss continues, even under set -e; runbook uses only this form', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cloud-mcp-guard-'));
  const hit = join(dir, 'hit.plist');
  const miss = join(dir, 'miss.plist');
  writeFileSync(hit, '<string>__NODE_BIN__</string>\n');
  writeFileSync(miss, '<string>ok</string>\n');
  const script = (f) => `set -e\nif grep -q '__' "${f}"; then echo LEFT; exit 1; fi\necho CONTINUED\n`;
  const r1 = spawnSync('bash', ['-c', script(hit)], { encoding: 'utf8' });
  assert.equal(r1.status, 1, 'placeholder hit must exit 1');
  assert.match(r1.stdout, /LEFT/);
  const r2 = spawnSync('bash', ['-c', script(miss)], { encoding: 'utf8' });
  assert.equal(r2.status, 0, 'clean plist must continue even with set -e');
  assert.match(r2.stdout, /CONTINUED/);
  const runbook = read('INSTALL-cloud-mcp.md');
  assert.ok(runbook.includes(`if grep -q '__' "$DST/LaunchAgents/$L.plist"; then`), 'runbook placeholder guard must be if/fi');
  assert.ok(runbook.includes(`if grep -qE '<string></string>' "$DST/LaunchAgents/$L.plist"; then`), 'runbook empty-arg guard must be if/fi');
  assert.ok(!/grep -q[^(]*&& \{/.test(runbook), 'no `grep && { }` shorthand may remain in the runbook');
});

test('v2.1.1 P1-B uninstall manifest (runs the runbook snippet itself): refuses foreign files, gates env.origin', () => {
  const runbook = read('INSTALL-cloud-mcp.md');
  const start = runbook.indexOf('Uninstall files');
  assert.ok(start > -1, 'uninstall section must exist');
  const fenceOpen = runbook.indexOf('```bash', start) + 7;
  const body = runbook.slice(fenceOpen, runbook.indexOf('```', fenceOpen));
  const tmpRaw = mkdtempSync(join(tmpdir(), 'cloud-mcp-un-'));
  const DST = realpathSync(tmpRaw); // pwd -P canonicalization must match
  // v2.1.8: the uninstall snippet removes the login copies via $LAUNCH_AGENTS_DIR;
  // the fixture HOME is NOT /Users/<uid>, so the real-home guard only passes via
  // the override — which also keeps the rm -f list away from the developer's HOME.
  const HOMEFIX = realpathSync(mkdtempSync(join(tmpdir(), 'cloud-mcp-unhome-')));
  const FAKE_HOME = join(HOMEFIX, 'Library', 'LaunchAgents');
  mkdirSync(FAKE_HOME, { recursive: true });
  const code = 'LAUNCH_AGENTS_DIR_OVERRIDE=' + FAKE_HOME + '\nCONFIRM_LAUNCH_AGENTS_OVERRIDE=yes\n' + body.replace('DST=/Users/yuhan/.cat-cafe/cloud-mcp', `DST=${DST}`);
  mkdirSync(join(DST, 'LaunchAgents'));
  mkdirSync(join(DST, 'state'));
  mkdirSync(join(DST, 'logs'));
  writeFileSync(join(DST, '.cloud-mcp-root'), 'cloud-mcp launchd set root — see INSTALL-cloud-mcp.md\n');
  for (const L of ['origin', 'tunnel', 'watchdog']) writeFileSync(join(DST, 'LaunchAgents', `com.cat-cafe.cloud-mcp-${L}.plist`), '<plist/>\n');
  for (const L of ['origin', 'tunnel', 'watchdog']) writeFileSync(join(FAKE_HOME, `com.cat-cafe.cloud-mcp-${L}.plist`), '<plist/>\n');
  writeFileSync(join(DST, 'env.origin'), 'CAT_CAFE_REMOTE_PORT=3098\n');
  writeFileSync(join(DST, 'state', 'watchdog.com.cat-cafe.cloud-mcp-origin.json'), '{}');
  writeFileSync(join(DST, 'logs', 'origin.out.log'), 'x');
  writeFileSync(join(DST, 'logs', 'origin.out.log.1'), 'x');
  writeFileSync(join(DST, 'logs', 'watchdog-status.tsv.3'), 'x');
  // 1) a foreign file anywhere under DST => refuse, delete nothing
  writeFileSync(join(DST, 'logs', 'someone-else.sqlite'), 'data');
  const r1 = spawnSync('bash', ['-c', code], { encoding: 'utf8' });
  assert.equal(r1.status, 1, r1.stdout + r1.stderr);
  assert.match(r1.stderr, /foreign file, refusing/);
  assert.ok(existsSync(join(DST, 'LaunchAgents', 'com.cat-cafe.cloud-mcp-origin.plist')), 'nothing may be deleted on refusal');
  assert.ok(existsSync(join(FAKE_HOME, 'com.cat-cafe.cloud-mcp-origin.plist')), 'HOME copies too may survive a refusal');
  // 2) clean tree, no confirmation => managed files gone, env.origin KEPT
  rmSync(join(DST, 'logs', 'someone-else.sqlite'));
  const r2 = spawnSync('bash', ['-c', code], { encoding: 'utf8' });
  assert.equal(r2.status, 0, r2.stdout + r2.stderr);
  assert.ok(!existsSync(join(DST, 'LaunchAgents', 'com.cat-cafe.cloud-mcp-origin.plist')), 'generated plists must actually be removed');
  assert.ok(!existsSync(join(FAKE_HOME, 'com.cat-cafe.cloud-mcp-origin.plist')), 'v2.1.7: the HOME login copies must actually be removed');
  assert.ok(!existsSync(join(DST, 'logs', 'origin.out.log.1')), 'rotated logs by known names removed');
  assert.ok(existsSync(join(DST, 'env.origin')), 'credentials are never silently deleted');
  assert.ok(existsSync(join(DST, '.cloud-mcp-root')), 'marker survives a half-finished uninstall so the script stays re-runnable');
  // 3) explicit operator confirmation => env.origin + marker removed, tree gone
  const r3 = spawnSync('bash', ['-c', code], { encoding: 'utf8', env: { ...process.env, CONFIRM_REMOVE_ENV: 'yes' } });
  assert.equal(r3.status, 0, r3.stdout + r3.stderr);
  assert.ok(!existsSync(join(DST, 'env.origin')), 'CONFIRM_REMOVE_ENV=yes deletes the credential file');
  assert.ok(!existsSync(DST), 'fully confirmed uninstall removes the whole DST');
});

test('v2.1.1 runbook: blocking banner, probe prohibition, DST preflight, invalid-time, env lifecycle', () => {
  const runbook = read('INSTALL-cloud-mcp.md');
  assert.match(runbook, /INSTALL IS BLOCKED/, 'install-blocking statement must be on the first page');
  assert.match(runbook, /FORBIDDEN to configure until a reviewed writer contract/, 'probe use must be prohibited, not merely discouraged');
  assert.ok(runbook.includes('freshness only bounds staleness'), 'freshness-vs-provenance distinction must be stated');
  assert.ok(runbook.includes('probe-invalid-time'), 'future-mtime code must be documented');
  assert.ok(runbook.includes('non-empty WITHOUT install marker'), 'pre-existing unmarked DST must be refused');
  assert.ok(runbook.includes('re-install: only whitelisted managed files will be overwritten'));
  assert.ok(runbook.includes('shell history'), 'env.origin creation must warn against history/heredoc');
  assert.ok(runbook.includes('never silently deleted'), 'env.origin removal must be gated');
  assert.ok(runbook.includes('CONFIRM_REMOVE_ENV'), 'the removal gate must be named');
  assert.ok(runbook.includes('recovery in progress / status unknown'), 'loaded-but-not-running must be worded as recovery, not health');
});

test('v2.1.2 P1/P2 uninstall fail-safe (runs the runbook snippet): symlink/dir/hidden/.4 refuse zero-delete; rm -P branch is real', () => {
  const runbook = read('INSTALL-cloud-mcp.md');
  const start = runbook.indexOf('Uninstall files');
  const fenceOpen = runbook.indexOf('```bash', start) + 7;
  const body = runbook.slice(fenceOpen, runbook.indexOf('```', fenceOpen));
  const build = () => {
    const tmpRaw = mkdtempSync(join(tmpdir(), 'cloud-mcp-fs-'));
    const DST = realpathSync(tmpRaw);
    // v2.1.8: the uninstall block fails closed on a non-real HOME and removes
    // login copies via $LAUNCH_AGENTS_DIR — point the (v2.1.10 double-gated)
    // override at a fixture so the rm -f list can never touch the developer's real ~/Library
    const code = `LAUNCH_AGENTS_DIR_OVERRIDE=${join(tmpRaw, 'login-agents-fixture')}\nCONFIRM_LAUNCH_AGENTS_OVERRIDE=yes\n` + body.replace('DST=/Users/yuhan/.cat-cafe/cloud-mcp', `DST=${DST}`);
    mkdirSync(join(DST, 'LaunchAgents'));
    mkdirSync(join(DST, 'state'));
    mkdirSync(join(DST, 'logs'));
    writeFileSync(join(DST, '.cloud-mcp-root'), 'cloud-mcp launchd set root — see INSTALL-cloud-mcp.md\n');
    for (const L of ['origin', 'tunnel', 'watchdog']) writeFileSync(join(DST, 'LaunchAgents', `com.cat-cafe.cloud-mcp-${L}.plist`), '<plist/>\n');
    writeFileSync(join(DST, 'env.origin'), 'CAT_CAFE_REMOTE_PORT=3098\n');
    writeFileSync(join(DST, 'state', 'watchdog.com.cat-cafe.cloud-mcp-origin.json'), '{}');
    writeFileSync(join(DST, 'state', 'watchdog.latest.json'), '{}');
    writeFileSync(join(DST, 'logs', 'origin.out.log.3'), 'x');
    return { DST, code };
  };
  const plist = (DST) => join(DST, 'LaunchAgents', 'com.cat-cafe.cloud-mcp-origin.plist');
  const run = (code, env) => spawnSync('bash', ['-c', code], { encoding: 'utf8', env: env ? { ...process.env, ...env } : process.env });
  // baseline: the exact tree above (incl. watchdog.latest.json + origin.out.log.3) must pass the scan
  {
    const { DST, code } = build();
    const r = run(code);
    assert.equal(r.status, 0, 'baseline managed tree must pass: ' + r.stdout + r.stderr);
    assert.ok(existsSync(join(DST, 'env.origin')), 'baseline without confirmation keeps credentials');
    rmSync(DST, { recursive: true, force: true });
  }
  // a) symlink => refused outright, zero deletion
  {
    const { DST, code } = build();
    symlinkSync('/etc/hosts', join(DST, 'logs', 'innocent-looking.log'));
    const r = run(code);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /foreign symlink, refusing/);
    assert.ok(existsSync(plist(DST)) && existsSync(join(DST, 'env.origin')), 'refusal must delete nothing');
  }
  // b) empty unexpected dir => refused
  {
    const { DST, code } = build();
    mkdirSync(join(DST, 'state', 'notes'));
    const r = run(code);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /foreign dir, refusing/);
  }
  // c) nested dir containing a file => refused
  {
    const { DST, code } = build();
    mkdirSync(join(DST, 'logs', 'deep', 'er'), { recursive: true });
    writeFileSync(join(DST, 'logs', 'deep', 'er', 'x'), 'x');
    const r = run(code);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /foreign (dir|file), refusing/);
  }
  // d) hidden file at root => refused (find lists dotfiles)
  {
    const { DST, code } = build();
    writeFileSync(join(DST, '.shadow'), 'x');
    const r = run(code);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /foreign file, refusing/);
  }
  // e) .4 rotation suffix beyond manifest .1/.2/.3 => refused
  {
    const { DST, code } = build();
    writeFileSync(join(DST, 'logs', 'origin.out.log.4'), 'x');
    const r = run(code);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /foreign file, refusing/);
  }
  // f) confirmed removal goes through rm -P (not plain unlink) and finishes the tree
  {
    const { DST, code } = build();
    const r = run(code, { CONFIRM_REMOVE_ENV: 'yes' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout + r.stderr, /rm -P/);
    assert.ok(!existsSync(DST), 'fully confirmed uninstall removes the whole DST');
  }
  // static: doc-vs-command consistency for the v2.1.2 items
  assert.ok(runbook.includes('( set -C; : > "$DST/env.origin" )'), 'env.origin bootstrap must be an exclusive (noclobber) create');
  assert.ok(runbook.includes('( set -C; : > "$DST/env.origin.new" )'), '.new bootstrap must be an exclusive (noclobber) create');
  assert.ok(runbook.includes('aborting instead of falling back to a plain unlink'), 'rm -P failure must abort, not downgrade');
  assert.ok(runbook.includes('deletion list == MANAGED_RE exactly'), 'manifest/deletion sameness must be stated');
  assert.ok(!/rm -f "\$DST"\/logs\/\*/.test(runbook), 'no logs/* glob may remain');
  assert.ok(!/state\/watchdog\.\[A-Za-z0-9\._-\]\+/.test(runbook), 'state manifest must be narrowed to exact names');
});

test('v2.1.2 P2-5 OR-list guards: bidirectional behavior under set -e; runbook `|| {` inventory is all exit-1 guards', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cloud-mcp-or-'));
  const empty = join(dir, 'empty');
  const full = join(dir, 'full');
  mkdirSync(empty);
  mkdirSync(full);
  writeFileSync(join(full, 'x'), 'x');
  // exact shape used by the runbook guards: success condition on the LEFT,
  // refuse+exit on the right — deterministic in both directions with set -e on
  const script = (d) => `set -e\n[ -z "$(ls -A "${d}" 2>/dev/null)" ] || { echo REFUSED; exit 1; }\necho CONTINUED\n`;
  const ok = spawnSync('bash', ['-c', script(empty)], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /CONTINUED/);
  const bad = spawnSync('bash', ['-c', script(full)], { encoding: 'utf8' });
  assert.equal(bad.status, 1, 'failing success-condition must trigger the guard');
  assert.match(bad.stdout, /REFUSED/);
  const runbook = read('INSTALL-cloud-mcp.md');
  const lines = runbook.split('\n').filter((l) => l.includes('|| {'));
  assert.ok(lines.length >= 5, 'guard inventory sanity: runbook must contain the known guards');
  for (const l of lines) assert.match(l, /\|\| \{ .*exit 1; \}$/, `non-guard || {{ }} form remains: ${l}`);
});

test('v2.1.3/v2.1.4 P1 env.origin create-or-verify (runs the runbook blocks): no editor on existing file; owner/mode + verify are real gates; failed rotation never touches the live file', () => {
  const runbook = read('INSTALL-cloud-mcp.md');
  const slice = (anchor) => {
    const start = runbook.indexOf(anchor);
    assert.ok(start > -1, `anchor missing: ${anchor}`);
    const open = runbook.indexOf('```bash', start) + 7;
    return runbook.slice(open, runbook.indexOf('```', open));
  };
  const creation = slice('env.origin secure creation');
  const rotation = slice('To ROTATE contents');
  const tmpRaw = mkdtempSync(join(tmpdir(), 'cloud-mcp-envflow-'));
  const DST = realpathSync(tmpRaw);
  copyFileSync(join(DIR, 'cloud-mcp-origin-wrapper.sh'), join(DST, 'cloud-mcp-origin-wrapper.sh'));
  const editorOk = join(DST, 'editor-ok.sh');
  const editorFail = join(DST, 'editor-fail.sh');
  const called = join(DST, 'editor-called');
  writeFileSync(editorOk, '#!/bin/sh\nprintf \'%s\\n\' "$FAKE_ENV_LINE" > "$1"\ntouch "$EDITOR_CALLED"\n');
  writeFileSync(editorFail, '#!/bin/sh\nprintf \'%s\\n\' "CAT_CAFE_REMOTE_TOKEN=partial-must-never-be-trusted" > "$1"\ntouch "$EDITOR_CALLED"\nexit 3\n');
  chmodSync(editorOk, 0o700);
  chmodSync(editorFail, 0o700);
  const runBlock = (body, extra = {}) => {
    const code = body.replace('DST=/Users/yuhan/.cat-cafe/cloud-mcp', `DST=${DST}`);
    const env = { ...process.env, EDITOR: editorOk, EDITOR_CALLED: called, ...extra };
    if (env.EDITOR === null) delete env.EDITOR; // explicit "operator has no EDITOR"
    return spawnSync('bash', ['-c', code], { encoding: 'utf8', env });
  };
  // A complete env is TOKEN + KEY_FILES (+ optional allowlisted keys). The
  // scripted editor feeds printf '%s\n', so fixtures carry no trailing newline.
  const FULL = 'CAT_CAFE_REMOTE_TOKEN=opaque-token-A\nCAT_CAFE_AGENT_KEY_FILES=keys.test.jsonl\nCAT_CAFE_REMOTE_PORT=3098';
  const good = `${FULL}\n`;
  // 1) existing + valid => read-only pass: editor NEVER launched, bytes identical
  writeFileSync(join(DST, 'env.origin'), good, { mode: 0o600 });
  const a = runBlock(creation, { FAKE_ENV_LINE: 'MUST-NOT-BE-WRITTEN' });
  assert.equal(a.status, 0, a.stdout + a.stderr);
  assert.ok(!existsSync(called), 'editor must never run against an existing env.origin');
  assert.equal(readFileSync(join(DST, 'env.origin'), 'utf8'), good, 'existing file bytes unchanged');
  // 2) mode mismatch => hard gate: exit 1, still no editor, bytes unchanged
  chmodSync(join(DST, 'env.origin'), 0o644);
  const b = runBlock(creation, { FAKE_ENV_LINE: 'MUST-NOT-BE-WRITTEN' });
  assert.equal(b.status, 1, 'owner/mode mismatch must exit nonzero, not just print');
  assert.match(b.stdout + b.stderr, /refusing: env\.origin owner\/mode/);
  assert.ok(!existsSync(called), 'gate must fire before any editor use');
  assert.equal(readFileSync(join(DST, 'env.origin'), 'utf8'), good);
  chmodSync(join(DST, 'env.origin'), 0o600);
  // 3) missing => create-only path: editor runs on the fresh empty file, gates pass
  rmSync(join(DST, 'env.origin'));
  const c = runBlock(creation, { FAKE_ENV_LINE: FULL });
  assert.equal(c.status, 0, c.stdout + c.stderr);
  assert.ok(existsSync(called), 'creation path must launch the editor on the fresh file');
  assert.equal(readFileSync(join(DST, 'env.origin'), 'utf8'), good);
  assert.equal(statSync(join(DST, 'env.origin')).mode & 0o777, 0o600);
  // 4) rotation happy path: live replaced atomically via .new, side file gone
  rmSync(called);
  const rotated = `${FULL.replace('opaque-token-A', 'opaque-token-B')}\n`;
  const d = runBlock(rotation, { FAKE_ENV_LINE: FULL.replace('opaque-token-A', 'opaque-token-B') });
  assert.equal(d.status, 0, d.stdout + d.stderr);
  assert.equal(readFileSync(join(DST, 'env.origin'), 'utf8'), rotated);
  assert.ok(!existsSync(join(DST, 'env.origin.new')), '.new consumed by the atomic rename');
  // 5) rotation with unparseable .new: refuse; live bytes untouched; .new quarantined;
  //    command substitution in the value must never execute
  const before = readFileSync(join(DST, 'env.origin'), 'utf8');
  rmSync(called);
  const evil = `CAT_CAFE_REMOTE_TOKEN=$(touch ${join(DST, 'PWNED')})`;
  const e = runBlock(rotation, { FAKE_ENV_LINE: evil });
  assert.equal(e.status, 1);
  assert.match(e.stdout + e.stderr, /failed parse \+ required-key verification/);
  assert.equal(readFileSync(join(DST, 'env.origin'), 'utf8'), before, 'live file untouched on failed rotation');
  assert.ok(existsSync(join(DST, 'env.origin.new')), '.new kept for operator inspection (quarantine)');
  assert.ok(!existsSync(join(DST, 'PWNED')), 'parser fail-closed must prevent any execution');
  // 6) stale .new present => refuse up front (create-only guarantee); reuses state from 5
  const f = runBlock(rotation, { FAKE_ENV_LINE: FULL });
  assert.equal(f.status, 1, f.stdout + f.stderr);
  assert.match(f.stdout + f.stderr, /already exists .*create-only guarantee/);
  assert.equal(readFileSync(join(DST, 'env.origin'), 'utf8'), before);
  rmSync(join(DST, 'env.origin.new'));
  // v2.1.4 P1-3: syntactically valid but credential-incomplete .new => refuse mv
  for (const [name, bad] of [
    ['missing CAT_CAFE_REMOTE_TOKEN', 'CAT_CAFE_AGENT_KEY_FILES=keys.test.jsonl\nCAT_CAFE_REMOTE_PORT=3098\n'],
    ['missing CAT_CAFE_AGENT_KEY_FILES', 'CAT_CAFE_REMOTE_TOKEN=opaque-token-A\nCAT_CAFE_REMOTE_PORT=3098\n'],
    ['comment-only (empty)', '# nothing here\n'],
  ]) {
    assert.ok(!existsSync(join(DST, 'env.origin.new')), 'previous case must clean up .new');
    const r = runBlock(rotation, { FAKE_ENV_LINE: bad });
    assert.equal(r.status, 1, `${name}: incomplete .new must be refused`);
    assert.match(r.stdout + r.stderr, /failed parse \+ required-key verification/, name);
    assert.match(r.stdout + r.stderr, /did not set CAT_CAFE_(REMOTE_TOKEN|AGENT_KEY_FILES)/, name);
    assert.equal(readFileSync(join(DST, 'env.origin'), 'utf8'), before, `${name}: live bytes must be unchanged`);
    rmSync(join(DST, 'env.origin.new')); // quarantine cleanup for the next case
  }
  // v2.1.4 P1-2: EDITOR problems abort before anything is written, live file intact
  const g1 = runBlock(rotation, { EDITOR: null, FAKE_ENV_LINE: FULL });
  assert.equal(g1.status, 1, 'rotation with EDITOR unset must abort');
  assert.match(g1.stdout + g1.stderr, /EDITOR is unset\/empty/);
  assert.ok(!existsSync(join(DST, 'env.origin.new')), 'no .new may be created when EDITOR is missing');
  assert.equal(readFileSync(join(DST, 'env.origin'), 'utf8'), before);
  const g2 = runBlock(rotation, { EDITOR: '/nonexistent/cloud-mcp-editor.sh', FAKE_ENV_LINE: FULL });
  assert.equal(g2.status, 1, 'unresolvable EDITOR must abort');
  assert.match(g2.stdout + g2.stderr, /not a resolvable single executable/);
  assert.ok(!existsSync(join(DST, 'env.origin.new')), 'no .new may be created for an unusable EDITOR');
  const g3 = runBlock(rotation, { EDITOR: editorFail });
  assert.equal(g3.status, 1, 'nonzero editor exit must abort');
  assert.match(g3.stdout + g3.stderr, /editor exited nonzero/);
  assert.equal(readFileSync(join(DST, 'env.origin'), 'utf8'), before, 'failed editor run may never reach the live file');
  assert.equal(readFileSync(join(DST, 'env.origin.new'), 'utf8'), 'CAT_CAFE_REMOTE_TOKEN=partial-must-never-be-trusted\n', 'partial .new stays quarantined, unverified');
  rmSync(join(DST, 'env.origin.new'));
  rmSync(called);
  // creation leg: same guards, and a failed creation must NOT proceed to verify/install
  rmSync(join(DST, 'env.origin'));
  const h1 = runBlock(creation, { EDITOR: null, FAKE_ENV_LINE: FULL });
  assert.equal(h1.status, 1);
  assert.match(h1.stdout + h1.stderr, /EDITOR is unset\/empty/);
  assert.ok(!existsSync(join(DST, 'env.origin')), 'guard must fire before : >, leaving zero filesystem trace');
  const h2 = runBlock(creation, { EDITOR: editorFail });
  assert.equal(h2.status, 1);
  assert.match(h2.stdout + h2.stderr, /editor exited nonzero/);
  assert.ok(!/PARSED|CAT_CAFE_AGENT_KEY_FILES/.test(h2.stdout), 'a failed creation must not run the verify gate');
  assert.equal(readFileSync(join(DST, 'env.origin'), 'utf8'), 'CAT_CAFE_REMOTE_TOKEN=partial-must-never-be-trusted\n');
  // recovery: remove the partial file and re-run the create path cleanly
  rmSync(join(DST, 'env.origin'));
  rmSync(called);
  const h3 = runBlock(creation, { FAKE_ENV_LINE: FULL });
  assert.equal(h3.status, 0, h3.stdout + h3.stderr);
  assert.equal(readFileSync(join(DST, 'env.origin'), 'utf8'), good);
});

test('v2.1.3 P1/P2 uninstall fail-safe (runs the runbook snippet): find failure via PATH shim and FIFO both abort with zero deletions', () => {
  const runbook = read('INSTALL-cloud-mcp.md');
  const start = runbook.indexOf('Uninstall files');
  const fenceOpen = runbook.indexOf('```bash', start) + 7;
  const body = runbook.slice(fenceOpen, runbook.indexOf('```', fenceOpen));
  const build = () => {
    const tmpRaw = mkdtempSync(join(tmpdir(), 'cloud-mcp-ff-'));
    const DST = realpathSync(tmpRaw);
    // v2.1.8: the uninstall block fails closed on a non-real HOME and removes
    // login copies via $LAUNCH_AGENTS_DIR — point the (v2.1.10 double-gated)
    // override at a fixture so the rm -f list can never touch the developer's real ~/Library
    const code = `LAUNCH_AGENTS_DIR_OVERRIDE=${join(tmpRaw, 'login-agents-fixture')}\nCONFIRM_LAUNCH_AGENTS_OVERRIDE=yes\n` + body.replace('DST=/Users/yuhan/.cat-cafe/cloud-mcp', `DST=${DST}`);
    mkdirSync(join(DST, 'LaunchAgents'));
    mkdirSync(join(DST, 'state'));
    mkdirSync(join(DST, 'logs'));
    writeFileSync(join(DST, '.cloud-mcp-root'), 'cloud-mcp launchd set root — see INSTALL-cloud-mcp.md\n');
    for (const L of ['origin', 'tunnel', 'watchdog']) writeFileSync(join(DST, 'LaunchAgents', `com.cat-cafe.cloud-mcp-${L}.plist`), '<plist/>\n');
    writeFileSync(join(DST, 'env.origin'), 'CAT_CAFE_REMOTE_PORT=3098\n');
    writeFileSync(join(DST, 'state', 'watchdog.latest.json'), '{}');
    return { DST, code };
  };
  const plist = (DST) => join(DST, 'LaunchAgents', 'com.cat-cafe.cloud-mcp-origin.plist');
  // a) simulated find failure: PATH shim `find` that errors — rc must be consumed
  //    BEFORE any rm, proving the v2.1.2 process-substitution fail-open is closed
  const shim = mkdtempSync(join(tmpdir(), 'cloud-mcp-shim-'));
  const fakeFind = join(shim, 'find');
  writeFileSync(fakeFind, '#!/bin/sh\necho "simulated find failure" >&2\nexit 1\n');
  chmodSync(fakeFind, 0o700);
  {
    const { DST, code } = build();
    const r = spawnSync('bash', ['-c', code], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${shim}:${process.env.PATH}` },
    });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout + r.stderr, /find scan FAILED/);
    assert.match(r.stdout + r.stderr, /simulated find failure/, 'find stderr must be surfaced, not swallowed');
    assert.ok(existsSync(plist(DST)) && existsSync(join(DST, 'env.origin')) && existsSync(join(DST, '.cloud-mcp-root')),
      'failed scan must delete NOTHING');
    rmSync(DST, { recursive: true, force: true });
  }
  // b) FIFO under logs => special-file class refusal, zero deletion
  {
    const { DST, code } = build();
    const mk = spawnSync('mkfifo', [join(DST, 'logs', 'control.fifo')]);
    assert.equal(mk.status, 0, 'fixture requires mkfifo: ' + mk.stderr);
    const r = spawnSync('bash', ['-c', code], { encoding: 'utf8' });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /special file \(fifo\/socket\/device\), refusing/);
    assert.ok(existsSync(plist(DST)) && existsSync(join(DST, 'env.origin')), 'refusal must delete nothing');
    // c) regression: removing the FIFO returns the tree to fully acceptable
    rmSync(join(DST, 'logs', 'control.fifo'));
    const ok = spawnSync('bash', ['-c', code], { encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    rmSync(DST, { recursive: true, force: true });
  }
  // static: scan architecture + class coverage + env gate phrasings present
  assert.ok(runbook.includes('find scan FAILED'), 'find-rc abort must be in the snippet');
  assert.ok(runbook.includes('! -type f ! -type d ! -type l'), 'special-class predicate must exist');
  assert.ok(runbook.includes('read-only verification only, no editor'), 'existing-file path must be read-only');
  assert.ok(runbook.includes('create-only guarantee'), '.new must be create-only with prior refusal');
  assert.ok(!/done < <\(find/.test(runbook), 'no unconsumed process-substitution find may remain');
});

test('v2.1.4 P1-1/P1-3 verify seam has startup strength: one required list, one validator, credential-incomplete files refused by both paths', () => {
  const wrapperPath = join(DIR, 'cloud-mcp-origin-wrapper.sh');
  const wrapper = read('cloud-mcp-origin-wrapper.sh');
  // static — single source of truth for the required-key list
  assert.match(wrapper, /REQUIRED_ENV_KEYS=\(CAT_CAFE_REMOTE_TOKEN CAT_CAFE_AGENT_KEY_FILES\)/, 'the required list must be defined once');
  assert.doesNotMatch(wrapper, /for required in CAT_CAFE_/, 'no second hardcoded required list may remain');
  assert.equal((wrapper.match(/for required in "\$\{REQUIRED_ENV_KEYS\[@\]\}"/g) || []).length, 1, 'exactly one loop, over the shared array');
  assert.equal((wrapper.match(/^verify_env_ready\(\) \{$/gm) || []).length, 1, 'one validator definition');
  assert.equal((wrapper.match(/^\s*verify_env_ready "/gm) || []).length, 2, 'validator called from exactly two sites: seam + startup');
  assert.doesNotMatch(wrapper, /== "--parse-env"/, 'the syntax-only seam must be gone, not merely unused');
  const runbook = read('INSTALL-cloud-mcp.md');
  assert.doesNotMatch(runbook, /wrapper\.sh" --parse-env/, 'no runbook gate may call a weaker seam');
  assert.ok(runbook.includes('cloud-mcp-origin-wrapper.sh" --verify-env "$DST/env.origin"'), 'the create/verify gate must use the strong seam');
  assert.ok(runbook.includes('cloud-mcp-origin-wrapper.sh" --verify-env "$DST/env.origin.new"'), 'the rotation gate must use the strong seam');
  // P1-2 static: both blocks resolve EDITOR before touching the filesystem, and
  // every editor invocation is if-gated (no reliance on an operator `set -e`)
  assert.equal((runbook.match(/EDITOR is unset\/empty/g) || []).length, 2, 'creation AND rotation must guard an unset EDITOR');
  assert.equal((runbook.match(/not a resolvable single executable/g) || []).length, 2, 'both must guard an unresolvable EDITOR');
  assert.equal((runbook.match(/if ! "\$EDITOR" "\$DST\/env\.origin(?:\.new)?"; then/g) || []).length, 2, 'both editor calls must be if-gated');
  assert.doesNotMatch(runbook, /^[ \t]*"\$EDITOR"/m, 'no ungated "$EDITOR" invocation may remain');

  const tmp = mkdtempSync(join(tmpdir(), 'cloud-mcp-verify-'));
  writeFileSync(join(tmp, 'entry.js'), '');
  // same wrapper, placeholders replaced by harmless stubs, so the PRODUCTION
  // startup path (not the seam) reaches the shared validator
  const startupWrapper = (envPath) => {
    const p = join(tmp, `startup-${envPath.split('/').pop()}.sh`);
    writeFileSync(p, wrapper
      .replace('NODE_BIN="__NODE_BIN__"', 'NODE_BIN="/usr/bin/true"')
      .replace('ORIGIN_ENTRY="/Users/yuhan/cat-cafe/cat-cafe-runtime/packages/mcp-server/dist/remote-spike.js"', `ORIGIN_ENTRY="${join(tmp, 'entry.js')}"`)
      .replace('ORIGIN_CWD="/Users/yuhan/cat-cafe/cat-cafe-runtime"', `ORIGIN_CWD="${tmp}"`)
      .replace('ENV_FILE="__CLOUD_MCP_ENV_FILE__"', `ENV_FILE="${envPath}"`)
      .replace('STATE_DIR="__STATE_DIR__"', `STATE_DIR="${join(tmp, `state-${envPath.split('/').pop()}`)}"`));
    return p;
  };
  // compare gate lines without their timestamps
  const gateLine = (s) => s.split('\n').filter((l) => l.includes('origin gate='))
    .map((l) => l.slice(l.indexOf('origin gate='))).join('\n');
  const cases = {
    'port-only': 'CAT_CAFE_REMOTE_PORT=3098\n',
    'comment-only': '# nothing usable here\n',
    'empty-file': '',
    'no-token': 'CAT_CAFE_AGENT_KEY_FILES=keys.test.jsonl\n',
    'no-key-files': 'CAT_CAFE_REMOTE_TOKEN=opaque-A\n',
    'empty-token-value': 'CAT_CAFE_REMOTE_TOKEN=\nCAT_CAFE_AGENT_KEY_FILES=keys.test.jsonl\n',
  };
  for (const [name, content] of Object.entries(cases)) {
    const f = join(tmp, `${name}.env`);
    writeFileSync(f, content, { mode: 0o600 });
    const seam = spawnSync('bash', [wrapperPath, '--verify-env', f], { encoding: 'utf8' });
    assert.equal(seam.status, 78, `${name}: the audited seam must refuse ${JSON.stringify(content)}`);
    assert.match(seam.stderr, /env-file-incomplete/, name);
    assert.match(seam.stderr, /did not set CAT_CAFE_(REMOTE_TOKEN|AGENT_KEY_FILES)/, name);
    assert.ok(!seam.stdout.includes('opaque-A'), 'verification output stays key names only');
    // the production startup path over the SAME file must fail the SAME way
    const st = spawnSync('bash', [startupWrapper(f)], { encoding: 'utf8' });
    assert.equal(st.status, seam.status, `${name}: startup rc must equal seam rc`);
    assert.equal(gateLine(st.stderr), gateLine(seam.stderr), `${name}: startup and seam must report the identical gate`);
  }
  // and the inverse direction: what the seam accepts is exactly what startup accepts
  const ok = join(tmp, 'complete.env');
  writeFileSync(ok, 'CAT_CAFE_REMOTE_TOKEN=opaque-A\nCAT_CAFE_AGENT_KEY_FILES=keys.test.jsonl\nCAT_CAFE_REMOTE_PORT=3098\n', { mode: 0o600 });
  const seamOk = spawnSync('bash', [wrapperPath, '--verify-env', ok], { encoding: 'utf8' });
  assert.equal(seamOk.status, 0, seamOk.stderr);
  for (const k of ['CAT_CAFE_REMOTE_TOKEN', 'CAT_CAFE_AGENT_KEY_FILES', 'CAT_CAFE_REMOTE_PORT']) {
    assert.ok(seamOk.stdout.includes(k), `name ${k} missing from verification output`);
  }
  assert.ok(!seamOk.stdout.includes('opaque-A') && !seamOk.stderr.includes('opaque-A'), 'values must never appear in verification output');
  const stOk = spawnSync('bash', [startupWrapper(ok)], { encoding: 'utf8' });
  assert.equal(stOk.status, 0, `startup must accept what the seam accepted: ${stOk.stderr}`);
});

test('v2.1.5 P2 symlink-safe create (runs the runbook blocks): dangling symlink refuses before any write, link target never created or touched', () => {
  const runbook = read('INSTALL-cloud-mcp.md');
  const slice = (anchor) => {
    const start = runbook.indexOf(anchor);
    assert.ok(start > -1, `anchor missing: ${anchor}`);
    const open = runbook.indexOf('```bash', start) + 7;
    return runbook.slice(open, runbook.indexOf('```', open));
  };
  const creation = slice('env.origin secure creation');
  const rotation = slice('To ROTATE contents');
  const tmpRaw = mkdtempSync(join(tmpdir(), 'cloud-mcp-symlink-'));
  const DST = realpathSync(tmpRaw);
  const OUTSIDE = join(DST, 'outside'); // stands in for anything not under $DST
  mkdirSync(OUTSIDE);
  copyFileSync(join(DIR, 'cloud-mcp-origin-wrapper.sh'), join(DST, 'cloud-mcp-origin-wrapper.sh'));
  const editorOk = join(DST, 'editor-ok.sh');
  const called = join(DST, 'editor-called');
  writeFileSync(editorOk, '#!/bin/sh\nprintf \'%s\\n\' "$FAKE_ENV_LINE" > "$1"\ntouch "$EDITOR_CALLED"\n');
  chmodSync(editorOk, 0o700);
  const FULL = 'CAT_CAFE_REMOTE_TOKEN=opaque-token-A\nCAT_CAFE_AGENT_KEY_FILES=keys.test.jsonl\nCAT_CAFE_REMOTE_PORT=3098';
  const runBlock = (body, extra = {}) => {
    const code = body.replace('DST=/Users/yuhan/.cat-cafe/cloud-mcp', `DST=${DST}`);
    const env = { ...process.env, EDITOR: editorOk, EDITOR_CALLED: called, FAKE_ENV_LINE: FULL, ...extra };
    if (env.EDITOR === null) delete env.EDITOR;
    return spawnSync('bash', ['-c', code], { encoding: 'utf8', env });
  };
  const target = join(OUTSIDE, 'victim');
  const link = join(DST, 'env.origin');

  // a) creation block against a DANGLING symlink at env.origin: refuse, create
  //    nothing, follow nothing, editor never runs. This is exactly the case
  //    `[ ! -e ]` cannot see in v2.1.4.
  symlinkSync(target, link);
  assert.ok(!existsSync(target), 'fixture precondition: link target must not exist');
  let r = runBlock(creation);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /env\.origin is a symlink \(dangling or not\)/);
  assert.ok(!existsSync(target), 'refusal must not create the link target');
  assert.ok(!existsSync(called), 'editor must never run against a symlink path');
  assert.ok(lstatSync(link).isSymbolicLink(), 'the symlink itself must survive untouched for operator inspection');

  // b) same but the link TARGET exists: still refused without read/write/follow
  const victim = join(OUTSIDE, 'existing-victim');
  writeFileSync(victim, 'SECRET-NOT-FOR-THIS-PATH\n');
  rmSync(link);
  symlinkSync(victim, link);
  r = runBlock(creation);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /is a symlink \(dangling or not\)/);
  assert.equal(readFileSync(victim, 'utf8'), 'SECRET-NOT-FOR-THIS-PATH\n', 'target bytes must be untouched');

  // c) rotation block with a dangling symlink at .new: its own message, live untouched
  rmSync(link);
  const live = FULL + '\n';
  writeFileSync(link, live, { mode: 0o600 });
  const newLink = join(DST, 'env.origin.new');
  const newTarget = join(OUTSIDE, 'new-victim');
  symlinkSync(newTarget, newLink);
  r = runBlock(rotation);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /env\.origin\.new is a symlink — do not write through it/);
  assert.ok(!existsSync(newTarget), '.new symlink refusal must not create the target');
  assert.equal(readFileSync(link, 'utf8'), live, 'live env.origin untouched');
  rmSync(newLink);

  // d) non-regular class: env.origin as a DIRECTORY is refused (not just symlinks)
  rmSync(link);
  mkdirSync(link);
  r = runBlock(creation);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /exists but is not a regular file \(dir\/fifo\/socket\/device\?\)/);
  rmSync(link, { recursive: true }); // d) left a directory, not a file

  // e) editor that exits 0 but replaces the path with a symlink: the POST-editor
  //    assert_plain_file catches it before owner/mode or verify ever run
  const editorSwap = join(DST, 'editor-swap.sh');
  writeFileSync(editorSwap, '#!/bin/sh\nrm "$1"\nln -s "$SWAP_TARGET" "$1"\ntouch "$EDITOR_CALLED"\n');
  chmodSync(editorSwap, 0o700);
  const h = runBlock(creation, { EDITOR: editorSwap, SWAP_TARGET: join(OUTSIDE, 'ghost') });
  assert.equal(h.status, 1, 'a symlink left by the editor must abort the run');
  assert.match(h.stdout + h.stderr, /is a symlink \(dangling or not\)/);
  assert.ok(!/CAT_CAFE_(REMOTE_TOKEN|AGENT_KEY_FILES)/.test(h.stdout), 'verify gate must not run after the post-editor refusal');
  assert.ok(!existsSync(join(OUTSIDE, 'ghost')), 'swap target must not be created');
  rmSync(join(DST, 'env.origin')); // remove the swapped-in symlink

  // static: both blocks define and use the guard, and use noclobber create
  assert.equal((runbook.match(/assert_plain_file\(\) \{/g) || []).length, 2, 'both blocks define assert_plain_file');
  assert.equal((runbook.match(/^assert_plain_file "\$DST\/env\.origin"$/gm) || []).length, 2, 'both blocks guard the live path up front');
  assert.equal((runbook.match(/^[ \t]*assert_plain_file "\$DST\/env\.origin(?:\.new)?"$/gm) || []).length, 4, 'pre-branch + post-editor checks in both blocks');
  assert.equal((runbook.match(/\( set -C; : > "\$DST\/env\.origin(?:\.new)?" \)/g) || []).length, 2, 'both creates are noclobber-exclusive');
  assert.ok(!/^\s*: > "\$DST\/env\.origin/m.test(runbook), 'no plain (non-exclusive) : > may remain on a credential path');
});

test('v2.1.5 P2 PARSED_KEYS is per-verification: two verify_env_ready calls in ONE shell print only the second file names', () => {
  const wrapper = read('cloud-mcp-origin-wrapper.sh');
  // slice the pure-function region (parser + validator) out of the wrapper so we
  // can call verify_env_ready twice in the same shell — the seam itself always
  // exits after one call, so the reset bug could only hide in reuse.
  const start = wrapper.indexOf('parse_env_file() {');
  const end = wrapper.indexOf('# Audited verification seam');
  assert.ok(start > -1 && end > start, 'function region must be sliceable');
  const tmp = mkdtempSync(join(tmpdir(), 'cloud-mcp-parsedkeys-'));
  const allowM = /ENV_KEY_ALLOW='([^']*)'/.exec(wrapper);
  assert.ok(allowM, 'allowlist regex must be extractable');
  const scratch = `#!/bin/bash
set -u
ENV_KEY_ALLOW='${allowM[1]}'
gate_fail() { echo "gate_fail $1 $2: $3" >&2; exit "$1"; }
PARSED_KEYS=()
${wrapper.slice(start, end)}
STATE_DIR="${tmp}/gate-scratch"
verify_env_ready "$1"
printf 'FIRST|%s\\n' "$(printf '%s,' "\${PARSED_KEYS[@]:-}")"
verify_env_ready "$2"
printf 'SECOND|%s\\n' "$(printf '%s,' "\${PARSED_KEYS[@]:-}")"
`;
  const script = join(tmp, 'slice.sh');
  writeFileSync(script, scratch, { mode: 0o700 });
  const f1 = join(tmp, 'a.env');
  const f2 = join(tmp, 'b.env');
  writeFileSync(f1, 'CAT_CAFE_REMOTE_TOKEN=opaque-A\nCAT_CAFE_AGENT_KEY_FILES=keys.a.jsonl\nCAT_CAFE_REMOTE_PORT=3098\n', { mode: 0o600 });
  writeFileSync(f2, 'CAT_CAFE_REMOTE_TOKEN=opaque-B\nCAT_CAFE_AGENT_KEY_FILES=keys.b.jsonl\n', { mode: 0o600 });
  const r = spawnSync('bash', [script, f1, f2], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const first = /FIRST\|([^\n]*)/.exec(r.stdout)[1].split(',').filter(Boolean);
  const second = /SECOND\|([^\n]*)/.exec(r.stdout)[1].split(',').filter(Boolean);
  assert.deepEqual(first, ['CAT_CAFE_REMOTE_TOKEN', 'CAT_CAFE_AGENT_KEY_FILES', 'CAT_CAFE_REMOTE_PORT']);
  assert.deepEqual(second, ['CAT_CAFE_REMOTE_TOKEN', 'CAT_CAFE_AGENT_KEY_FILES'], 'second call must not inherit the first file PORT name');
  assert.ok(!r.stdout.includes('opaque-'), 'names only, never values, even across calls');
  // the reset must not change validator behavior: an incomplete file refuses.
  // NOTE the fixture boundary: same-shell reuse leaks call 1's exported vars
  // into call 2's environment, so the incompleteness probe only holds when the
  // bad file is checked FIRST in a fresh shell — which is how every real call
  // site runs it (the seam exits after one call; startup calls once).
  const f3 = join(tmp, 'c.env');
  writeFileSync(f3, 'CAT_CAFE_REMOTE_PORT=3099\n', { mode: 0o600 });
  const r2 = spawnSync('bash', [script, f3, f1], { encoding: 'utf8' });
  assert.equal(r2.status, 78, 'reset must not weaken completeness');
  assert.match(r2.stderr, /env-file-incomplete.*CAT_CAFE_REMOTE_TOKEN/s);
});

test('v2.1.7 P1 render chain (runs the REAL runbook Install block sandboxed): plists render clean, wrappers render at column-0, guard literals survive, production entries reach the fake delegate', async () => {
  const runbook = read('INSTALL-cloud-mcp.md');
  const start = runbook.indexOf('## Install (operator, host shell)');
  assert.ok(start > -1);
  const fenceOpen = runbook.indexOf('```bash', start) + 7;
  const body = runbook.slice(fenceOpen, runbook.indexOf('```', fenceOpen));

  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cloud-mcp-render-')));
  const DST = join(root, 'dst');
  const HOME = join(root, 'home');
  const bin = join(root, 'bin');
  mkdirSync(DST, { recursive: true }); mkdirSync(HOME, { recursive: true }); mkdirSync(bin, { recursive: true });
  const nodeStub = join(bin, 'node');
  writeFileSync(nodeStub, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo v99-fake; exit 0; fi\n[ -n "${CLOUD_MCP_FAKE_NODE_RAN:-}" ] && : > "$CLOUD_MCP_FAKE_NODE_RAN"\nexit 0\n');
  chmodSync(nodeStub, 0o755);
  const tunnelStub = join(root, 'tunnel-client-stub');
  writeFileSync(tunnelStub, '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$TUNNEL_STUB_ARGV_FILE"\nexit 0\n');
  chmodSync(tunnelStub, 0o755);
  const code = body
    .replace('SRC=/path/to/this/scripts/launchd', `SRC=${DIR}`)
    .replace('DST=/Users/yuhan/.cat-cafe/cloud-mcp', `DST=${DST}`);
  const r = spawnSync('bash', ['-c', code], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME,
      TMPDIR: root,
      TUNNEL_BIN_OVERRIDE: tunnelStub,
      // v2.1.8 P1-4b: HOME here is a sandbox fixture, NOT /Users/<uid> — the
      // real-user-home guard only passes via the explicit override, which the
      // production runbook resolution shares with tests. v2.1.10: the override
      // is double-gated, fixtures must confirm it deliberately.
      LAUNCH_AGENTS_DIR_OVERRIDE: join(HOME, 'Library', 'LaunchAgents'),
      CONFIRM_LAUNCH_AGENTS_OVERRIDE: 'yes',
    },
  });
  assert.equal(r.status, 0, `install block must succeed end-to-end: ${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /login reload dir: /, 'install must echo the resolved publish target');
  assert.match(r.stdout, /LAUNCH_AGENTS_DIR_OVERRIDE in effect \(CONFIRMed/, 'override must announce itself as confirmed-and-exceptional');

  const RENDER_LABELS = ['com.cat-cafe.cloud-mcp-origin', 'com.cat-cafe.cloud-mcp-tunnel', 'com.cat-cafe.cloud-mcp-watchdog'];
  for (const L of RENDER_LABELS) {
    const staged = join(DST, 'LaunchAgents', `${L}.plist`);
    const homeCopy = join(HOME, 'Library', 'LaunchAgents', `${L}.plist`);
    assert.ok(existsSync(staged), `${L}: staged plist missing`);
    assert.ok(existsSync(homeCopy), `${L}: HOME login-reload copy missing (v2.1.7 P1-4)`);
    const txt = readFileSync(homeCopy, 'utf8');
    assert.equal(txt, readFileSync(staged, 'utf8'), `${L}: HOME copy must equal the staged render`);
    assert.ok(!txt.includes('__'), `${L}: rendered plist still carries a double-underscore token (P1-1 class regression)`);
  }

  const originInstalled = readFileSync(join(DST, 'cloud-mcp-origin-wrapper.sh'), 'utf8');
  const tunnelInstalled = readFileSync(join(DST, 'cloud-mcp-tunnel-wrapper.sh'), 'utf8');
  assert.ok(originInstalled.includes(`NODE_BIN="${nodeStub}"`), 'origin: NODE_BIN assignment must be rendered');
  assert.ok(originInstalled.includes(`ENV_FILE="${DST}/env.origin"`), 'origin: ENV_FILE assignment must be rendered');
  assert.ok(originInstalled.includes(`STATE_DIR="${DST}/state"`), 'origin: STATE_DIR assignment must be rendered');
  assert.ok(tunnelInstalled.includes(`TUNNEL_BIN="${tunnelStub}"`), 'tunnel: TUNNEL_BIN assignment must be rendered');
  assert.ok(!/^[A-Z_]+="__/.test(originInstalled), 'origin: no column-0 placeholder assignment may survive');
  assert.ok(!/^[A-Z_]+="__/.test(tunnelInstalled), 'tunnel: no column-0 placeholder assignment may survive');
  // anchored render PROVES it is not a global sed: guard comparison literals survive
  assert.match(originInstalled, /\[\[ "\$NODE_BIN" == "__NODE_BIN__"/, 'guard literal must survive rendering (P1-3)');
  assert.match(tunnelInstalled, /\[\[ "\$TUNNEL_BIN" == "__TUNNEL_CLIENT_BIN__"/, 'guard literal must survive rendering (P1-3)');
  assert.equal(statSync(join(DST, 'cloud-mcp-origin-wrapper.sh')).mode & 0o777, 0o700, 'installed wrapper must be 0700');
  assert.ok(readFileSync(join(DST, 'cloud-mcp-watchdog.mjs'), 'utf8').length > 0, 'watchdog copied unchanged (no placeholders)');

  // negative: an UNRENDERED wrapper run as production entry refuses with 78
  const rawOrigin = spawnSync('bash', [join(DIR, 'cloud-mcp-origin-wrapper.sh')], { encoding: 'utf8' });
  assert.equal(rawOrigin.status, 78, 'unrendered origin production entry must exit 78');
  assert.match(rawOrigin.stderr, /unreplaced placeholder/);
  const rawTunnel = spawnSync('bash', [join(DIR, 'cloud-mcp-tunnel-wrapper.sh')], { encoding: 'utf8' });
  assert.equal(rawTunnel.status, 78, 'unrendered tunnel production entry must exit 78');
  assert.match(rawTunnel.stderr, /unreplaced placeholder/);

  // positive: the RENDERED artifact walks the production gates to the fake delegate.
  // fixture boundary (same precedent as v2.1.4 startup tests): only the host
  // constants ORIGIN_ENTRY/ORIGIN_CWD are stubbed; placeholder rendering itself
  // is the real install-block output.
  const envFile = join(DST, 'env.origin');
  writeFileSync(envFile, 'CAT_CAFE_REMOTE_TOKEN=opaque-A\nCAT_CAFE_AGENT_KEY_FILES=keys.test.jsonl\n');
  chmodSync(envFile, 0o600);
  writeFileSync(join(root, 'entry.js'), '');
  const originRun = join(root, 'origin-prod.sh');
  writeFileSync(originRun, originInstalled
    .replace(/^ORIGIN_ENTRY=".*"$/m, `ORIGIN_ENTRY="${join(root, 'entry.js')}"`)
    .replace(/^ORIGIN_CWD=".*"$/m, `ORIGIN_CWD="${root}"`));
  chmodSync(originRun, 0o700);
  const nodeRan = join(root, 'node-ran');
  const stOrigin = spawnSync('bash', [originRun], { encoding: 'utf8', env: { ...process.env, PATH: '/usr/bin:/bin', CLOUD_MCP_FAKE_NODE_RAN: nodeRan } });
  assert.equal(stOrigin.status, 0, `rendered origin must reach exec: ${stOrigin.stderr}`);
  assert.ok(existsSync(nodeRan), 'fake node delegate must actually run');

  // tunnel: stub the host constants (profile dir/cwd/proxy endpoint), keep the rendered assignments as-is
  const server = net.createServer((s) => s.destroy());
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const prescreenPort = String(server.address().port);
  const profDir = join(root, 'profiles'); mkdirSync(profDir);
  const tunnelRun = join(root, 'tunnel-prod.sh');
  writeFileSync(tunnelRun, tunnelInstalled
    .replace(/^PROFILE_DIR=".*"$/m, `PROFILE_DIR="${profDir}"`)
    .replace(/^TUNNEL_CWD=".*"$/m, `TUNNEL_CWD="${root}"`)
    .replace(/^PROXY_PORT=.*$/m, `PROXY_PORT=${prescreenPort}`));
  chmodSync(tunnelRun, 0o700);
  assert.ok(readFileSync(tunnelRun, 'utf8').includes(`PROXY_PORT=${prescreenPort}`), 'fixture must redirect the TCP prescreen off the real 7897');
  const argvFile = join(root, 'tunnel-argv');
  const stTunnel = spawnSync('bash', [tunnelRun], { encoding: 'utf8', env: { ...process.env, PATH: '/usr/bin:/bin', TUNNEL_STUB_ARGV_FILE: argvFile } });
  assert.equal(stTunnel.status, 0, `rendered tunnel must reach exec: ${stTunnel.stderr}`);
  const argv = readFileSync(argvFile, 'utf8').split('\n').filter(Boolean);
  assert.deepEqual(argv, ['run', '--profile-dir', profDir, '--profile', 'cat-cafe-gpt-pro'], 'delegate must receive the canonical foreground invocation, no token material');
  server.close();

  // static: the render chain + login-reload + origin-leg wording must exist in the runbook
  assert.equal((body.match(/render_wrapper/g) || []).length, 3, 'Install block: definition + two render calls');
  assert.match(runbook, /sed metacharacters/, 'sed-metacharacter fail-fast must exist');
  assert.match(runbook, /placeholder assignment left in installed wrapper/, 'anchored post-render scan must exist');
  // v2.1.8 P1-4b/P1-4c statics: resolution guard, all-or-nothing publish, override name
  assert.ok(runbook.includes('install -m 644 "$DST/LaunchAgents/com.cat-cafe.cloud-mcp-origin.plist" "$LAUNCH_AGENTS_DIR/com.cat-cafe.cloud-mcp-origin.plist"'), 'install must publish login-reload copies via $LAUNCH_AGENTS_DIR');
  assert.ok(runbook.includes('if ! { install -m 644') && runbook.includes('; }; then'), 'publish must be ONE gated &&-chain after the whole render loop (no per-label early publish)');
  assert.equal((runbook.match(/bootstrap "gui\/\$\(id -u\)" "\$LAUNCH_AGENTS_DIR\/\$L\.plist"/g) || []).length, 3, 'all three bootstraps load from the resolved login dir');
  assert.match(runbook, /echo "login reload dir: \$LAUNCH_AGENTS_DIR"/, 'resolved publish target must be echoed');
  assert.equal((runbook.match(/not the real user home/g) || []).length, 3, 'install, stop AND uninstall must all fail closed on a wrong HOME (v2.1.10)');
  assert.equal((body.match(/LAUNCH_AGENTS_DIR_OVERRIDE/g) || []).length, 4, 'install block: guard + CONFIRM-refusal + assignment + warning');
  assert.equal((body.match(/CONFIRM_LAUNCH_AGENTS_OVERRIDE/g) || []).length, 3, 'install block: double gate (v2.1.10 checkpoint #1)');
  assert.match(runbook, /LAUNCH_AGENTS_DIR_OVERRIDE in effect/, 'override must announce itself loudly (v2.1.9: never a silent bypass)');
  assert.match(runbook, /is not this run's validated render/, 'pre-publish byte-comparison gate must exist (v2.1.9 risk #2)');
  assert.match(runbook, /Mid-chain publish failure recovery/, 'operator partial-leftover recovery procedure must be written, not implied (v2.1.10 checkpoint #2)');
  assert.ok(body.indexOf('LAUNCH_AGENTS_DIR="$LAUNCH_AGENTS_DIR_OVERRIDE"') < body.indexOf('mkdir -p "$DST/logs'), 'v2.1.9 ordering: resolver precedes EVERY filesystem side effect');
  assert.ok(body.indexOf('mkdir -p "$LAUNCH_AGENTS_DIR"') > body.indexOf('plutil -lint'), 'v2.1.9 ordering: login dir is created only at publish time, after all lint passed');
  assert.match(runbook, /nl=\$'\\n'; cr=\$'\\r'/, 'control-char refuse class must be defined (risk #3)');
  assert.match(runbook, /sed metacharacters or control chars/, 'path refuse message must name control chars');
  assert.match(runbook, /Origin leg switchover/, 'origin legacy-listener switchover section must exist');
  assert.match(runbook, /iTCP:3098 -sTCP:LISTEN/, 'origin leg must identify the listener port first');
  assert.ok(runbook.includes('rm -f "$LAUNCH_AGENTS_DIR/com.cat-cafe.cloud-mcp-origin.plist"'), 'uninstall must remove login copies by exact name via $LAUNCH_AGENTS_DIR');
  assert.doesNotMatch(runbook, /ever copied or symlinked into/, 'the wrong persistence ban must not survive');
  // template prose must never spell the generic token word (P1-1 root cause)
  const originTpl = readFileSync(join(DIR, 'com.cat-cafe.cloud-mcp-origin.plist.template'), 'utf8');
  assert.ok(!originTpl.includes('__PLACEHOLDER__'), 'P1-1: template prose must not carry a generic token word');
});

test('v2.1.8 P1-4b/P1-4c (runs the REAL runbook blocks): wrong-HOME shells refuse install AND uninstall with zero side effects; a mid-loop template failure publishes NOTHING to the login dir', () => {
  const runbook = read('INSTALL-cloud-mcp.md');
  const instStart = runbook.indexOf('## Install (operator, host shell)');
  const instOpen = runbook.indexOf('```bash', instStart) + 7;
  const installBody = runbook.slice(instOpen, runbook.indexOf('```', instOpen));
  const unStart = runbook.indexOf('Uninstall files');
  const unOpen = runbook.indexOf('```bash', unStart) + 7;
  const uninstallBody = runbook.slice(unOpen, runbook.indexOf('```', unOpen));

  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cloud-mcp-v218-')));
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const nodeStub = join(bin, 'node');
  writeFileSync(nodeStub, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo v99-fake; exit 0; fi\nexit 0\n');
  chmodSync(nodeStub, 0o755);
  const tunnelStub = join(root, 'tunnel-client-stub');
  writeFileSync(tunnelStub, '#!/bin/sh\nexit 0\n');
  chmodSync(tunnelStub, 0o755);

  // a) gpt-pro risk #1 + v2.1.9 ordering: install from any wrong-HOME shell —
  //    the wrappers' SERVICE-RUNTIME home, a sudo /var/root shell, or another
  //    user's home — must FAIL CLOSED before the FIRST filesystem write: no DST,
  //    no marker, no renders, no wrapper, no publish.
  {
    const code0 = installBody.replace('DST=/Users/yuhan/.cat-cafe/cloud-mcp', 'DST=__DST__');
    for (const [name, badHome] of [['isolated', join(root, 'iso-home-a')], ['sudo/root', '/var/root'], ['other-user', '/Users/somebody-else']]) {
      const DST = join(root, `a-dst-${name}`);
      const code = code0.replace('__DST__', DST).replace('SRC=/path/to/this/scripts/launchd', `SRC=${DIR}`);
      const r = spawnSync('bash', ['-c', code], {
        encoding: 'utf8',
        env: { PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: badHome, TMPDIR: root, TUNNEL_BIN_OVERRIDE: tunnelStub },
      });
      assert.equal(r.status, 1, `${name} HOME must refuse install: ${r.stdout}\n${r.stderr}`);
      assert.match(r.stdout + r.stderr, /not the real user home/);
      assert.ok(!existsSync(DST), `v2.1.9 ordering: ${name} refusal must precede EVERY filesystem write (DST not even created)`);
    }
  }
  // b) the same guard on the uninstall side: wrong HOME refuses BEFORE the scan,
  //    deleting nothing (a missed login-copy removal would keep autostart alive).
  {
    const DST = join(root, 'b-dst');
    mkdirSync(join(DST, 'LaunchAgents'), { recursive: true });
    writeFileSync(join(DST, '.cloud-mcp-root'), 'cloud-mcp launchd set root — see INSTALL-cloud-mcp.md\n');
    for (const L of ['origin', 'tunnel', 'watchdog']) writeFileSync(join(DST, 'LaunchAgents', `com.cat-cafe.cloud-mcp-${L}.plist`), '<plist/>\n');
    const isoHome = join(root, 'iso-home-b');
    mkdirSync(isoHome, { recursive: true });
    const code = uninstallBody.replace('DST=/Users/yuhan/.cat-cafe/cloud-mcp', `DST=${DST}`);
    const r = spawnSync('bash', ['-c', code], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', HOME: isoHome, TMPDIR: root },
    });
    assert.equal(r.status, 1, `isolated HOME must refuse uninstall: ${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout + r.stderr, /not the real user home/);
    assert.ok(existsSync(join(DST, 'LaunchAgents', 'com.cat-cafe.cloud-mcp-origin.plist')), 'refused uninstall deletes nothing');
  }
  // c) gpt-pro risk #2: break the SECOND template after its guards (empty
  //    argument string, which passes the `__` residue scan) — the whole batch
  //    must abort BEFORE the publish chain: the login dir stays empty, proving
  //    no partial publish even though the first label rendered fine.
  {
    const SRC2 = join(root, 'src2');
    mkdirSync(SRC2, { recursive: true });
    const files = [
      'com.cat-cafe.cloud-mcp-origin.plist.template',
      'com.cat-cafe.cloud-mcp-tunnel.plist.template',
      'com.cat-cafe.cloud-mcp-watchdog.plist.template',
      'cloud-mcp-origin-wrapper.sh',
      'cloud-mcp-tunnel-wrapper.sh',
      'cloud-mcp-watchdog.mjs',
    ];
    for (const f of files) copyFileSync(join(DIR, f), join(SRC2, f));
    const tun = join(SRC2, 'com.cat-cafe.cloud-mcp-tunnel.plist.template');
    writeFileSync(tun, readFileSync(tun, 'utf8').replace('</dict>', '  <string></string>\n</dict>'));
    const DST = join(root, 'c-dst');
    const login = join(root, 'c-login');
    const isoHome = join(root, 'iso-home-c');
    mkdirSync(isoHome, { recursive: true });
    const code = installBody
      .replace('SRC=/path/to/this/scripts/launchd', `SRC=${SRC2}`)
      .replace('DST=/Users/yuhan/.cat-cafe/cloud-mcp', `DST=${DST}`);
    const r = spawnSync('bash', ['-c', code], {
      encoding: 'utf8',
      env: { PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: isoHome, TMPDIR: root, TUNNEL_BIN_OVERRIDE: tunnelStub, LAUNCH_AGENTS_DIR_OVERRIDE: login, CONFIRM_LAUNCH_AGENTS_OVERRIDE: 'yes' },
    });
    assert.equal(r.status, 1, `broken second template must refuse: ${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout + r.stderr, /empty argument string in com.cat-cafe\.cloud-mcp-tunnel/);
    assert.ok(existsSync(join(DST, 'LaunchAgents', 'com.cat-cafe.cloud-mcp-origin.plist')), 'the first label\'s STAGED build record may exist');
    assert.ok(!existsSync(login), 'v2.1.9: the login dir is not even CREATED when the batch refuses — no partial publish, no stray dir');
    assert.ok(!existsSync(join(DST, 'LaunchAgents', 'com.cat-cafe.cloud-mcp-watchdog.plist')), 'labels after the failure were never rendered');
  }
});

test('v2.1.9 P1-4c recovery (runs the REAL runbook Install block): foreign login copies refuse untouched; an injected mid-chain publish failure is healed by re-run without clobbering anything', () => {
  const runbook = read('INSTALL-cloud-mcp.md');
  const start = runbook.indexOf('## Install (operator, host shell)');
  const fenceOpen = runbook.indexOf('```bash', start) + 7;
  const body = runbook.slice(fenceOpen, runbook.indexOf('```', fenceOpen));
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cloud-mcp-v219-')));
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const nodeStub = join(bin, 'node');
  writeFileSync(nodeStub, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo v99-fake; exit 0; fi\nexit 0\n');
  chmodSync(nodeStub, 0o755);
  const tunnelStub = join(root, 'tunnel-client-stub');
  writeFileSync(tunnelStub, '#!/bin/sh\nexit 0\n');
  chmodSync(tunnelStub, 0o755);
  const DST = join(root, 'dst');
  const LOGIN = join(root, 'login');
  const code = body
    .replace('SRC=/path/to/this/scripts/launchd', `SRC=${DIR}`)
    .replace('DST=/Users/yuhan/.cat-cafe/cloud-mcp', `DST=${DST}`);
  const runInstall = (extraPath, extraEnv) => spawnSync('bash', ['-c', code], {
    encoding: 'utf8',
    env: {
      PATH: [...(extraPath ? [extraPath] : []), bin, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
      HOME: join(root, 'iso-home'), // wrong on purpose — only the override may pass
      TMPDIR: root,
      TUNNEL_BIN_OVERRIDE: tunnelStub,
      LAUNCH_AGENTS_DIR_OVERRIDE: LOGIN,
      CONFIRM_LAUNCH_AGENTS_OVERRIDE: 'yes',
      ...extraEnv,
    },
  });
  const names = ['com.cat-cafe.cloud-mcp-origin.plist', 'com.cat-cafe.cloud-mcp-tunnel.plist', 'com.cat-cafe.cloud-mcp-watchdog.plist'];

  // s1: clean install publishes all three, byte-equal to the staged renders
  {
    const r = runInstall();
    assert.equal(r.status, 0, `baseline install must succeed: ${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /LAUNCH_AGENTS_DIR_OVERRIDE in effect/, 'override must announce itself');
    for (const n of names) {
      assert.ok(existsSync(join(LOGIN, n)), `${n}: published`);
      assert.ok(readFileSync(join(LOGIN, n), 'utf8') === readFileSync(join(DST, 'LaunchAgents', n), 'utf8'), `${n}: login copy must equal staged render`);
    }
  }
  // s2: a FOREIGN (different-content) login copy is refused UNTOUCHED — the
  //     byte-comparison never overwrites what it cannot prove is its own
  {
    const foreign = join(LOGIN, 'com.cat-cafe.cloud-mcp-tunnel.plist');
    const foreignContent = '<plist>\n<string>someone elses job</string>\n</plist>\n';
    writeFileSync(foreign, foreignContent);
    const r = runInstall();
    assert.equal(r.status, 1, `foreign copy must block publish: ${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout + r.stderr, /is not this run's validated render/);
    assert.equal(readFileSync(foreign, 'utf8'), foreignContent, 'the foreign file must survive byte-identical — refusal never writes');
    assert.match(readFileSync(join(LOGIN, 'com.cat-cafe.cloud-mcp-origin.plist'), 'utf8'), /<\?xml/, 'untouched labels keep their (validated) bytes');
  }
  // s3: INJECTED mid-chain publish failure with a PARTIAL leftover — a PATH shim
  //     passes the first publish, then on the second writes truncated bytes to
  //     the target and fails (mimicking `install` killed mid-write). The chain
  //     must stop (third never attempted: shim saw exactly 2 login-dir calls),
  //     exit 1 + "publish failed", and the partial must NOT masquerade as done.
  {
    rmSync(join(LOGIN, 'com.cat-cafe.cloud-mcp-tunnel.plist')); // remove the foreign file (operator "inspect and remove")
    const shim = join(root, 'shim');
    mkdirSync(shim, { recursive: true });
    const countFile = join(root, 'shim-count');
    writeFileSync(join(shim, 'install'),
      '#!/bin/sh\ncase "$*" in\n  *"$SHIM_LOGIN"*)\n    c=0; [ -f "$SHIM_COUNT" ] && c="$(cat "$SHIM_COUNT")"\n    c=$((c+1)); printf \'%s\\n\' "$c" > "$SHIM_COUNT"\n    if [ "$c" = "2" ]; then\n      for last; do :; done\n      printf \'truncated-partial\' > "$last"\n      echo "shim: simulated mid-write failure" >&2\n      exit 1\n    fi\n    ;;\nesac\nexec /usr/bin/install "$@"\n');
    chmodSync(join(shim, 'install'), 0o755);
    const r = runInstall(shim, { SHIM_LOGIN: LOGIN, SHIM_COUNT: countFile });
    assert.equal(r.status, 1, `mid-chain failure must exit 1: ${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /publish failed — see message above/);
    assert.match(r.stderr + r.stdout, /shim: simulated mid-write failure/);
    assert.equal(readFileSync(countFile, 'utf8').trim(), '2', 'the chain stopped — the third publish was never attempted (shim saw exactly 2 login-dir calls)');
    assert.ok(readFileSync(join(LOGIN, names[0]), 'utf8') === readFileSync(join(DST, 'LaunchAgents', names[0]), 'utf8'), 'the landed first copy equals the validated render');
    assert.equal(readFileSync(join(LOGIN, names[1]), 'utf8'), 'truncated-partial', 'the partial leftover is left EXACTLY as the failed write left it — the failure pass never cleans or fixes it silently');
  }
  // s3b: RE-RUN must refuse the partial (byte comparison sees mismatch), touching
  //      nothing — auto-heal is limited to missing-or-identical by design
  {
    const r = runInstall();
    assert.equal(r.status, 1, `partial leftover must block re-run: ${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout + r.stderr, new RegExp(`refusing: login copy .*/${names[1].replace('.', '\\.')} exists and is not this run's validated render`));
    assert.equal(readFileSync(join(LOGIN, names[1]), 'utf8'), 'truncated-partial', 'refusal never overwrites the partial');
  }
  // s3c: documented operator recovery — inspect the NAMED path, remove the
  //      leftover explicitly, re-run heals the now-missing copy alongside the
  //      identical survivors
  {
    rmSync(join(LOGIN, names[1]));
    const r = runInstall();
    assert.equal(r.status, 0, `re-run after explicit removal must heal: ${r.stdout}\n${r.stderr}`);
    for (const n of names) {
      assert.ok(existsSync(join(LOGIN, n)), `${n}: present after heal`);
      assert.ok(readFileSync(join(LOGIN, n), 'utf8') === readFileSync(join(DST, 'LaunchAgents', n), 'utf8'), `${n}: equals validated render after heal`);
    }
  }
  // s5: a SYMLINKED login target refuses outright (never followed, never replaced)
  {
    const victim = join(root, 'victim.plist');
    writeFileSync(victim, 'do not touch me\n');
    const link = join(LOGIN, 'com.cat-cafe.cloud-mcp-watchdog.plist');
    rmSync(link);
    symlinkSync(victim, link);
    const r = runInstall();
    assert.equal(r.status, 1, `symlinked login copy must refuse: ${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout + r.stderr, /is a symlink/);
    assert.ok(lstatSync(link).isSymbolicLink(), 'the symlink is left exactly as found');
    assert.equal(readFileSync(victim, 'utf8'), 'do not touch me\n', 'the link target is never opened for write');
  }
});

test('v2.1.10 double-gate + stop ordering (runs the REAL runbook blocks): override without CONFIRM refuses everywhere with zero side effects; stop-guard precedes ANY launchctl call', () => {
  const runbook = read('INSTALL-cloud-mcp.md');
  const instStart = runbook.indexOf('## Install (operator, host shell)');
  const instOpen = runbook.indexOf('```bash', instStart) + 7;
  const installBody = runbook.slice(instOpen, runbook.indexOf('```', instOpen));
  const stopStart = runbook.indexOf('## Stop / disable / uninstall');
  const stopOpen = runbook.indexOf('```bash', stopStart) + 7;
  const stopBody = runbook.slice(stopOpen, runbook.indexOf('```', stopOpen));
  const unStart = runbook.indexOf('Uninstall files');
  const unOpen = runbook.indexOf('```bash', unStart) + 7;
  const uninstallBody = runbook.slice(unOpen, runbook.indexOf('```', unOpen));

  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cloud-mcp-v2110-')));
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const nodeStub = join(bin, 'node');
  writeFileSync(nodeStub, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo v99-fake; exit 0; fi\nexit 0\n');
  chmodSync(nodeStub, 0o755);
  const tunnelStub = join(root, 'tunnel-client-stub');
  writeFileSync(tunnelStub, '#!/bin/sh\nexit 0\n');
  chmodSync(tunnelStub, 0o755);
  // fake launchctl: records every call so we can PROVE the stop guard precedes it
  const ctlLog = join(root, 'launchctl-calls');
  const shims = join(root, 'shims');
  mkdirSync(shims, { recursive: true });
  writeFileSync(join(shims, 'launchctl'), '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$CTL_LOG"\nexit 0\n');
  chmodSync(join(shims, 'launchctl'), 0o755);
  const isoHome = join(root, 'iso-home');
  mkdirSync(isoHome, { recursive: true });
  const baseEnv = (extra) => ({ PATH: `${shims}:${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: isoHome, TMPDIR: root, TUNNEL_BIN_OVERRIDE: tunnelStub, CTL_LOG: ctlLog, ...extra });

  // 1) install: override set WITHOUT confirm => refuse, DST never created
  {
    const DST = join(root, 'g1-dst');
    const code = installBody
      .replace('SRC=/path/to/this/scripts/launchd', `SRC=${DIR}`)
      .replace('DST=/Users/yuhan/.cat-cafe/cloud-mcp', `DST=${DST}`);
    const r = spawnSync('bash', ['-c', code], { encoding: 'utf8', env: baseEnv({ LAUNCH_AGENTS_DIR_OVERRIDE: join(root, 'g1-login') }) });
    assert.equal(r.status, 1, `unconfirmed override must refuse: ${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout + r.stderr, /without CONFIRM_LAUNCH_AGENTS_OVERRIDE=yes/);
    assert.ok(!existsSync(DST), 'refusal precedes EVERY filesystem side effect');
  }
  // 2) uninstall: override WITHOUT confirm => refuse BEFORE the scan, delete nothing
  {
    const DST = join(root, 'g2-dst');
    mkdirSync(join(DST, 'LaunchAgents'), { recursive: true });
    writeFileSync(join(DST, '.cloud-mcp-root'), 'cloud-mcp launchd set root — see INSTALL-cloud-mcp.md\n');
    for (const L of ['origin', 'tunnel', 'watchdog']) writeFileSync(join(DST, 'LaunchAgents', `com.cat-cafe.cloud-mcp-${L}.plist`), '<plist/>\n');
    const code = uninstallBody.replace('DST=/Users/yuhan/.cat-cafe/cloud-mcp', `DST=${DST}`);
    const r = spawnSync('bash', ['-c', code], { encoding: 'utf8', env: baseEnv({ LAUNCH_AGENTS_DIR_OVERRIDE: join(root, 'g2-login') }) });
    assert.equal(r.status, 1, `unconfirmed override must refuse uninstall: ${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout + r.stderr, /without CONFIRM_LAUNCH_AGENTS_OVERRIDE=yes/);
    assert.ok(existsSync(join(DST, 'LaunchAgents', 'com.cat-cafe.cloud-mcp-origin.plist')), 'refused uninstall deletes nothing');
  }
  // 3) stop block: wrong HOME (no override) => refuse before ANY launchctl call
  {
    rmSync(ctlLog, { force: true });
    const r = spawnSync('bash', ['-c', stopBody], { encoding: 'utf8', env: baseEnv() });
    assert.equal(r.status, 1, `wrong HOME must refuse stop: ${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout + r.stderr, /refusing before ANY launchctl side effect/);
    assert.ok(!existsSync(ctlLog), 'not one launchctl call may reach the (fake) binary');
  }
  // 4) stop block: override WITHOUT confirm => same zero-launchctl refusal
  {
    rmSync(ctlLog, { force: true });
    const r = spawnSync('bash', ['-c', stopBody], { encoding: 'utf8', env: baseEnv({ LAUNCH_AGENTS_DIR_OVERRIDE: join(root, 'g4-login') }) });
    assert.equal(r.status, 1, `unconfirmed override must refuse stop: ${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout + r.stderr, /without CONFIRM_LAUNCH_AGENTS_OVERRIDE=yes/);
    assert.ok(!existsSync(ctlLog), 'still zero launchctl calls');
  }
  // 5) stop block WITH override+confirm => proceeds (guard is a gate, not a ban):
  //    fake launchctl sees bootout+disable for all three labels
  {
    rmSync(ctlLog, { force: true });
    const r = spawnSync('bash', ['-c', stopBody], { encoding: 'utf8', env: baseEnv({ LAUNCH_AGENTS_DIR_OVERRIDE: join(root, 'g5-login'), CONFIRM_LAUNCH_AGENTS_OVERRIDE: 'yes' }) });
    assert.equal(r.status, 0, `confirmed escape must still allow stop: ${r.stdout}\n${r.stderr}`);
    const log = readFileSync(ctlLog, 'utf8');
    for (const L of ['origin', 'tunnel', 'watchdog']) {
      assert.match(log, new RegExp(`bootout gui/\\d+/com\\.cat-cafe\\.cloud-mcp-${L}`), `${L}: bootout reached`);
      assert.match(log, new RegExp(`disable gui/\\d+/com\\.cat-cafe\\.cloud-mcp-${L}`), `${L}: disable reached`);
    }
  }
  // statics: per-block double gate presence (install 3 / uninstall 2 / stop 2 CONFIRM mentions)
  assert.equal((installBody.match(/CONFIRM_LAUNCH_AGENTS_OVERRIDE/g) || []).length, 3, 'install block double gate');
  assert.equal((uninstallBody.match(/CONFIRM_LAUNCH_AGENTS_OVERRIDE/g) || []).length, 2, 'uninstall block double gate');
  assert.equal((stopBody.match(/CONFIRM_LAUNCH_AGENTS_OVERRIDE/g) || []).length, 2, 'stop block double gate');
  assert.ok(stopBody.indexOf('CONFIRM_LAUNCH_AGENTS_OVERRIDE') < stopBody.indexOf('launchctl bootout'), 'stop guard must PRECEDE the first launchctl statement');
});

test('v2.1.11 P2-1 rotation call boundary (REAL runWatchdogOnce + cfg field names): below-threshold files survive every round; over-threshold rotation shifts the retention generations and keeps the active inode', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'cloud-mcp-wd-rot-'));
  const logDir = mkdtempSync(join(tmpdir(), 'cloud-mcp-lg-rot-'));
  const cfg = { ...DEFAULTS, stateDir, logDir }; // REAL logMaxBytes/logKeep names — the v2.1.10 boundary rotated EVERYTHING
  writeFileSync(join(logDir, 'origin.out.log'), 'x'.repeat(10)); // 10 bytes vs the real 5 MiB threshold
  const { deps } = fakeWorld({ originHealthStatus: 200 });

  const r1 = await runWatchdogOnce(cfg, deps);
  assert.deepEqual(r1.rotated, [], 'nothing may rotate below threshold (v2.1.10 bug: size <= undefined is always false)');
  assert.ok(!existsSync(join(logDir, 'origin.out.log.1')), 'no .1 generation may appear');
  assert.equal(readFileSync(join(logDir, 'origin.out.log'), 'utf8').length, 10, 'below-threshold file must be untouched');
  assert.match(r1.line, /rotated=-/, 'status line reports no rotations');

  // over-threshold pass with a SMALL logMaxBytes: proves the cfg→{maxBytes,keep} mapping itself,
  // and that keep is really threaded into shiftRotated (v2.1.10 passed undefined: no shifting, .1 clobbered)
  const cfg2 = { ...cfg, logMaxBytes: 100, logKeep: 3 };
  writeFileSync(join(logDir, 'tunnel.out.log'), 'y'.repeat(101));
  writeFileSync(join(logDir, 'tunnel.out.log.1'), 'gen1');
  writeFileSync(join(logDir, 'tunnel.out.log.2'), 'gen2');
  writeFileSync(join(logDir, 'tunnel.out.log.3'), 'gen3');
  const r2 = await runWatchdogOnce({ ...cfg2 }, { ...deps, nowMs: deps.nowMs + 3_600_000 });
  // after two rounds the TSV itself crossed the 100-byte fixture threshold, so it
  // rotates too (rename mode, we hold no fd on it) — the assertion is per-file honest
  assert.equal(r2.rotated.length, 2, 'the over-threshold active log AND the grown TSV rotate');
  const rot = r2.rotated.find((x) => x.name === 'tunnel.out.log');
  assert.equal(rot.mode, 'copytruncate', 'launchd-owned active log must keep its inode');
  assert.equal(readFileSync(join(logDir, 'tunnel.out.log'), 'utf8'), '', 'active file truncated after copy');
  assert.equal(readFileSync(join(logDir, 'tunnel.out.log.1'), 'utf8'), 'y'.repeat(101), 'fresh .1 holds the rotated content');
  assert.equal(readFileSync(join(logDir, 'tunnel.out.log.2'), 'utf8'), 'gen1', 'old .1 SHIFTED to .2 — keep was threaded through');
  assert.equal(readFileSync(join(logDir, 'tunnel.out.log.3'), 'utf8'), 'gen2', 'old .2 shifted to .3');
  assert.ok(!existsSync(join(logDir, 'tunnel.out.log.4')), 'generations beyond keep are not created');
  const tsvRot = r2.rotated.find((x) => x.name === 'watchdog-status.tsv');
  assert.equal(tsvRot.mode, 'rename', 'the TSV we hold no fd on must rename, never copytruncate');
  assert.equal(readFileSync(join(logDir, 'origin.out.log'), 'utf8').length, 10, 'the below-threshold sibling still untouched in round 2');
});

test('v2.1.11 P2-2 tunnel wrapper env floor: exports precede exec; a rendered production entry overrides ambient debug/raw-unsafe so the delegate sees warn/false', async () => {
  const src = read('cloud-mcp-tunnel-wrapper.sh');
  const execSrc = code(src);
  assert.match(execSrc, /^export LOG_LEVEL=warn$/m, 'env floor must be executable, not prose');
  assert.match(execSrc, /^export LOG_HTTP_RAW_UNSAFE=false$/m, 'raw HTTP logging must be hard-pinned off');
  assert.ok(execSrc.indexOf('export LOG_LEVEL=warn') < execSrc.indexOf('exec "$TUNNEL_BIN"'), 'exports must precede exec');

  // behavioral: render with the SAME anchored semantics as the Install block's
  // render_wrapper (column-0 assignments only — indented guard literals provably
  // survive), then stub host constants exactly like the v2.1.7 production-entry
  // walk and run with a HOSTILE ambient env.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cloud-mcp-v2111-')));
  const tunnelStub = join(root, 'tunnel-client');
  writeFileSync(tunnelStub,
    '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$TUNNEL_STUB_ARGV_FILE"\nprintf \'LOG_LEVEL=%s\\nLOG_HTTP_RAW_UNSAFE=%s\\n\' "${LOG_LEVEL:-unset}" "${LOG_HTTP_RAW_UNSAFE:-unset}" > "$TUNNEL_STUB_ENV_FILE"\nexit 0\n');
  chmodSync(tunnelStub, 0o755);
  const server = net.createServer((s) => s.destroy());
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const prescreenPort = String(server.address().port);
  const profDir = join(root, 'profiles'); mkdirSync(profDir);
  const stateDir = join(root, 'state'); mkdirSync(stateDir);
  const runScript = join(root, 'tunnel-prod.sh');
  const rendered = src
    .replace(/^TUNNEL_BIN="__TUNNEL_CLIENT_BIN__"$/m, `TUNNEL_BIN="${tunnelStub}"`)
    .replace(/^STATE_DIR="__STATE_DIR__"$/m, `STATE_DIR="${stateDir}"`)
    .replace(/^PROFILE_DIR=".*"$/m, `PROFILE_DIR="${profDir}"`)
    .replace(/^TUNNEL_CWD=".*"$/m, `TUNNEL_CWD="${root}"`)
    .replace(/^PROXY_PORT=.*$/m, `PROXY_PORT=${prescreenPort}`);
  writeFileSync(runScript, rendered);
  chmodSync(runScript, 0o700);
  // anchored render proof: the guard comparison literals still reference the tokens
  assert.match(rendered, /\[\[ "\$TUNNEL_BIN" == "__TUNNEL_CLIENT_BIN__"/, 'guard literal must survive (anchored render semantics)');

  const argvFile = join(root, 'tunnel-argv');
  const envFile = join(root, 'tunnel-env');
  const st = spawnSync('bash', [runScript], {
    encoding: 'utf8',
    env: {
      PATH: '/usr/bin:/bin',
      HOME: join(root, 'iso-home'),
      TMPDIR: root,
      TUNNEL_STUB_ARGV_FILE: argvFile,
      TUNNEL_STUB_ENV_FILE: envFile,
      // hostile ambient: exactly what the floor must defeat
      LOG_LEVEL: 'debug',
      LOG_HTTP_RAW_UNSAFE: 'true',
    },
  });
  assert.equal(st.status, 0, `rendered tunnel entry must reach exec: ${st.stdout}\n${st.stderr}`);
  const seenEnv = readFileSync(envFile, 'utf8');
  assert.equal(seenEnv, 'LOG_LEVEL=warn\nLOG_HTTP_RAW_UNSAFE=false\n', 'delegate must receive the floor values, not the ambient ones');
  const argv = readFileSync(argvFile, 'utf8').split('\n').filter(Boolean);
  assert.deepEqual(argv, ['run', '--profile-dir', profDir, '--profile', 'cat-cafe-gpt-pro'], 'env floor changes NO argv — canonical invocation intact');
  server.close();

  // the raw template, run UNRENDERED with the same ambient, still exits 78 BEFORE
  // exec (the floor cannot weaken the placeholder guard)
  const raw = spawnSync('bash', [join(DIR, 'cloud-mcp-tunnel-wrapper.sh')], {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', HOME: root, LOG_LEVEL: 'debug', LOG_HTTP_RAW_UNSAFE: 'true' },
  });
  assert.equal(raw.status, 78, 'placeholder guard still refuses the unrendered template');
  assert.match(raw.stderr, /unreplaced placeholder/);
});
