import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { ensureWorkspaceOpen } from './f307-workspace-open.mjs';
import { createFirstFileFixture, observeFirstFileQuote } from './f309-first-file-fixture.mjs';
import { openDocumentSession } from './f309-ordinary-document-session.mjs';
import { EVIDENCE } from './f309-ordinary-workspace-journey-chat-progress.mjs';

async function quoteNative(page, extension, entry, text, comment) {
  const viewer = page.getByTestId(entry === 'artwork' ? 'workspace-content-review-text' : 'workspace-file-viewer');
  const passage =
    extension === 'md' ? viewer.getByText(text, { exact: true }) : viewer.locator('.cm-line').filter({ hasText: text });
  await passage.scrollIntoViewIfNeeded();
  const rect = await passage.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const box = range.getBoundingClientRect();
    return { left: box.left, right: box.right, y: box.top + box.height / 2 };
  });
  await page.mouse.move(rect.left + 0.1, rect.y);
  await page.mouse.down();
  await page.mouse.move(rect.right + 0.1, rect.y, { steps: 8 });
  await page.mouse.up();
  await page
    .getByTestId(
      entry === 'artwork' ? 'workspace-content-review-text-add-to-chat' : 'workspace-code-selection-add-to-chat',
    )
    .click();
  const editor = page.getByTestId('context-annotation-comment');
  // Keep the real click/fill/Enter path: the host must promote after the controlled owner's change handler.
  await editor.click();
  await editor.fill(comment);
  assert.equal(await editor.inputValue(), comment, 'native comment survives the input event');
  await editor.press('Enter');
  await editor.waitFor({ state: 'hidden' });
}

async function assertNativeEntryReview(page, f, entry) {
  const openedReview = f.owner.fileReviewStore.get(f.reviewId);
  if (entry === 'artwork') {
    // Main #5263 intentionally opens Markdown in its existing Human artwork owner.
    // Cold Markdown callback creation remains covered by API tests; this native entry tests reuse.
    assert.ok(openedReview);
    assert.equal(openedReview.revision, 1);
    assert.equal(openedReview.contentRef, f.source.contentRef);
    assert.equal(openedReview.source.revision, f.source.revision);
    assert.deepEqual(openedReview.annotations, []);
  } else {
    assert.equal(await page.getByTestId('workspace-content-review-surface').count(), 0);
    assert.equal(openedReview, null);
  }
  return openedReview;
}

