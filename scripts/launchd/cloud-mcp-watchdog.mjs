#!/usr/bin/env node
// cloud-mcp-watchdog.mjs — periodic health watchdog for the F247 cloud MCP
// LaunchAgents (one-shot per invocation; NOT a KeepAlive daemon, so it cannot
// race launchd into double spawns).
//
// Responsibilities (single owner each):
//   - observe each launchd label via `/bin/launchctl print` (absolute path:
//     launchd gives a minimal PATH): unloaded / state=running / state=other
//   - origin leg additionally requires GET 127.0.0.1:3098 /health == 200
//   - tunnel leg: until a runtime status probe is configured (TODO host fact),
//     runtime health is 'unknown' — the watchdog must NEVER report tunnel
//     healthy and must never claim cloud 'ready' (verdict P1-2). A configured
//     probe file additionally must be fresh (mtime within
//     tunnelRuntimeProbeMaxAgeMs) or it counts as 'unknown'/probe-stale, never
//     healthy (v2.1 P2-3: a stale ready file must not impersonate health).
//     Tunnel job unloaded is a deterministic failure: cloud=not-ready
//     (v2.1 P1-1: loaded dimension feeds the machine-readable summary).
//   - HTTP CONNECT readiness gate with strict target validation and strict
//     status-line parsing; result feeds machine-readable cloud readiness
//     (ready | not-ready | unknown), never a silent side-channel (verdict P1-3).
//   - bounded remediation: `launchctl kickstart -k` ONLY for a loaded job whose
//     own probe deterministically failed >= N consecutive rounds, with a
//     per-label cooldown. Unloaded jobs need an operator bootstrap and are
//     reported as such (kickstart cannot fix them).
//   - log bounding: launchd-owned active logs use copytruncate (inode stays,
//     long-lived fds keep working); files this process closes (the TSV) use
//     rename-shift. No unbounded growth anywhere.
//   - status records: one TSV line + machine-readable watchdog-latest.json,
//     never containing secret values.
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  closeSync,
  statSync,
  truncateSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import net from 'node:net';

export const LAUNCHCTL_BIN = '/bin/launchctl';

// Non-credential env allowlist for the watchdog plist's EnvironmentVariables.
export const WATCHDOG_PLIST_ENV_ALLOW = ['PATH', 'HOME', 'LANG'];

export const DEFAULTS = {
  originHealthUrl: 'http://127.0.0.1:3098/health',
  labels: ['com.cat-cafe.cloud-mcp-origin', 'com.cat-cafe.cloud-mcp-tunnel'],
  failRoundsBeforeKickstart: 2,
  kickstartCooldownMs: 15 * 60_000,
  healthTimeoutMs: 4_000,
  logMaxBytes: 5 * 1024 * 1024,
  logKeep: 3,
  connectProxy: 'http://127.0.0.1:7897',
  connectTarget: null, // TODO(operator): "host:port" (explicit port required) to enable
  tunnelRuntimeProbePath: null, // TODO(host): tunnel-client runtime status file once verified
  tunnelRuntimeProbeMaxAgeMs: 120_000, // v2.1 P2-3: staleness bound IF an operator wires a probe
};

export function launchctlDomain(uid = process.getuid()) {
  return `gui/${uid}`;
}
export function launchctlTarget(label, uid = process.getuid()) {
  return `${launchctlDomain(uid)}/${label}`;
}

export function launchdJobState(stdout) {
  const m = /(?:^|\n)\s*state = (\S+)/.exec(stdout ?? '');
  return m ? m[1] : null;
}

export function probeLaunchd(label, uid, run = spawnSync) {
  const r = run(LAUNCHCTL_BIN, ['print', launchctlTarget(label, uid)], { encoding: 'utf8', timeout: 8_000 });
  if (r.status !== 0) return { loaded: false, state: null };
  return { loaded: true, state: launchdJobState(r.stdout) };
}

