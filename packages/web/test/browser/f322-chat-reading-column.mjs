import assert from 'node:assert/strict';

// The production ThreadChatSurface owns the column. Its fixture only supplies
// the outer viewport, HTTP responses and socket transport, never a reading width.
export async function runChatReadingColumnJourney(t, { openProof, closeProof, capture, captureFailure }) {
  for (const [width, sidebar, base] of [
    [1920, true, 'light'],
    [1440, true, 'dark'],
    [700, true, 'dark'],
    [320, false, 'light'],
  ]) {
    await t.test(`production reading surface at ${width}px ${base}`, async () => {
      const proof = await openProof({ width, sidebar, base, surface: true });
      const { page } = proof;
      let failure;
      try {
        const cat = page.locator('[data-message-id="reading-cat"]');
        await cat.waitFor();
        const measure = () =>
          page.evaluate(() => {
            const rect = (selector) => {
              const node = document.querySelector(selector);
              if (!node) return null;
              const r = node.getBoundingClientRect();
              return { x: r.x, right: r.right, width: r.width, scroll: node.scrollWidth, client: node.clientWidth };
            };
            return {
              host: rect('[data-chat-container]'),
              padding: {
                left: parseFloat(getComputedStyle(document.querySelector('[data-chat-container]')).paddingLeft),
                right: parseFloat(getComputedStyle(document.querySelector('[data-chat-container]')).paddingRight),
              },
              column: rect('[data-thread-chat-reading-column]'),
              cat: rect('[data-message-id="reading-cat"]'),
              human: rect('[data-message-id="reading-human"] [data-testid="message-bubble"]'),
              line: rect('[data-testid="reply-last-line"]'),
            };
          });
        const m = await measure();
        assert.deepEqual(m.padding, { left: 16, right: 40 }, 'the measured piano owns the reserved right gutter');
        assert.equal(m.column.width, Math.min(720, m.host.width - 56));
        assert.ok(Math.abs(m.column.x + m.column.right - (m.host.x * 2 + m.host.width - 24)) <= 1);
        assert.equal(m.cat.width, m.column.width);
        const rail = await cat.locator('[data-reply-color-rail]').evaluate((node) => {
          const s = getComputedStyle(node);
          return {
            width: s.borderLeftWidth,
            padding: s.paddingLeft,
            background: s.backgroundColor,
            color: s.borderLeftColor,
          };
        });
        assert.equal(rail.width, '3px');
        assert.equal(rail.padding, '16px');
        assert.equal(rail.background, 'rgba(0, 0, 0, 0)');
        assert.notEqual(rail.color, 'rgba(0, 0, 0, 0)');
        const artwork = await cat.getByText('阅读栏中的作品', { exact: true }).evaluate((node) => {
          const r = node.parentElement.getBoundingClientRect();
          return { left: r.left, right: r.right };
        });
        assert.ok(artwork.left >= m.column.x - 1 && artwork.right <= m.column.right + 1);
        assert.ok(m.human.width <= m.column.width * 0.8 + 1);
        assert.ok(Math.abs(m.human.right - m.column.right) <= 1);
        assert.ok(m.line.right <= m.column.right + 1);
        assert.ok(m.host.scroll <= m.host.client + 1);
        assert.equal(await cat.getByTestId('reply-status-param').count(), 0);
        await cat.getByTestId('reply-record-toggle').click();
        await cat.getByTestId('reply-record-tool-command').getByRole('button').click();
        assert.ok((await cat.getByTestId('reply-record').innerText()).includes('long argument '.repeat(25).trim()));
        await cat.getByTestId('reply-record-toggle').click();
        await capture(page, `reading-${width}-${base}`);
        if (width === 1920) {
          await page.evaluate(() => {
            window.__readingNode = document.querySelector('[data-message-id="reading-cat"]');
          });
          await page.evaluate(() => window.__f322Chat.presentation('classic'));
          assert.ok(
            await page.evaluate(
              () => window.__readingNode === document.querySelector('[data-message-id="reading-cat"]'),
            ),
          );
          assert.ok((await measure()).column.width > 720);
          assert.equal(await page.locator('[data-reply-color-rail]').count(), 0);
          await page.evaluate(() => window.__f322Chat.presentation('v2'));
          await page.setViewportSize({ width: 700, height: 900 });
          assert.ok(
            await page.evaluate(
              () => window.__readingNode === document.querySelector('[data-message-id="reading-cat"]'),
            ),
          );
          assert.equal((await measure()).column.width, 344);
        }
      } catch (error) {
        failure = error;
        await captureFailure(page, `reading-${width}`, error);
        throw error;
      } finally {
        if (failure) await page.close();
        else await closeProof(proof);
      }
    });
  }
}