async function runFirstFileJourney(suite, scenario) {
  const { extension, width, shell, entry } = scenario;
  const slug = `${extension}-${width}-${shell}`;
  const f = await createFirstFileFixture(extension);
  let session;
  let openedReview = null;
  await mkdir(EVIDENCE, { recursive: true });
  try {
    session = await openDocumentSession(suite, f.owner, scenario);
    await f.captureNativeSend(session.context, () => openedReview);
    const { page, calls } = session;
    await ensureWorkspaceOpen(page);
    await page.locator('[data-workspace-destination="surface:files"]').click();
    await page.getByTestId('f307-files-owner-surface').waitFor();
    const search = page.getByPlaceholder('搜索当前工作区…', { exact: true });
    await search.fill(f.filename);
    await search.press('Enter');
    await page.locator(`[data-search-result-path=${JSON.stringify(f.filePath)}][data-search-result-line="0"]`).click();
    await page.getByTestId(entry === 'artwork' ? 'workspace-content-review-text' : 'workspace-file-viewer').waitFor();
    await observeFirstFileQuote(page);
    openedReview = await assertNativeEntryReview(page, f, entry);
    await quoteNative(page, extension, entry, f.phrases[0], '第一处改具体些。');
    await quoteNative(page, extension, entry, f.phrases[1], '第二处保留语气。');
    const preparePostCountBeforeSend = calls.filter(
      (call) => call.method === 'POST' && call.path.endsWith('/prepare'),
    ).length;
    if (entry === 'file') assert.equal(preparePostCountBeforeSend, 0);
    else assert.ok(preparePostCountBeforeSend > 0);
    assert.deepEqual(f.owner.fileReviewStore.get(f.reviewId), openedReview);
    assert.equal(f.owner.tasks.listByThread(f.owner.thread.id).length, f.tasksBefore);
    await page.screenshot({ path: `${EVIDENCE}/first-file-${slug}-quoted.png` });
    await page.getByTestId('v2-workspace-chrome').getByRole('button', { name: '收起 Workspace', exact: true }).click();
    await page
      .getByRole('textbox', { name: '消息输入框', exact: true })
      .fill(`@${f.owner.catId} 请修改这两处引用，先给候选。`);
    const sentResponse = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/messages' && response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: shell === 'v2' ? '发送消息' : 'Send message', exact: true }).click();
    assert.equal((await sentResponse).status(), 200);
    await page.getByTestId('context-annotations-summary').waitFor({ state: 'hidden' });
    assert.equal(f.sent.length, 1);
    const { message, input } = f.sent[0];
    assert.deepEqual(
      input.contextAttachments.map((quote) => quote.text),
      f.phrases,
    );
    assert.ok(
      input.contextAttachments.every(
        (quote) => quote.source.path === f.filePath && quote.source.revision === f.source.revision,
      ),
    );
    assert.deepEqual(f.owner.fileReviewStore.get(f.reviewId), openedReview);
    const record = await f.owner.takeOver(message.id);
    const prepared = f.owner.fileReviewStore.get(f.reviewId);
    if (openedReview) assert.deepEqual(prepared, openedReview, 'takeover reuses the current review without refresh');
    assert.equal(prepared.revision, 1);
    assert.deepEqual(prepared.annotations, []);
    assert.equal(record.payload.source.reviewId, f.reviewId);
    assert.equal(f.owner.tasks.listByThread(f.owner.thread.id).length, f.tasksBefore + 1);
    const candidate = await f.candidate(record, message);
    await page.reload({ waitUntil: 'domcontentloaded' });
    const drawer = page.getByTestId('contextual-workspace-host');
    if (width < 768 && (await drawer.isVisible())) {
      await page
        .getByTestId('v2-workspace-chrome')
        .getByRole('button', { name: '收起 Workspace', exact: true })
        .click();
      await drawer.waitFor({ state: 'hidden' });
    }
    await page
      .locator(`[data-message-id="${candidate.receipt.id}"]`)
      .getByRole('button', { name: '打开对照', exact: true })
      .click();
    const result = page.locator(`[data-candidate-ref="${candidate.returned.proposalRef}"]`);
    await result.waitFor({ state: 'visible' });
    assert.equal(await result.locator('[data-text-edit]').count(), 2);
    await page.screenshot({ path: `${EVIDENCE}/first-file-${slug}-candidate.png` });
    await result.getByTestId('content-modification-accept').click();
    await result.getByText('已写回原文件', { exact: true }).waitFor();
    assert.equal(await readFile(f.absolute, 'utf8'), candidate.written);
    assert.equal(
      calls.filter((call) => call.method === 'POST' && call.path.endsWith('/accept') && call.status === 200).length,
      1,
    );
    await page.screenshot({ path: `${EVIDENCE}/first-file-${slug}-applied.png` });
    await page
      .getByTestId('workspace-content-review-surface')
      .getByRole('button', { name: '返回来源', exact: true })
      .click();
    assert.equal(new URL(page.url()).pathname, `/thread/${f.owner.thread.id}`);
    await page.locator(`[data-message-id="${candidate.receipt.id}"]`).waitFor({ state: 'visible' });
    assert.deepEqual(session.errors, []);
    assert.deepEqual(f.owner.errors, []);
    await writeFile(
      `${EVIDENCE}/first-file-${slug}.json`,
      JSON.stringify(
        {
          testedHead: process.env.F309_TESTED_HEAD,
          scenario,
          filePath: f.filePath,
          sourceRevision: f.source.revision,
          reviewId: f.reviewId,
          sourceMessageId: message.id,
          requestId: record.requestId,
          taskId: record.progress.task.taskId,
          candidateRef: candidate.returned.proposalRef,
          preOpenReview: null,
          preSendReview: openedReview,
          preTakeoverReview: openedReview,
          preparePostCountBeforeSend,
          reviewCreatedByCallback: entry === 'file',
          nativeSend: input,
          actualModelInvocation: false,
          alphaAcceptance: false,
          boundaries: [
            'synthetic Human/session issuer consumes actual native POST with production schema',
            'explicit target mention enforced by issuer; AgentRouter excluded',
            'deterministic non-LLM provider',
            'unrelated shell catalog mocked',
            'production GET history reload; push transport excluded',
          ],
          calls,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    await session?.page.screenshot({ path: `${EVIDENCE}/first-file-${slug}-failed.png` });
    if (session)
      await writeFile(
        `${EVIDENCE}/first-file-${slug}-failed.json`,
        JSON.stringify(
          {
            testedHead: process.env.F309_TESTED_HEAD,
            scenario,
            error: String(error),
            calls: session.calls,
            errors: session.errors,
            nativeSend: f.sent,
            body: (await session.page.locator('body').innerText()).slice(-10000),
            quoteTrace: await session.page.evaluate(() => window.__firstFileQuoteTrace ?? []),
          },
          null,
          2,
        ),
      );
    throw error;
  } finally {
    await session?.context.unrouteAll({ behavior: 'ignoreErrors' });
    await session?.context.close();
    await f.close();
  }
}

export function registerFirstFileJourney(suite) {
  for (const scenario of [
    { extension: 'md', width: 1440, dark: false, shell: 'v2', entry: 'artwork' },
    { extension: 'ts', width: 390, dark: true, shell: 'v2', entry: 'file' },
  ]) {
    const { extension, width, shell, entry } = scenario;
    const slug = `${extension}-${width}-${shell}`;
    test(
      `first file: native ${entry === 'artwork' ? 'default artwork' : 'unprepared'} ${slug} quotes → Human send → takeover → candidate → explicit CAS`,
      { timeout: 120_000 },
      () => runFirstFileJourney(suite, scenario),
    );
  }
}
