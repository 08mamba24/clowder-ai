// Runs inside Chromium. Keep this independent of Node and of fixture-only styles.
export function measureChatProof() {
  const rect = (element) => {
    if (!element) return null;
    const r = element.getBoundingClientRect();
    const s = getComputedStyle(element);
    return {
      x: r.x,
      y: r.y,
      right: r.right,
      bottom: r.bottom,
      width: r.width,
      height: r.height,
      radius: parseFloat(s.borderRadius),
      border: parseFloat(s.borderTopWidth),
      background: s.backgroundColor,
      scroll: element.scrollWidth,
      client: element.clientWidth,
    };
  };
  const row = document.querySelector('[data-testid="chat-input-composer-row"]');
  const pane = document.querySelector('[data-testid="chat-proof-pane"]');
  const sidebar = document.querySelector('[data-shell-sidebar]');
  const context = row?.querySelector('[data-testid="chat-composer-context"]');
  const named = (labels) =>
    [...(row?.querySelectorAll('button') ?? [])].find((button) => labels.includes(button.getAttribute('aria-label')));
  const controls = [
    row?.querySelector('[aria-controls="composer-add-menu"]'),
    row?.querySelector('[data-testid="composer-project"]'),
    row?.querySelector('[data-testid="composer-routing-preview"]'),
    named(['语音输入', 'Voice input']),
    named(['发送消息', 'Send message']),
  ].map(rect);
  const busy = document.querySelector('[data-thread-id="composer-proof-1"]');
  const signals = busy?.querySelector('[data-testid="thread-row-signals"]');
  const working = busy?.querySelector('[data-testid="thread-row-working"]');
  const runningCat = busy?.querySelector('[data-testid="thread-running-cat"]');
  const avatars = [...(busy?.querySelectorAll('[data-testid="thread-signal-cats"] img') ?? [])].map((img) => {
    const ring = img.closest('.ring-2');
    return {
      name: img.alt,
      ring: ring ? getComputedStyle(ring).getPropertyValue('--tw-ring-color').trim() : null,
      loaded: img.complete && img.naturalWidth > 0,
    };
  });
  return {
    viewport: innerWidth,
    document: { client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth },
    pane: rect(pane),
    header: rect(pane?.querySelector('header')),
    sidebar: rect(sidebar),
    row: rect(row),
    textarea: rect(row?.querySelector('textarea')),
    context: rect(context),
    controls,
    signals: rect(signals),
    // Tooltip wrappers use display:contents; measure their painted children.
    signalParts: [...(signals?.children ?? [])]
      .flatMap((part) => (getComputedStyle(part).display === 'contents' ? [...part.children] : [part]))
      .map(rect),
    busy: rect(busy),
    quiet: rect(document.querySelector('[data-thread-id="composer-proof-3"]')),
    working: rect(working),
    avatars,
    runningAnimation: runningCat ? getComputedStyle(runningCat).animationName : null,
    theme: document.documentElement.dataset.theme,
  };
}
