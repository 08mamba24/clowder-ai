import { GROUP_ID } from './f322-chat-real-page-data.mjs';

/** Actual painted atoms/owners, including hidden optional words, from the production DOM. */
export function measureSidebarSignalLayout(root) {
  const bounds = root.getBoundingClientRect();
  const contained = (inner, outer) => inner.left >= outer.left - 0.5 && inner.right <= outer.right + 0.5;
  const atoms = [...root.querySelectorAll('[data-signal-fixed], [data-signal-badge]')];
  const rects = atoms.map((atom) => atom.getBoundingClientRect());
  const badges = [...root.querySelectorAll('[data-signal-badge]')];
  const badgeRows = [...new Set(badges.map((badge) => badge.getBoundingClientRect().top))];
  const status = root.querySelector('[data-testid="thread-status-text"]');
  const text = root.querySelector('[data-testid="thread-status-label-content"]');
  const slot = root.querySelector('[data-testid="thread-status-label"]');
  return {
    width: bounds.width,
    height: bounds.height,
    split: root.dataset.signalSplit,
    contained: rects.every((rect) => contained(rect, bounds)),
    noOverlap: rects.every((rect, i) =>
      rects
        .slice(i + 1)
        .every(
          (other) =>
            rect.right <= other.left + 0.5 ||
            other.right <= rect.left + 0.5 ||
            rect.bottom <= other.top + 0.5 ||
            other.bottom <= rect.top + 0.5,
        ),
    ),
    avatarsContained: [...root.querySelectorAll('[data-testid="thread-signal-cats"]')].every((roster) =>
      [...roster.querySelectorAll('img')].every(
        (avatar) =>
          avatar.getBoundingClientRect().width === 16 &&
          contained(avatar.getBoundingClientRect(), roster.getBoundingClientRect()),
      ),
    ),
    badgeText: badges.map((badge) => badge.textContent),
    badgeHeights: badges.map((badge) => badge.getBoundingClientRect().height),
    badgeRows,
    rightAligned: badgeRows.every(
      (top) =>
        Math.abs(
          Math.max(
            ...badges
              .filter((badge) => badge.getBoundingClientRect().top === top)
              .map((badge) => badge.getBoundingClientRect().right),
          ) - bounds.right,
        ) < 0.5,
    ),
    statusRecoverable: !status || status.getBoundingClientRect().width > 0,
    statusLabel: status?.getAttribute('aria-label'),
    statusVisible: text && getComputedStyle(text).visibility === 'visible',
    statusWhole:
      !text ||
      getComputedStyle(text).visibility === 'hidden' ||
      text.getBoundingClientRect().width <= slot.getBoundingClientRect().width,
    namesWhole: [...root.querySelectorAll('[data-testid="thread-cat-name"]')].every(
      (name) =>
        getComputedStyle(name).visibility === 'hidden' ||
        name.firstElementChild.getBoundingClientRect().width <= name.getBoundingClientRect().width,
    ),
  };
}
export const labels = Array.from({ length: 18 }, (_, i) => ({
  id: `label-${i}`,
  name: `很长的标签名字 · Label ${i}`,
  color: i % 2 ? '#998877' : '',
  sortOrder: i,
  createdBy: 'owner-proof',
  createdAt: 0,
}));
export function setupSidebarProof(api) {
  api.threads[3].title = '首席唤醒官';
  api.threads[1].presence.activeSince = Date.now() - (api.threads[1].presence.cats.length > 2 ? 3471 : 90) * 60_000;
  for (let i = 11; i < 100; i++)
    api.threads.push({
      ...api.threads[3],
      id: `composer-proof-${i}`,
      title: `第 ${i} 个长标题 ${'需要两行才能完整读懂的对话。'.repeat(5)}`,
    });
  api.threads.forEach((row, i) => {
    row.labels = i % 2 ? ['label-17'] : [];
    row.favorited = true;
  });
  api.preferences.groups = [0, 1].map((i) => ({
    id: i ? 'second-group' : GROUP_ID,
    name: i ? '第二个组 · Second group' : '侧栏实现 · Sidebar implementation',
    threadIds: api.threads.slice(i * 50, (i + 1) * 50).map((row) => row.id),
  }));
  api.preferences.open['group:second-group'] = false;
  const respond = api.respond;
  api.respond = (request, url) => {
    if (url.pathname === '/api/labels')
      return { status: 200, contentType: 'application/json', body: JSON.stringify(labels) };
    const response = respond(request, url);
    if (url.pathname !== '/api/cats' || !response) return response;
    const body = JSON.parse(response.body);
    body.cats = body.cats.map((cat) => ({
      ...cat,
      nickname:
        cat.id === 'codex61-sol'
          ? '小太阳·砚砚'
          : cat.id === 'codex-astra'
            ? '小星星·砚砚'
            : `${cat.displayName}·完整昵称`,
    }));
    return { ...response, body: JSON.stringify(body) };
  };
}
