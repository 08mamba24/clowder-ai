import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { realSurfaceApiResponse, THREAD_ID } from './f307-real-surface-fixtures.mjs';
import { ensureWorkspaceOpen } from './f307-workspace-open.mjs';
import { cats, detail, exactInput, firstSentence, generations, summary } from './f322-trajectory-data.mjs';
import { runTrajectoryReviewRegressions } from './f322-trajectory-review-journey.mjs';
import { createNextDevTestEnvironment } from './next-dev-test-environment.mjs';

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REPO = path.resolve(WEB_ROOT, '../..');
const OUT =
  process.env.F322_TRAJECTORY_EVIDENCE_DIR ?? path.join(tmpdir(), 'cat-cafe-evidence/f322-trajectory-clarity');
const measurements = [];
let server, browser, nextDev, baseUrl;

before(async () => {
  await mkdir(OUT, { recursive: true });
  const sync = spawnSync(process.execPath, ['scripts/sync-vendor-assets.mjs'], { cwd: WEB_ROOT, encoding: 'utf8' });
  assert.equal(sync.status, 0, sync.stderr);
  const portFinder = createServer();
  portFinder.listen(0, '127.0.0.1');
  await once(portFinder, 'listening');
  const port = portFinder.address().port;
  portFinder.close();
  await once(portFinder, 'close');
  nextDev = await createNextDevTestEnvironment('f322-trajectory-host', {
    NEXT_PUBLIC_API_URL: `http://127.0.0.1:${port}`,
  });
  server = spawn(
    process.execPath,
    [path.join(REPO, 'node_modules/next/dist/bin/next'), 'dev', '-H', '127.0.0.1', '-p', String(port)],
    { cwd: WEB_ROOT, env: nextDev.env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const output = [];
  server.stdout.on('data', (chunk) => output.push(chunk.toString()));
  server.stderr.on('data', (chunk) => output.push(chunk.toString()));
  baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 180000;
  let ready = false;
  while (Date.now() < deadline && !ready) {
    assert.equal(server.exitCode, null, output.join(''));
    try {
      ready = (await fetch(`${baseUrl}/thread/${THREAD_ID}`)).ok;
    } catch {
      /* Starting or compiling. */
    }
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert(ready, output.join(''));
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
  if (server?.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([once(server, 'exit'), new Promise((resolve) => setTimeout(resolve, 5000))]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  await nextDev?.cleanup();
  await writeFile(
    path.join(OUT, 'measurements.json'),
    JSON.stringify(
      {
        head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim(),
        sourceDiff: execFileSync('git', ['diff', 'HEAD', '--', 'packages/web/src'], { cwd: REPO, encoding: 'utf8' }),
        data: 'synthetic network fixture; production Next app, ChatContainer, F307 host, CSS and resize',
        measurements,
      },
      null,
      2,
    ),
  );
});

async function open(shell, theme, fixture = { summary, detail }) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  await context.addInitScript(
    ({ shell, theme }) => {
      localStorage.setItem('cat-cafe:shell-presentation', shell);
      localStorage.setItem('theme', theme);
    },
    { shell, theme },
  );
  const page = await context.newPage();
  const errors = [],
    calls = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/**', (route) => {
    const request = route.request(),
      url = new URL(request.url());
    calls.push(`${request.method()} ${url.pathname}${url.search}`);
    let response;
    if (url.pathname === '/api/cats') response = { body: { cats } };
    else if (url.pathname.endsWith('/invocations')) response = { body: { invocations: [fixture.summary], total: 1 } };
    else if (url.pathname.includes('/invocations/') && url.pathname.endsWith('/trajectory'))
      response = { body: { invocationId: summary.invocationId, threadId: THREAD_ID, sessionId: summary.sessionId } };
    else if (url.pathname.includes('/sessions/') && url.pathname.includes('/invocations/'))
      response = { body: fixture.detail };
    else if (url.pathname.includes('/sessions/') && url.pathname.endsWith('/events')) {
      const cursor = Number(url.searchParams.get('cursor'));
      const item = fixture.detail.events.find((event) => event.eventNo === cursor);
      response = item
        ? { body: { events: [item], total: fixture.detail.events.length, nextCursor: { eventNo: cursor + 1 } } }
        : { status: 404, body: { error: 'Event not found' } };
    } else if (url.pathname.endsWith('/request-generations'))
      response = { body: generations(url.searchParams.get('reveal') === 'exact') };
    else response = realSurfaceApiResponse(request, false);
    return route.fulfill({
      status: response.status ?? 200,
      contentType: 'application/json',
      body: JSON.stringify(response.body),
    });
  });
  await page.goto(`${baseUrl}/thread/${THREAD_ID}?shell=${shell}`, { waitUntil: 'networkidle' });
  await page.waitForFunction((theme) => document.documentElement.dataset.theme === theme, theme);
  await ensureWorkspaceOpen(page);
  await page.getByTestId('workspace-launcher-trajectory').click();
  const panel = page.getByTestId('trajectory-panel');
  await panel.waitFor();
  await panel.getByTestId('invocation-trajectory-list').waitFor();
  return { page, context, panel, errors, calls };
}

async function resize(page, target) {
  const host = page.getByTestId('contextual-workspace-host');
  const handle = page.getByRole('separator', { name: '右侧面板分隔条', exact: true });
  for (let n = 0; n < 3; n++) {
    const box = await host.boundingBox(),
      grip = await handle.boundingBox();
    assert(box && grip);
    if (Math.abs(box.width - target) < 3) return;
    const x = grip.x + grip.width / 2,
      y = grip.y + Math.min(200, grip.height / 2);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + box.width - target, y, { steps: 8 });
    await page.mouse.up();
  }
  assert(Math.abs((await host.boundingBox()).width - target) < 3, 'actual Workspace width must match');
}

async function measure(page, name, selector) {
  const result = await page.locator(selector).evaluate((node) => ({
    width: node.getBoundingClientRect().width,
    scrollWidth: node.scrollWidth,
    clientWidth: node.clientWidth,
    descendants: [...node.querySelectorAll('*')]
      .filter(
        (el) =>
          el.clientWidth > 0 &&
          el.scrollWidth > el.clientWidth + 1 &&
          ['auto', 'scroll'].includes(getComputedStyle(el).overflowX),
      )
      .map((el) => ({
        tag: el.tagName,
        text: el.textContent.slice(0, 35),
        width: el.clientWidth,
        scrollWidth: el.scrollWidth,
      })),
  }));
  measurements.push({ name, ...result });
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  assert(result.scrollWidth <= result.clientWidth + 1, `${name} own horizontal scroll: ${JSON.stringify(result)}`);
  assert.deepEqual(
    result.descendants.filter((row) => row.tag !== 'PRE'),
    [],
    `${name} must not hide horizontal overflow in its inner scrolling host`,
  );
  return result;
}

test(
  'v2 real Workspace host: desktop and 420/300px preserve colours, exact keyboard copies, raw and full inputs',
  { timeout: 180000 },
  async () => {
    for (const theme of ['light', 'dark']) {
      const { page, context, panel, errors, calls } = await open('v2', theme);
      try {
        for (const width of [720, 420, 300]) {
          await resize(page, width);
          await measure(page, `v2-${theme}-${width}-list`, '[data-testid="trajectory-panel"]');
          assert.match(await panel.innerText(), /小太阳/);
          assert.equal(await panel.getByTestId('first-assistant-preview').innerText(), firstSentence);
          assert.equal(
            calls.some((call) => call.includes('/sessions/') && call.includes('/invocations/')),
            false,
            'list must not fetch full detail per row',
          );
          const openRow = panel.locator('article > button').first();
          await openRow.focus();
          await page.keyboard.press('Tab');
          assert.equal(await page.locator(':focus').getAttribute('aria-label'), `复制调用 ID：${summary.invocationId}`);
          await page.keyboard.press('Enter');
          assert.equal(await page.evaluate(() => navigator.clipboard.readText()), summary.invocationId);
          await page.keyboard.press('Tab');
          assert.equal(await page.locator(':focus').getAttribute('aria-label'), `复制会话 ID：${summary.sessionId}`);
          await page.keyboard.press('Enter');
          assert.equal(await page.evaluate(() => navigator.clipboard.readText()), summary.sessionId);
          await openRow.click();
          const detailPanel = page.getByTestId('invocation-trajectory-detail');
          await detailPanel.waitFor();
          await detailPanel.getByText('保留角色颜色与原始记录。', { exact: true }).waitFor();
          const assistantRows = detailPanel.locator('[data-semantic-role="assistant"]');
          // Wait for actionable native cards from the current canonical
          // selection rather than a matching string in another record view.
          await assistantRows.nth(1).waitFor({ state: 'visible' });
          assert.equal(
            await assistantRows.count(),
            2,
            'different native identities and channels stay in separate rows',
          );
          assert.match(await assistantRows.first().innerText(), /由 3 段流式输出拼成/);
          assert.match(await assistantRows.first().innerText(), /过程/);
          assert.match(await assistantRows.last().innerText(), /最终回复/);
          await detailPanel.getByRole('button', { name: '查看首条输出记录', exact: true }).click();
          await detailPanel.getByTestId('first-output-source').getByText('原始记录 #101', { exact: true }).waitFor();
          assert.match(await detailPanel.getByTestId('first-output-source').locator('pre').innerText(), /You，/);
          assert.equal(
            calls.filter(
              (call) =>
                call.slice(call.indexOf(' ') + 1).split('?')[0] ===
                `/api/invocations/${summary.invocationId}/trajectory`,
            ).length,
            1,
            'each reopen resolves its current selection exactly once',
          );
          assert.equal(
            calls.filter(
              (call) =>
                call.slice(call.indexOf(' ') + 1).split('?')[0] ===
                `/api/sessions/${summary.sessionId}/invocations/${summary.invocationId}`,
            ).length,
            1,
            'accepted source reads are not interrupted by a second cached-target detail load',
          );
          await detailPanel.getByRole('button', { name: '‹ 轨迹', exact: true }).focus();
          for (const [kind, value] of [
            ['调用', summary.invocationId],
            ['会话', summary.sessionId],
          ]) {
            await page.keyboard.press('Tab');
            assert.equal(await page.locator(':focus').getAttribute('aria-label'), `复制${kind} ID：${value}`);
            await page.keyboard.press('Enter');
            assert.equal(await page.evaluate(() => navigator.clipboard.readText()), value);
          }
          await measure(page, `v2-${theme}-${width}-detail`, '[data-testid="invocation-trajectory-detail"]');
          assert.equal(
            await detailPanel
              .getByText('输入 1234 · 输出 321', { exact: true })
              .evaluate((node) => node.scrollWidth <= node.clientWidth && node.scrollHeight <= node.clientHeight),
            true,
            'all Token digits must fit without clipping',
          );
          const surfaces = await detailPanel.locator('[data-semantic-role]').evaluateAll((nodes) =>
            nodes.map((node) => ({
              role: node.dataset.semanticRole,
              background: getComputedStyle(node).backgroundImage,
            })),
          );
          const roles = new Map(surfaces.map((row) => [row.role, row.background]));
          for (const role of ['user', 'assistant', 'system', 'context', 'tool', 'error']) assert(roles.has(role), role);
          assert(new Set(roles.values()).size >= 5, 'semantic colour separation remains');
          const unknown = detailPanel.locator('[data-semantic-role="tool"]').filter({ hasText: 'unknown_source' });
          assert.equal((await unknown.innerText()).match(/来源未知/g)?.length, 1);
          assert.match(await unknown.innerText(), /运行中/);
          const input = detailPanel.getByTestId('request-generation-section');
          await input.scrollIntoViewIfNeeded();
          assert.equal(await input.getByText('完整输入末尾标记', { exact: true }).count(), 0);
          await input.getByRole('button', { name: '按来源权限展开' }).click();
          await input.getByText('展开实际提交内容', { exact: true }).click();
          const pre = input.locator('pre');
          assert.equal(await pre.textContent(), exactInput, 'full source body must remain exact');
          await pre.evaluate((node) => {
            node.scrollTop = node.scrollHeight;
          });
          await measure(page, `v2-${theme}-${width}-input`, '[data-testid="invocation-trajectory-detail"]');
          assert.match(await input.innerText(), /来源已删除/);
          assert.match(await input.innerText(), /来源未能核验/);
          await detailPanel.getByRole('button', { name: '原始记录', exact: true }).click();
          assert.equal(await detailPanel.locator('[data-raw-event-no]').count(), 100);
          await detailPanel.getByRole('button', { name: '再显示 100 条' }).click();
          assert.equal(await detailPanel.locator('[data-raw-event-no]').count(), detail.events.length);
          await detailPanel.getByRole('button', { name: '‹ 轨迹', exact: true }).click();
          calls.length = 0;
        }
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    }
  },
);

test(
  'classic real host retains original labels, preview, input ordering and absence of new ID controls',
  { timeout: 90000 },
  async () => {
    const { page, context, panel, errors } = await open('classic', 'light');
    try {
      for (const width of [720, 420, 300]) {
        await resize(page, width);
        assert.match(await panel.innerText(), /Invocations/);
        assert.match(await panel.innerText(), /Session #3/);
        assert.match(await panel.innerText(), /You，/);
        assert.equal(await panel.getByRole('button', { name: /^复制调用 ID/ }).count(), 0);
        await panel.locator('[data-invocation-id]').click();
        const current = page.getByTestId('invocation-trajectory-detail');
        await current
          .locator('[data-semantic-role="assistant"]')
          .filter({ hasText: '保留角色颜色与原始记录。' })
          .waitFor();
        assert.equal(
          await current.locator('[data-semantic-role="assistant"]').count(),
          1,
          'classic retains its original adjacency grouping',
        );
        assert.equal(await current.getByTestId('first-output-source').count(), 0);
        const text = await current.innerText();
        assert(text.indexOf('Input generations') < text.indexOf('保留角色颜色与原始记录。'));
        assert.match(text, /HOST CLI/);
        assert.match(text, /Raw/);
        await page.screenshot({ path: path.join(OUT, `classic-${width}-detail.png`) });
        await current.getByRole('button', { name: '← 返回', exact: true }).click();
      }
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  },
);

test(
  'v2 real host: sentence prefixes are not sentences and invalid roles stay only in raw records',
  { timeout: 180000 },
  () =>
    runTrajectoryReviewRegressions({
      open,
      resize,
      snapshot: (name, page) => page.screenshot({ path: path.join(OUT, `${name}.png`) }),
    }),
);