export async function probeHttpHealth(url, timeoutMs, fetchImpl = fetch) {
  try {
    const res = await Promise.race([
      fetchImpl(url, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('probe-timeout')), timeoutMs + 500).unref?.()),
    ]);
    return { ok: res.status === 200, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

// Strict "host:port" — explicit port mandatory (443 for TLS endpoints;
// guessing 80 would silently probe the wrong service). No userinfo, path,
// query, fragment, or control characters (CRLF injection guard).
export function validateConnectTarget(target) {
  if (typeof target !== 'string' || target.length === 0 || target.length > 253) {
    return { ok: false, code: 'invalid-target-empty' };
  }
  if (/[\x00-\x20\x7f/?#\\%@]/.test(target)) {
    return { ok: false, code: 'invalid-target-chars' };
  }
  const m = /^([a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*):(\d{1,5})$/.exec(target);
  if (!m) return { ok: false, code: 'invalid-target-format' };
  const port = Number(m[2]);
  if (port < 1 || port > 65535) return { ok: false, code: 'invalid-target-port' };
  return { ok: true, host: m[1], port };
}

// CONNECT probe with byte-level fidelity: request framing is real CRLF, the
// response status line is buffered until a full line exists and parsed
// strictly (HTTP/1.[01] SP code). Only classification codes are returned —
// raw proxy bytes never leave this function.
export function probeConnectReadiness(proxyUrl, target, timeoutMs = 5_000, connectImpl = net.connect) {
  if (!target) return Promise.resolve({ state: 'disabled', code: 'no-target-configured' });
  const v = validateConnectTarget(target);
  if (!v.ok) return Promise.resolve({ state: 'fail', code: v.code });
  let proxy;
  try {
    proxy = new URL(proxyUrl);
  } catch {
    return Promise.resolve({ state: 'fail', code: 'invalid-proxy-url' });
  }
  if (proxy.protocol !== 'http:' || proxy.username || proxy.password) {
    return Promise.resolve({ state: 'fail', code: 'invalid-proxy-url' });
  }
  return new Promise((resolve) => {
    let buf = '';
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      sock.destroy();
      resolve(r);
    };
    const sock = connectImpl(Number(proxy.port) || 80, proxy.hostname);
    const t = setTimeout(() => done({ state: 'fail', code: 'timeout' }), timeoutMs);
    t.unref?.();
    sock.once('error', (e) => done({ state: 'fail', code: `connect-${e?.code ?? 'error'}` }));
    sock.once('close', () => done({ state: 'fail', code: 'closed' }));
    sock.once('connect', () => {
      sock.write(`CONNECT ${v.host}:${v.port} HTTP/1.1\r\nHost: ${v.host}:${v.port}\r\n\r\n`);
    });
    sock.on('data', (chunk) => {
      buf += chunk.toString('latin1');
      const lineEnd = buf.indexOf('\r\n');
      if (lineEnd === -1) {
        if (buf.length > 1024) done({ state: 'fail', code: 'bad-status-line' });
        return;
      }
      const line = buf.slice(0, lineEnd);
      const m = /^HTTP\/1\.[01] (\d{3})(?:[ \t].*)?$/.exec(line);
      if (!m) {
        done({ state: 'fail', code: 'bad-status-line' });
        return;
      }
      done({ state: m[1] === '200' ? 'pass' : 'fail', code: `status-${m[1]}` });
    });
  });
}

// Tunnel runtime health is unknowable until the host fact lands. A configured
// probe file containing exactly "ready" counts as healthy ONLY while fresh:
// mtime in the past AND within maxAgeMs of now (v2.1.1 P2: a future mtime is
// probe-invalid-time, not freshness). Absent/unconfigured/stale/future =>
// 'unknown' (NOT healthy, NOT unhealthy).
export function probeTunnelRuntime(probePath, nowMs = Date.now(), maxAgeMs = DEFAULTS.tunnelRuntimeProbeMaxAgeMs) {
  if (!probePath) return { runtime: 'unknown', code: 'probe-not-configured' };
  try {
    const content = readFileSync(probePath, 'utf8').trim();
    if (content !== 'ready') return { runtime: 'unknown', code: 'probe-not-ready' };
    const ageMs = nowMs - statSync(probePath).mtimeMs;
    // future mtime (clock rollback / bogus timestamp / deliberate touch) is NOT
    // freshness — v2.1.1 P2: refuse to treat it as ready.
    if (ageMs < 0) return { runtime: 'unknown', code: 'probe-invalid-time' };
    if (ageMs > maxAgeMs) return { runtime: 'unknown', code: 'probe-stale' };
    return { runtime: 'healthy', code: 'probe-ready' };
  } catch {
    return { runtime: 'unknown', code: 'probe-unreadable' };
  }
}

export function shouldKickstart(state, nowMs, cfg = DEFAULTS) {
  // state: { fails, lastKickstartAt } — returns decision, mutates nothing.
  // Callers feed `fails` ONLY from deterministic unhealthy observations
  // (origin running-but-health-failing); 'unknown' never increments.
  if (state.fails < cfg.failRoundsBeforeKickstart) return { kick: false, reason: 'below-fail-threshold' };
  const last = state.lastKickstartAt ?? 0;
  if (nowMs - last < cfg.kickstartCooldownMs) {
    return { kick: false, reason: `cooldown (${Math.round((nowMs - last) / 1000)}s < ${cfg.kickstartCooldownMs / 1000}s)` };
  }
  return { kick: true, reason: `unhealthy x${state.fails}` };
}

function shiftRotated(p, keep) {
  for (let i = keep - 1; i >= 1; i--) {
    const src = `${p}.${i}`;
    if (existsSync(src)) renameSync(src, `${p}.${i + 1}`);
  }
}

// copytruncate for launchd-owned active logs: content is copied to .1 first,
// then the SAME inode is truncated to 0, so long-lived fds (launchd keeps the
// file open for the whole job lifetime) keep appending to the live file.
// Renaming an active log would strand writes on the rotated inode (verdict
// P2). Accepted trade-off: bytes written between copy and truncate are lost;
// bounded by one rotation window and disclosed in the runbook.
export function rotateLogs(logDir, { maxBytes, keep }, ownClosedFiles = ['watchdog-status.tsv']) {
  const rotated = [];
  if (!existsSync(logDir)) return rotated;
  for (const name of readdirSync(logDir)) {
    if (/\.\d+$/.test(name)) continue; // already-rotated siblings: shift-only
    const p = join(logDir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (!st.isFile() || st.size <= maxBytes) continue;
    shiftRotated(p, keep);
    if (ownClosedFiles.includes(name)) {
      renameSync(p, `${p}.1`); // we hold no fd on it (append-per-round)
      rotated.push({ name, mode: 'rename' });
    } else {
      copyFileSync(p, `${p}.1`);
      truncateSync(p, 0);
      rotated.push({ name, mode: 'copytruncate' });
    }
  }
  return rotated;
}

export function readState(stateDir, label) {
  const p = join(stateDir, `watchdog.${label}.json`);
  if (!existsSync(p)) return { state: { fails: 0, lastKickstartAt: 0 }, corrupt: false };
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    if (typeof parsed?.fails !== 'number' || typeof parsed?.lastKickstartAt !== 'number') {
      return { state: { fails: 0, lastKickstartAt: 0 }, corrupt: true };
    }
    return { state: parsed, corrupt: false };
  } catch {
    return { state: { fails: 0, lastKickstartAt: 0 }, corrupt: true };
  }
}

// Atomic: write to a same-dir temp, fsync, rename. A crash mid-write leaves
// either the old file or the new file, never a truncated one.
export function writeState(stateDir, label, state) {
  mkdirSync(stateDir, { recursive: true });
  const p = join(stateDir, `watchdog.${label}.json`);
  const tmp = `${p}.tmp-${process.pid}`;
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, JSON.stringify(state));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, p);
}

