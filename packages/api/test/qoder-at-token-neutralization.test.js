/**
 * F317 @token hotfix unit tests — qoder 载体 prompt 的 `@句柄` 脱敏。
 *
 * 背景（证据见 review-notes/2026-09-28-qoder-at-token-wrapping-dsh.md）：
 * qodercn 把 stdin prompt 里的 `@token` 当文件引用替换成仓库路径——`@opus` 命中
 * 1.38MB 猫头像（每 spawn 重传），名册/路由示例被改写成 `.git/refs`、`node_modules` 路径。
 * 自然数据里"后一个字符是反引号"的句柄 358/358 幸存、0 处被替换；被替换的 469 处
 * 后一个字符全是空格/换行/`)`。故脱敏形态 = 反引号包裹。
 *
 * 本文件走 dist 构建（与 qoder-agent-service.test.js 同口径）。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, '..', '..', '..');
const { neutralizeAtTokensForFileExpansion } = await import(
  join(here, '..', 'dist', 'domains', 'cats', 'services', 'agents', 'providers', 'at-token-neutralization.js')
);

const N = neutralizeAtTokensForFileExpansion;

/** 脱敏后不应再出现的形态：句柄 token 后面直接跟空白或串尾（CLI 就是在这个形态上命中的）。 */
const RISKY = /@(?:[A-Za-z0-9_][A-Za-z0-9_-]*|[\u4e00-\u9fff][\u4e00-\u9fffA-Za-z0-9_-]*)(?=\s|$)/g;
const riskyCount = (text) => (text.match(RISKY) ?? []).length;

test('wraps bare handles that the CLI resolves: roster cell / routing example / mentions list', () => {
  assert.equal(
    N('|山猫纹布偶 glm5.3|@zcode · glm-5.3|走 zcode app-server|'),
    '|山猫纹布偶 glm5.3|`@zcode` · glm-5.3|走 zcode app-server|',
  );
  assert.equal(N('[正确] @zcode\n请帮忙'), '[正确] `@zcode`\n请帮忙');
  // 广口径：不仅包"证据里被替换过的形态"（空格/换行/`)`），连 `@队友:` 这类未观察到被替换的
  // 形态也一并包掉——脱敏按 token 类别收敛，不赌"触发字符集"的外推。
  assert.equal(N('你可以 @队友: @zcode / @dsh-vision'), '你可以 `@队友`: `@zcode` / `@dsh-vision`');
  assert.equal(N('live 上 qoder 无法唤醒 (@zcode)'), 'live 上 qoder 无法唤醒 (`@zcode`)');
  assert.equal(N('review 完 → @author'), 'review 完 → `@author`');
});

test('wraps CJK handles (@砚砚 / @猫名 / @句柄) and end-of-string handles', () => {
  assert.equal(N('同族多分身时用**唯一句柄**（如 @砚砚）。'), '同族多分身时用**唯一句柄**（如 `@砚砚`）。');
  assert.equal(N('另起一行写 @猫名'), '另起一行写 `@猫名`');
  assert.equal(N('@句柄'), '`@句柄`');
});

test('leaves already-wrapped handles, real file references, and emails alone', () => {
  assert.equal(N('（例如 `@opus`）'), '（例如 `@opus`）', 'already backticked: 自然数据 358/358 幸存');
  assert.equal(N('见 @packages/api/src/index.ts 与 @README.md'), '见 @packages/api/src/index.ts 与 @README.md');
  assert.equal(N('邮箱 foo@bar.com 与 a@b 不脱敏'), '邮箱 foo@bar.com 与 a@b 不脱敏');
});

test('C1 `@句柄 正文` 形态（历史数据里被替换 30 次）也脱敏，且不残留可解析形态', () => {
  const out = N('✅ 正确：`@opus 请确认这个安排`');
  assert.ok(out.includes('`@opus`'), `wrapped handle expected, got: ${out}`);
  assert.equal(riskyCount(out), 0, `no CLI-resolvable form left, got: ${out}`);
});

test('is idempotent (re-running on neutralized text is a no-op)', () => {
  const raw = '你可以 @队友: @zcode / @qoder-flash\n[正确] @zcode\n请帮忙\n@author @reviewer @co-creator\n';
  const once = N(raw);
  assert.equal(N(once), once);
});

test('real L0 sources + runtime roster: no handle is left in the CLI-resolvable form', () => {
  const sources = [
    'assets/prompt-templates/s4-collaboration.md',
    'assets/prompt-templates/c1-mcp-callback.md',
    'assets/prompt-templates/l3-routing-rules.md',
    'assets/prompt-templates/s5-teammate-roster.md',
    'assets/prompt-templates/l1-parallel-world.md',
    'assets/system-prompts/system-prompt-l0.md',
  ];
  let riskyBefore = 0;
  for (const rel of sources) {
    const raw = readFileSync(join(REPO_ROOT, rel), 'utf8');
    riskyBefore += riskyCount(raw);
    assert.equal(riskyCount(N(raw)), 0, `${rel} 脱敏后不应残留 CLI 可解析形态`);
  }

  // 运行期动态段：S5 名册表 + S4 callable mentions（模板里只有占位符，真实文本在这里补）
  const runtimeRoster = [
    '|猫猫|@mention · 当前模型|路由边界|',
    '|山猫纹布偶 glm5.3|@zcode · glm-5.3|走 zcode app-server|',
    '|奶牛猫 v4-flash-vision|@dsh-vision · deepseek-v4-flash-vision-exp|实验视觉模型|',
    '你可以 @队友: @zcode / @dsh-vision / @qoder / @qoder-flash',
    '同名队友并存时，请优先使用唯一句柄（例如 @opus）避免歧义。',
  ].join('\n');
  const rosterBefore = riskyCount(runtimeRoster);
  const rosterAfter = N(runtimeRoster);
  assert.ok(riskyBefore + rosterBefore > 0, '样本里应至少有一处 CLI 可解析形态（否则这条断言是空的）');
  assert.equal(riskyCount(rosterAfter), 0, '运行期名册/路由段脱敏后不应残留 CLI 可解析形态');
  assert.ok(rosterAfter.includes('`@zcode` / `@dsh-vision`'), 'mentions 列表逐句柄包裹');
  assert.ok(rosterAfter.includes('（例如 `@opus`）'), 'already-wrapped example 原样保留');
});
