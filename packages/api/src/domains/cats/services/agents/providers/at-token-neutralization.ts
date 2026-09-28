/**
 * qoder 载体 prompt 的 `@token` 脱敏（F317 hotfix，2026-09-28）。
 *
 * 现象：qodercn CLI 会把 stdin prompt 里形如 `@token` 的片段当**文件引用**做模糊解析，
 * 命中后就地替换成仓库内某个匹配路径（证据 = CLI 自己存的 prompt 副本，
 * 扫描脚本 review-notes/2026-09-28-qoder-at-token-scan-dsh.py，只读可复跑）：
 *
 *   `@zcode`  → `@.git/refs/heads/backup/zcode-acp-d51b3846`
 *   `@author` → `@node_modules/.pnpm/.../server/auth/handlers/authorize.js`
 *   `@句柄`   → `@packages/api/src/domains/cats/services/agents/routing/multi-mention-state-machine.ts`
 *   `@opus`   → `@packages/web/public/avatars/opus-45.png`   ← 全样本里唯一的图片
 *
 * 后果两条，一条性能一条正确性：
 *   ① 图片通路：`@opus` 命中 1.38MB 猫头像 → 每次 spawn 重传 → 带图腿结构性 +14–46s；
 *   ② 名册/路由示例被改写：猫读到的队友句柄全是文件路径（"在教它 @ 一个 .git ref"）。
 *
 * 形态选择（本机复算，口径见 review-notes/2026-09-28-qoder-at-token-wrapping-dsh.md）：
 *   - 469 处被替换的 token，**后一个字符** ∈ {空格 385, 换行 42, ')' 42}；
 *   - 后一个字符是反引号的句柄 **358 处全部原样幸存，0 处被替换**——其中 30 处与
 *     "同一行里被替换的空格形态"共现（天然 A/B，不是合成用例）。
 *   所以脱敏形态取**反引号包裹**：让每个句柄 token 后面紧跟一个反引号。
 *   （全角 `＠` / 零宽分隔是后备形态，但两者都会被猫模仿成不可路由符号；反引号语义损失最小。）
 *
 * 不碰的东西：
 *   - 真文件引用 `@packages/api/src/x.ts`（后接 `/` 或 `.`）——那是猫的正当意图，留给 CLI 解析；
 *   - 邮箱 `foo@bar.com`（`@` 前是词字符）与路径片段内的 `@`；
 *   - 已经包好的 `` `@x` ``（后一个字符已是反引号）。
 */

/**
 * `@句柄` 词法：`@` 前不能是词字符 / `.` / `@` / `/`（挡邮箱与路径片段），
 * 句柄本体 = ASCII 词（可带 `-`）或 CJK 句柄（`@砚砚` / `@猫名` / `@句柄`）。
 */
const AT_HANDLE = /(?<![\w.@/])@(?:[A-Za-z0-9_][A-Za-z0-9_-]*|[\u4e00-\u9fff][\u4e00-\u9fffA-Za-z0-9_-]*)/g;

/**
 * 把裸 `@句柄` 包成反引号形态，使其后一个字符是反引号——CLI 的文件模糊解析就不会命中。
 *
 * @param text 出境 prompt 原文
 * @returns 脱敏后的 prompt（幂等：已包裹的形态再跑一遍不变）
 */
export function neutralizeAtTokensForFileExpansion(text: string): string {
  if (!text.includes('@')) return text;
  return text.replace(AT_HANDLE, (match: string, offset: number, whole: string) => {
    const next = whole[offset + match.length];
    if (next === '`') return match; // 已包裹：自然数据里这个形态 358/358 幸存
    if (next === '/' || next === '.') return match; // 真文件引用，不抢 CLI 的活
    return `\`${match}\``;
  });
}
