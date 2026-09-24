import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createAgentGitHubReader } from '../dist/infrastructure/github/agent-github-read.js';

const repo = '08mamba24/clowder-ai';
const head = 'a'.repeat(40);
const pr = {
  number: 41,
  title: 'Query safely',
  body: 'Description',
  state: 'OPEN',
  headRefOid: head,
  baseRefOid: 'c'.repeat(40),
  url: `https://github.com/${repo}/pull/41`,
  isDraft: false,
  updatedAt: '2026-09-21T00:00:00Z',
};
const issue = {
  number: 2,
  title: 'Issue',
  body: 'Details',
  state: 'OPEN',
  url: `https://github.com/${repo}/issues/2`,
  updatedAt: '2026-09-21T00:00:00Z',
};
const run = {
  databaseId: 123,
  displayTitle: 'Build',
  status: 'completed',
  conclusion: 'success',
  headSha: head,
  url: `https://github.com/${repo}/actions/runs/123`,
  workflowName: 'CI',
};
const check = { name: 'test', state: 'SUCCESS', bucket: 'pass', workflow: 'CI', link: run.url };
function harness(overrides = {}) {
  const calls = [];
  const revoke = new AbortController();
  const authority = { repositories: [repo, 'zts212653/clowder-ai'], signal: revoke.signal };
  const reader = createAgentGitHubReader({
    ghPath: '/host/guarded-bin/gh',
    cwd: '/host/query',
    baseEnv: { HOME: '/host/home', PATH: '/host/bin', GH_TOKEN: 'ambient-secret', GH_FORCE_TTY: '1' },
    runner: async (file, args, options) => {
      calls.push({ file, args, options });
      if (args[0] === 'repo') return { stdout: JSON.stringify({ hasIssuesEnabled: true }), exitCode: 0 };
      if (args[0] === 'pr' && args[1] === 'diff') return { stdout: 'diff --git a/a b/a\n+ok\n', exitCode: 0 };
      const value = args[0] === 'issue' ? issue : args[0] === 'run' ? run : pr;
      const data = args[1] === 'checks' ? [check] : args[1] === 'list' ? [value] : value;
      return { stdout: JSON.stringify(data), exitCode: 0 };
    },
    ...overrides,
  });
  return { reader, calls, authority, revoke };
}
describe('host GitHub read boundary', () => {
  it('rejects unsupported shapes and injection before the runner', async () => {
    const h = harness();
    for (const query of [
      null,
      [],
      {},
      { op: 'api', repo, endpoint: '/user' },
      { op: 'pr_view', repo, number: 0 },
      { op: 'pr_view', repo, number: 1.1 },
      { op: 'pr_view', repo, number: Number.MAX_SAFE_INTEGER + 1 },
      { op: 'pr_view', repo, number: '41' },
      { op: 'pr_view', repo, number: 41, env: {} },
      { op: 'pr_view', repo, number: 41, catId: 'astra' },
      { op: 'pr_view', repo: `${repo};id`, number: 41 },
      { op: 'pr_view', repo: `https://github.com/${repo}`, number: 41 },
      { op: 'pr_view', repo: '08mamba24/../clowder-ai', number: 41 },
      { op: 'run_list', repo, limit: 51 },
      { op: 'run_list', repo, limit: 0 },
      { op: 'issue_list', repo, limit: 5, state: 'merged' },
    ]) {
      const result = await h.reader(query, h.authority);
      assert.equal(result.ok, false, JSON.stringify(query));
      assert.equal(result.code, 'unsupported_query', JSON.stringify(query));
    }
    assert.equal(h.calls.length, 0);
  });
  it('denies absent, foreign-repository and ended authority before spawn', async () => {
    const h = harness();
    const query = { op: 'pr_view', repo, number: 41 };
    assert.equal((await h.reader(query)).code, 'capability_unavailable');
    assert.equal((await h.reader({ ...query, repo: 'other/private' }, h.authority)).code, 'scope_denied');
    h.revoke.abort();
    assert.equal((await h.reader(query, h.authority)).code, 'invocation_ended');
    assert.equal(h.calls.length, 0);
  });
  for (const query of [
    { op: 'pr_view', repo, number: 41 },
    { op: 'pr_diff', repo, number: 41 },
    { op: 'pr_checks', repo, number: 41 },
    { op: 'issue_view', repo, number: 2 },
    { op: 'pr_list', repo, state: 'merged', limit: 5 },
    { op: 'issue_list', repo, state: 'all', limit: 5 },
    { op: 'run_view', repo, runId: 123 },
    { op: 'run_list', repo, limit: 5 },
  ])
    it(`executes only the fixed ${query.op} command with host environment`, async () => {
      const h = harness();
      const result = await h.reader(query, h.authority);
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.provenance.repository, repo);
      assert.equal(result.provenance.operation, query.op);
      assert.equal(result.provenance.truncated, false);
      assert.match(result.provenance.sourceUrl, /^https:\/\/github\.com\/08mamba24\/clowder-ai\//);
      for (const call of h.calls) {
        assert.equal(call.file, '/host/guarded-bin/gh');
        if (call.args[0] === 'repo')
          assert.deepEqual(call.args, ['repo', 'view', `github.com/${repo}`, '--json', 'hasIssuesEnabled']);
        else assert.equal(call.args[call.args.indexOf('--repo') + 1], `github.com/${repo}`);
        assert.equal(call.options.cwd, '/host/query');
        assert.equal(call.options.shell, false);
        assert.equal(call.options.windowsHide, true);
        const env = call.options.env;
        assert.equal(env.HOME, '/host/home');
        assert.equal(env.GITHUB_TOKEN, undefined);
        assert.equal(env.GH_TOKEN, undefined);
        assert.equal(env.GH_FORCE_TTY, undefined);
        assert.equal(env.GH_PROMPT_DISABLED, '1');
        assert.equal(env.GH_HOST, 'github.com');
      }
      assert.ok(!JSON.stringify(result).includes('secret'));
    });
  it('normalizes repository case and projects away unrequested response fields', async () => {
    const h = harness({
      runner: async () => ({
        stdout: JSON.stringify({ ...pr, secret: 'leak', author: { token: 'leak' } }),
        exitCode: 0,
      }),
    });
    const result = await h.reader({ op: 'pr_view', repo: repo.toUpperCase(), number: 41 }, h.authority);
    assert.equal(result.ok, true);
    assert.equal(result.provenance.headSha, head);
    assert.ok(!JSON.stringify(result).includes('leak'));
  });
  it('marks a bounded list truncated using one extra item, without pagination', async () => {
    const h = harness({
      runner: async (_file, args) => {
        assert.equal(args[args.indexOf('--limit') + 1], '3');
        return { stdout: JSON.stringify([pr, { ...pr, number: 42 }, { ...pr, number: 43 }]), exitCode: 0 };
      },
    });
    const result = await h.reader({ op: 'pr_list', repo, state: 'all', limit: 2 }, h.authority);
    assert.equal(result.ok, true);
    assert.equal(result.data.length, 2);
    assert.equal(result.provenance.truncated, true);
  });
  it('rejects a PR diff when head changes while it is read', async () => {
    let n = 0;
    const h = harness({
      runner: async (_file, args) => ({
        stdout:
          args[1] === 'diff'
            ? 'diff contents'
            : JSON.stringify({ ...pr, headRefOid: ++n === 1 ? head : 'b'.repeat(40) }),
        exitCode: 0,
      }),
    });
    const result = await h.reader({ op: 'pr_diff', repo, number: 41 }, h.authority);
    assert.equal(result.code, 'stale_head');
    assert.ok(!('data' in result));
  });
  it('retains pending/failing checks and never calls an empty set green', async () => {
    for (const [checks, exitCode, expected] of [
      [[], 0, 'unknown'],
      [[{ ...check, bucket: 'skipping', state: 'SKIPPED' }], 0, 'unknown'],
      [[{ ...check, bucket: 'cancel', state: 'CANCELLED' }], 1, 'fail'],
      [[{ ...check, bucket: 'pending', state: 'PENDING' }], 8, 'pending'],
      [[{ ...check, bucket: 'fail', state: 'FAILURE' }], 1, 'fail'],
    ]) {
      const h = harness({
        runner: async (_file, args) =>
          args[1] === 'checks'
            ? { stdout: JSON.stringify(checks), exitCode }
            : { stdout: JSON.stringify(pr), exitCode: 0 },
      });
      const result = await h.reader({ op: 'pr_checks', repo, number: 41 }, h.authority);
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.data.state, expected);
      assert.equal(result.provenance.headSha, head);
    }
  });
  it('rejects malformed upstream data and version metadata', async () => {
    for (const stdout of ['not json', '{}', JSON.stringify({ ...pr, headRefOid: 'bad' })]) {
      const h = harness({ runner: async () => ({ stdout, exitCode: 0 }) });
      assert.equal((await h.reader({ op: 'pr_view', repo, number: 41 }, h.authority)).code, 'unavailable');
    }
  });
  it('discards a result revoked during execution', async () => {
    const h = harness({
      runner: async () => {
        h.revoke.abort();
        return { stdout: JSON.stringify(pr), exitCode: 0 };
      },
    });
    assert.equal((await h.reader({ op: 'pr_view', repo, number: 41 }, h.authority)).code, 'invocation_ended');
  });
  it('enforces time and output bounds, including injected runners ignoring cancellation', async () => {
    const slow = harness({ timeoutMs: 15, runner: async () => new Promise(() => {}) });
    const result = await slow.reader({ op: 'pr_view', repo, number: 41 }, slow.authority);
    assert.equal(result.code, 'timeout');
    const large = harness({ maxOutputBytes: 20 });
    assert.equal((await large.reader({ op: 'pr_view', repo, number: 41 }, large.authority)).code, 'output_limit');
  });
  it('returns cancellation before spawn and during a hung query', async () => {
    const h = harness();
    const cancel = new AbortController();
    cancel.abort();
    assert.equal(
      (await h.reader({ op: 'pr_view', repo, number: 41 }, h.authority, { signal: cancel.signal })).code,
      'cancelled',
    );
    assert.equal(h.calls.length, 0);
    const during = new AbortController();
    const slow = harness({
      runner: async () => {
        during.abort();
        return new Promise(() => {});
      },
    });
    assert.equal(
      (await slow.reader({ op: 'pr_view', repo, number: 41 }, slow.authority, { signal: during.signal })).code,
      'cancelled',
    );
  });
  it('projects failures to typed codes without stderr or credential leakage', async () => {
    for (const [stderr, exitCode, expected] of [
      ['gh: Bad credentials (HTTP 401) resolved-host-secret', 4, 'authentication_required'],
      ['gh: API rate limit exceeded (HTTP 403)', 1, 'rate_limited'],
      ['gh: Forbidden (HTTP 403)', 1, 'permission_denied'],
      ['gh: Not Found (HTTP 404)', 1, 'not_found'],
      ['internal stack resolved-host-secret', 1, 'unavailable'],
    ]) {
      const h = harness({ runner: async () => ({ stdout: '', stderr, exitCode }) });
      const result = await h.reader({ op: 'pr_view', repo, number: 41 }, h.authority);
      assert.equal(result.code, expected);
      assert.deepEqual(Object.keys(result).sort(), ['code', 'ok', 'retryable']);
      assert.ok(!JSON.stringify(result).includes('secret'));
    }
  });
  it('reports disabled Issues as a non-retryable domain refusal only for issue operations', async () => {
    const stderr = `the '${repo}' repository has disabled issues\n`;
    const h = harness({
      runner: async (_file, args) =>
        args[0] === 'repo'
          ? { stdout: JSON.stringify({ hasIssuesEnabled: true }), exitCode: 0 }
          : { stdout: '', stderr, exitCode: 1 },
    });
    for (const query of [
      { op: 'issue_view', repo, number: 2 },
      { op: 'issue_list', repo, state: 'all', limit: 5 },
    ]) {
      assert.deepEqual(await h.reader(query, h.authority), {
        ok: false,
        code: 'issues_disabled',
        retryable: false,
      });
    }
    assert.equal((await h.reader({ op: 'pr_view', repo, number: 41 }, h.authority)).code, 'unavailable');
  });
  it('checks the repository setting before gh issue view resolves a PR', async () => {
    const calls = [];
    const h = harness({
      runner: async (_file, args) => {
        calls.push(args);
        if (args[0] === 'repo') return { stdout: JSON.stringify({ hasIssuesEnabled: false }), exitCode: 0 };
        return {
          stdout: JSON.stringify({ ...pr, number: 1, state: 'OPEN', url: `https://github.com/${repo}/pull/1` }),
          exitCode: 0,
        };
      },
    });
    assert.deepEqual(await h.reader({ op: 'issue_view', repo, number: 1 }, h.authority), {
      ok: false,
      code: 'issues_disabled',
      retryable: false,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'repo');
    assert.equal(calls[0][1], 'view');
  });
  it('does not project a PR returned by gh issue view as an issue', async () => {
    const h = harness({
      runner: async (_file, args) => ({
        stdout: JSON.stringify(
          args[0] === 'repo' ? { hasIssuesEnabled: true } : { ...issue, url: `https://github.com/${repo}/pull/2` },
        ),
        exitCode: 0,
      }),
    });
    assert.deepEqual(await h.reader({ op: 'issue_view', repo, number: 2 }, h.authority), {
      ok: false,
      code: 'not_found',
      retryable: false,
    });
  });
  it('fails closed when the repository Issues setting is malformed', async () => {
    const calls = [];
    const h = harness({
      runner: async (_file, args) => {
        calls.push(args);
        return { stdout: JSON.stringify({ hasIssuesEnabled: 'false' }), exitCode: 0 };
      },
    });
    assert.deepEqual(await h.reader({ op: 'issue_view', repo, number: 2 }, h.authority), {
      ok: false,
      code: 'unavailable',
      retryable: true,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'repo');
  });
  it('rejects a diff if only the target branch changes', async () => {
    let n = 0;
    const h = harness({
      runner: async (_file, args) => ({
        stdout:
          args[1] === 'diff'
            ? 'diff'
            : JSON.stringify({ ...pr, baseRefOid: ++n === 1 ? 'c'.repeat(40) : 'd'.repeat(40) }),
        exitCode: 0,
      }),
    });
    assert.equal((await h.reader({ op: 'pr_diff', repo, number: 41 }, h.authority)).code, 'stale_head');
  });
  it('counts every subprocess against one output budget', async () => {
    const pin = JSON.stringify({ headRefOid: head, baseRefOid: 'c'.repeat(40) });
    const h = harness({
      maxOutputBytes: Buffer.byteLength(pin) * 2,
      runner: async (_file, args) => ({
        stdout: args[1] === 'diff' ? 'diff' : pin,
        exitCode: 0,
      }),
    });
    assert.equal((await h.reader({ op: 'pr_diff', repo, number: 41 }, h.authority)).code, 'output_limit');
  });
  it('bounds each authority independently and releases slots after errors', async () => {
    let release = () => {};
    let calls = 0;
    const blocked = new Promise((resolve) => {
      release = resolve;
    });
    const h = harness({
      runner: async () => {
        calls++;
        await blocked;
        throw new Error('fake failure');
      },
    });
    const query = { op: 'pr_view', repo, number: 41 };
    const first = h.reader(query, h.authority);
    const second = h.reader(query, h.authority);
    const other = h.reader(query, { ...h.authority });
    assert.equal((await h.reader(query, h.authority)).code, 'unavailable');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 3);
    release();
    await Promise.all([first, second, other]);
    await h.reader(query, h.authority);
    assert.equal(calls, 4);
  });
  it('does not spawn with relative host executable or cwd', async () => {
    for (const overrides of [{ ghPath: 'gh' }, { cwd: '.' }]) {
      const h = harness(overrides);
      assert.equal((await h.reader({ op: 'pr_view', repo, number: 41 }, h.authority)).code, 'capability_unavailable');
      assert.equal(h.calls.length, 0);
    }
  });
});
