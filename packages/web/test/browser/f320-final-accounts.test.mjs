import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { THREAD_ID } from './f309-ordinary-workspace-journey-fixture.mjs';
import { startFinalAccountPreview } from './f320-final-runtime.fixture.mjs';

let preview, browser, companyIdentity;
before(async () => {
  preview = await startFinalAccountPreview();
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close();
  await preview?.close();
});
async function addCodexAccount(page, note) {
  await page.getByRole('button', { name: '+ 添加账号', exact: true }).click();
  await page.getByRole('combobox', { name: '厂商' }).selectOption('openai');
  await page.getByRole('textbox', { name: '账号备注' }).fill(note);
  await page.getByRole('button', { name: '创建并开始登录' }).click();
}
async function readCodexAccount(page, accountRef) {
  const response = await page.request.get(`${preview.url}/api/accounts`, {
    headers: { 'x-cat-cafe-user': 'fixture' },
  });
  assert.equal(response.status(), 200, await response.text());
  const account = (await response.json()).providers.find((entry) => entry.id === accountRef);
  assert.ok(account?.codex, 'the canonical account read returns the managed login');
  return account.codex;
}
test(
  'default Hub entry uses real account routes for login, note, quota, atomic binding and reload',
  { timeout: 120000 },
  async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    try {
      await page.goto(`${preview.url}/settings?s=accounts`, { waitUntil: 'domcontentloaded' });
      const list = page.getByRole('group', { name: 'Account List', exact: true });
      await list.getByText('原默认 Codex 账号').waitFor();
      assert.equal(await page.getByRole('button', { name: '+ 添加账号', exact: true }).count(), 1);
      assert.equal(await list.getByRole('button', { name: '查询此账号额度' }).count(), 0);
      await addCodexAccount(page, '公司');
      const first = list
        .locator('[data-account-id]')
        .filter({ has: page.getByRole('heading', { name: '公司', exact: true }) });
      await first.waitFor();
      const ref = await first.getAttribute('data-account-id');
      const panel = page.locator(`[data-account-id="${ref}"]`);
      await panel.getByText('终端已打开，请完成官方登录').waitFor();
      await page.reload();
      await panel.getByText('终端已打开，请完成官方登录').waitFor();
      // A failed background GET must not hide successful native mutation results or lock controls.
      const failedList = async (route) => {
        const request = route.request();
        if (request.method() === 'GET' && new URL(request.url()).pathname === '/api/accounts')
          return route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'fixture list unavailable' }),
          });
        return route.continue();
      };
      await page.route('**/api/accounts**', failedList);
      await panel.getByRole('button', { name: '取消本次登录' }).click();
      await panel.getByText('已取消', { exact: true }).waitFor();
      await panel.getByRole('button', { name: '开始官方登录' }).click();
      await panel.getByText('终端已打开，请完成官方登录').waitFor();
      const companyRetry = preview.captureLoginAttempt();
      assert.equal(await panel.getByRole('button', { name: '开始官方登录' }).count(), 0);
      await page.unroute('**/api/accounts**', failedList);
      companyIdentity = await companyRetry.complete();
      await panel.getByText(companyIdentity.email).waitFor();
      await panel.getByRole('button', { name: '修改备注' }).click();
      await panel.getByRole('textbox', { name: '修改账号备注' }).fill('工作');
      await panel.getByRole('button', { name: '保存', exact: true }).click();
      await panel.getByRole('heading', { name: '工作' }).waitFor();
      await panel.getByRole('button', { name: '查询此账号额度' }).click();
      await panel.getByText(/剩余 70%/).waitFor();
      await panel.getByText(/溢出额度：剩余 20%/).waitFor();
      await panel.getByText(/2030.*重置/).waitFor();
      preview.setQuota('header');
      await panel.getByRole('button', { name: '查询此账号额度' }).click();
      await panel.getByText(/剩余 60%/).waitFor();
      await panel.getByText(/2030.*重置/).waitFor();
      const oldReply = await preview.reply('换绑前的真实 producer 回复');
      assert.equal(oldReply.accountRef, 'codex');
      await panel.getByRole('combobox', { name: '换绑范围' }).selectOption('family');
      await panel.getByRole('button', { name: '预览换绑' }).click();
      await panel.getByRole('button', { name: '确认换绑' }).click();
      await panel
        .getByText(/正在使用：/)
        .filter({ hasText: '缅因猫' })
        .waitFor();
      const newReply = await preview.reply('换绑后的真实 producer 回复');
      assert.notEqual(newReply.accountRef, 'codex');
      assert.equal(newReply.displayName, '工作');
      await page.goto(`${preview.url}/settings?s=members`, { waitUntil: 'domcontentloaded' });
      const member = page.getByTestId('member-account-codex61-sol');
      await member.getByRole('button', { name: /当前绑定：工作/ }).waitFor();
      await member.getByRole('button', { name: /换账号/ }).click();
      assert.equal(await member.getByRole('combobox', { name: '缅因猫使用账号' }).inputValue(), newReply.accountRef);
      if (process.env.F320_EVIDENCE_DIR) {
        await mkdir(process.env.F320_EVIDENCE_DIR, { recursive: true });
        await page.screenshot({
          path: join(process.env.F320_EVIDENCE_DIR, 'members-after-binding.png'),
          fullPage: true,
        });
      }
      await page.goto(`${preview.url}/thread/${THREAD_ID}`, { waitUntil: 'domcontentloaded' });
      await page.locator('[data-execution-account="codex"]').waitFor();
      await page.locator(`[data-execution-account="${newReply.accountRef}"]`).waitFor();
      if (process.env.F320_EVIDENCE_DIR)
        await page.screenshot({
          path: join(process.env.F320_EVIDENCE_DIR, 'reply-account-history.png'),
          fullPage: true,
        });
      await page.goto(`${preview.url}/settings?s=accounts`, { waitUntil: 'domcontentloaded' });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await panel.getByRole('heading', { name: '工作' }).waitFor();
      assert.ok((await panel.innerText()).includes(companyIdentity.email));
      assert.doesNotMatch(await panel.innerText(), /模拟/);
      if (process.env.F320_EVIDENCE_DIR) {
        await mkdir(process.env.F320_EVIDENCE_DIR, { recursive: true });
        await page.screenshot({
          path: join(process.env.F320_EVIDENCE_DIR, 'accounts-formal-desktop.png'),
          fullPage: true,
        });
      }
      assert.deepEqual(errors, []);
    } catch (error) {
      console.error('F320 browser failure', page.url(), errors);
      await page.screenshot({ path: '/tmp/f320-final-browser-failure.png', fullPage: true });
      throw error;
    } finally {
      await page.close();
    }
  },
);
test(
  'cancel and retry stay on the same account in mobile UI without adopting the late result',
  { timeout: 120000 },
  async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
    try {
      await page.goto(`${preview.url}/settings?s=accounts`, { waitUntil: 'domcontentloaded' });
      const panel = page.getByRole('group', { name: 'Account List', exact: true });
      await addCodexAccount(page, '私人');
      const card = panel.locator('article').filter({ has: page.getByRole('heading', { name: '私人' }) });
      await card.getByText('终端已打开，请完成官方登录').waitFor();
      const cancelledLogin = preview.captureLoginAttempt();
      cancelledLogin.keepPendingAfterAbort();
      const accountRef = await card.getAttribute('data-account-id');
      const original = await readCodexAccount(page, accountRef);
      await card.getByRole('button', { name: '取消本次登录' }).click();
      await card.getByText('已取消', { exact: true }).waitFor();
      assert.equal(cancelledLogin.wasAborted(), true, 'production cancellation reached the old native driver');
      await card.getByRole('button', { name: '开始官方登录' }).click();
      await card.getByText('等待前一个登录结束', { exact: true }).waitFor();
      const queued = await readCodexAccount(page, accountRef);
      assert.equal(queued.attempt.state, 'queued');
      assert.notEqual(queued.attempt.id, original.attempt.id);
      assert.equal(queued.attempt.identity, undefined);
      const lateIdentity = await cancelledLogin.complete();
      // Starting the queued retry proves the old result's then/finally chain ran.
      await card.getByText('终端已打开，请完成官方登录').waitFor();
      const privateRetry = preview.captureLoginAttempt();
      const waiting = await readCodexAccount(page, accountRef);
      assert.equal(waiting.attempt.id, queued.attempt.id);
      assert.equal(waiting.attempt.state, 'waiting');
      assert.equal(waiting.attempt.identity, undefined, 'the old callback did not leak identity into the retry');
      assert.equal(waiting.identity, undefined, 'the canceled attempt did not adopt credentials');
      assert.ok(!(await card.innerText()).includes(lateIdentity.email));
      assert.equal(await card.getAttribute('data-account-id'), accountRef);
      const retryIdentity = await privateRetry.complete();
      await card.getByText(retryIdentity.email).waitFor();
      assert.notEqual(retryIdentity.email, lateIdentity.email);
      assert.ok(!(await card.innerText()).includes(lateIdentity.email));
      const box = await card.boundingBox();
      assert.ok(box && box.width <= 390);
      if (process.env.F320_EVIDENCE_DIR)
        await page.screenshot({
          path: join(process.env.F320_EVIDENCE_DIR, 'accounts-formal-mobile.png'),
          fullPage: true,
        });
      await card.getByRole('button', { name: '删除账号条目' }).click();
      await page.getByText(/文件和登录仍保留/).waitFor();
      await page.getByRole('button', { name: '取消', exact: true }).click();
      await card.getByRole('heading', { name: '私人' }).waitFor();
      await card.getByRole('button', { name: '删除账号条目' }).click();
      await page.getByRole('button', { name: '确认删除', exact: true }).click();
      await card.waitFor({ state: 'detached' });
    } finally {
      await page.close();
    }
  },
);
test(
  'duplicate official login uses the existing account after explicit confirmation',
  { timeout: 120000 },
  async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${preview.url}/settings?s=accounts`, { waitUntil: 'domcontentloaded' });
      const panel = page.getByRole('group', { name: 'Account List', exact: true });
      await addCodexAccount(page, '重复公司');
      const card = panel.locator('article').filter({ has: page.getByRole('heading', { name: '重复公司' }) });
      await card.getByText('终端已打开，请完成官方登录').waitFor();
      const duplicateLogin = preview.captureLoginAttempt();
      assert.ok(companyIdentity, 'the company account completed official login');
      await duplicateLogin.complete(companyIdentity);
      await card.getByText(/已有相同身份的账号「工作」/).waitFor();
      assert.equal(await card.getByRole('button', { name: '保留为独立账号' }).count(), 0);
      await card.getByRole('button', { name: '使用已有账号' }).click();
      await card.getByText('已选择已有账号，未创建重复登录').waitFor();
      await page.reload({ waitUntil: 'domcontentloaded' });
      await card.getByText('已选择已有账号，未创建重复登录').waitFor();
      await panel
        .locator('article')
        .filter({ has: page.getByRole('heading', { name: '工作' }) })
        .getByText(/可使用/)
        .waitFor();
      // Release the actual family binding through the canonical API before deleting A.
      const response = await page.request.post(`${preview.url}/api/accounts/codex/codex/binding/preview`, {
        headers: { 'x-cat-cafe-user': 'fixture' },
        data: { catId: 'codex61-sol', scope: 'family' },
      });
      assert.equal(response.status(), 200, await response.text());
      const impact = await response.json();
      const commit = await page.request.post(`${preview.url}/api/accounts/codex/codex/binding/commit`, {
        headers: { 'x-cat-cafe-user': 'fixture' },
        data: { catId: 'codex61-sol', scope: 'family', previewToken: impact.previewToken },
      });
      assert.equal(commit.status(), 200, await commit.text());
      await page.reload({ waitUntil: 'domcontentloaded' });
      const existing = panel.locator('article').filter({ has: page.getByRole('heading', { name: '工作' }) });
      await existing.getByRole('button', { name: '删除账号条目' }).click();
      await page.getByRole('button', { name: '确认删除', exact: true }).click();
      await card.getByText(/此前复用的账号已不可用/).waitFor();
      await page.reload({ waitUntil: 'domcontentloaded' });
      await card.getByText(/此前复用的账号已不可用/).waitFor();
      assert.equal(await card.getByRole('button', { name: '预览换绑', exact: true }).count(), 0);
      assert.equal(await panel.getByRole('heading', { name: '工作' }).count(), 0);
      if (process.env.F320_EVIDENCE_DIR)
        await page.screenshot({ path: join(process.env.F320_EVIDENCE_DIR, 'reuse-after-delete.png'), fullPage: true });
    } finally {
      await page.close();
    }
  },
);