export function computeCloudReadiness({ originHealthy, tunnelLoaded, tunnelRuntime, connectState }) {
  // 'ready' requires ALL positive signals. Any deterministic failure — origin
  // failing health, a tunnel job not even loaded in launchd, an explicitly
  // unhealthy runtime probe, a failed CONNECT gate — => 'not-ready' (v2.1
  // P1-1: tunnel unloaded was previously masked as 'unknown'). Anything else
  // (missing runtime probe, disabled CONNECT) => 'unknown' — which must never
  // be quoted as cloud-ready.
  if (originHealthy === false || tunnelLoaded === false || tunnelRuntime === 'unhealthy' || connectState === 'fail') {
    return 'not-ready';
  }
  if (originHealthy === true && tunnelLoaded === true && tunnelRuntime === 'healthy' && connectState === 'pass') {
    return 'ready';
  }
  return 'unknown';
}

export async function runWatchdogOnce(cfg = DEFAULTS, deps = {}) {
  const uid = deps.uid ?? process.getuid();
  const run = deps.run ?? spawnSync;
  const nowMs = deps.nowMs ?? Date.now();
  const log = deps.log ?? (() => {});
  const results = [];
  let originHealthy = null;
  let tunnelRuntime = 'unknown';
  let tunnelLoaded = null; // v2.1 P1-1: job presence is a distinct signal from runtime health

  for (const label of cfg.labels) {
    const obs = probeLaunchd(label, uid, run);
    if (label.endsWith('-tunnel')) tunnelLoaded = obs.loaded;
    const stRead = readState(cfg.stateDir, label);
    let st = stRead.state;
    const entry = { label, kind: 'launchd', loaded: obs.loaded, state: obs.state, corrupt: stRead.corrupt };

    if (!obs.loaded) {
      // Not a kickstart case: the job isn't in launchd at all. Operator action
      // (bootstrap) is the only fix; count as fail for alerting only.
      st.fails = st.fails + 1;
      entry.verdict = 'unloaded-needs-operator';
      if (label.endsWith('-origin')) originHealthy = false;
    } else if (obs.state !== 'running') {
      // loaded but not running: KeepAlive/throttle is already handling an
      // exited process — kickstarting would just fight it. Observe, don't act.
      entry.verdict = 'launchd-restarting';
      if (label.endsWith('-origin')) originHealthy = false;
    } else {
      let unhealthy = false;
      if (label.endsWith('-origin')) {
        const h = await probeHttpHealth(cfg.originHealthUrl, cfg.healthTimeoutMs, deps.fetch);
        originHealthy = h.ok;
        results.push({ label, kind: 'health', ok: h.ok, status: h.status });
        unhealthy = !h.ok;
      } else if (label.endsWith('-tunnel')) {
        const rt = probeTunnelRuntime(cfg.tunnelRuntimeProbePath, nowMs, cfg.tunnelRuntimeProbeMaxAgeMs);
        tunnelRuntime = rt.runtime;
        entry.runtime = rt.runtime;
        entry.runtimeCode = rt.code;
        unhealthy = false; // 'unknown' must not drive remediation (P1-2)
      }
      if (unhealthy) st.fails = st.fails + 1;
      else st.fails = 0;
      entry.verdict = unhealthy ? 'running-unhealthy' : 'running';
    }

    const decision = entry.verdict === 'running-unhealthy'
      ? shouldKickstart(st, nowMs, cfg)
      : { kick: false, reason: entry.verdict };
    if (decision.kick && !deps.dryRun) {
      const k = run(LAUNCHCTL_BIN, ['kickstart', '-k', launchctlTarget(label, uid)], { encoding: 'utf8', timeout: 15_000 });
      if (k.status === 0) st.lastKickstartAt = nowMs;
      entry.kickRc = k.status;
      log(`kickstart ${label} rc=${k.status}`);
    } else if (decision.kick && deps.dryRun) {
      log(`dry-run kickstart ${label}`);
    }
    writeState(cfg.stateDir, label, st);
    entry.fails = st.fails;
    entry.kickstart = decision.kick;
    entry.why = decision.reason;
    results.push(entry);
  }

  const connect = await probeConnectReadiness(cfg.connectProxy, cfg.connectTarget, cfg.healthTimeoutMs);
  results.push({ label: 'proxy', kind: 'connect', state: connect.state, code: connect.code });
  const originEntry = results.find((r) => r.kind === 'health' && r.label.endsWith('-origin'));
  const originOk = originEntry ? originEntry.ok : originHealthy;
  const cloud = computeCloudReadiness({
    originHealthy: originOk,
    tunnelLoaded,
    tunnelRuntime,
    connectState: connect.state,
  });
  // v2.1.11 P2-1 (host-acceptance finding by 砚砚61): rotateLogs consumes
  // {maxBytes, keep} but the config fields are logMaxBytes/logKeep — passing
  // cfg straight made `size <= undefined` always false (EVERY file rotated
  // every round, even 10-byte ones) and shiftRotated(keep=undefined) never
  // shifted generations. Map explicitly; the call boundary is now covered by
  // a runWatchdogOnce-level behavioral test.
  const rotated = rotateLogs(cfg.logDir, { maxBytes: cfg.logMaxBytes, keep: cfg.logKeep });

  // Status records: coordinates and codes only, never values of any env/secret.
  const line = `${new Date(nowMs).toISOString()}\tcloud=${cloud}\t` +
    results
      .map((r) => {
        const short = r.label.replace('com.cat-cafe.cloud-mcp-', '');
        if (r.kind === 'launchd') return `${short}.launchd=${r.verdict}${r.runtime ? `/${r.runtime}` : ''}:f${r.fails}${r.kickstart ? '+kick' : ''}`;
        if (r.kind === 'health') return `${short}.health=${r.ok}`;
        return `${short}.${r.kind}=${r.state}/${r.code}`;
      })
      .join(' ') +
    `\trotated=${rotated.map((x) => `${x.name}:${x.mode}`).join(',') || '-'}`;
  if (cfg.stateDir) {
    writeState(cfg.stateDir, 'latest', { nowMs, cloud, results, rotated });
  }
  // TSV lives in logDir so rotateLogs bounds it (rename mode: we hold no fd).
  if (cfg.logDir) {
    appendFileSync(join(cfg.logDir, 'watchdog-status.tsv'), `${line}\n`);
  }
  return { line, cloud, results, rotated };
}

// CLI entry (ignored when imported by tests)
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const arg = (name, dflt) => {
    const i = process.argv.indexOf(name);
    return i > -1 ? process.argv[i + 1] : dflt;
  };
  const stateDir = arg('--state-dir', null);
  const logDir = arg('--log-dir', null);
  if (!stateDir || !logDir || /__/.test(stateDir + logDir)) {
    console.error('watchdog: unreplaced placeholder or missing --state-dir/--log-dir');
    process.exit(78);
  }
  const cfg = {
    ...DEFAULTS,
    stateDir,
    logDir,
    connectTarget: arg('--connect-target', DEFAULTS.connectTarget),
    tunnelRuntimeProbePath: arg('--tunnel-runtime-probe', DEFAULTS.tunnelRuntimeProbePath),
  };
  const { line } = await runWatchdogOnce(cfg);
  console.log(line);
}
