/**
 * F317 Phase 1: qoder-ndjson-parser 夹具驱动测试
 * 夹具 = L1 真实采集一代（packages/api/test/fixtures/qoder/current/，verifier 校验过的 generation）
 * + gate-probes（cancel / mcp-mount）+ 方言陷阱负向用例（auth-error 的 subtype 陷阱等）
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, 'fixtures', 'qoder');

// dist 产物（先 build:packages 或指向 src 编译输出）
const {
  transformQoderEvent,
  isQoderResultErrorEvent,
  extractQoderUsage,
  checkQoderProtocolVersion,
  mapQoderMcpStatus,
  qoderEventContainsTextToolProtocol,
} = await import(
  process.env.QODER_PARSER_SRC
    ? '../src/domains/cats/services/agents/providers/qoder-ndjson-parser.ts'
    : '../dist/domains/cats/services/agents/providers/qoder-ndjson-parser.js'
);

const CAT = 'cat_test_qoder';
const loadJsonl = (p) =>
  readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

// 活跃 generation 的夹具（current -> .gen-<hash>/）
const currentDir = join(FIXTURES, 'current');
const readFixture = (name) => loadJsonl(join(currentDir, `${name}.jsonl`));

test('fixture generation is present and parseable', () => {
  const files = readdirSync(currentDir).filter((f) => f.endsWith('.jsonl'));
  assert.ok(files.length >= 9, `expected >=9 fixtures, got ${files.length}`);
});

test('system/init -> session_init + mcp status with dialect mapping', () => {
  // mcp-mount 在 gate-probes 下；这里用 hook-green-project（含 init）
  const initRow = readFixture('hook-green-project').find((r) => r.subtype === 'init');
  assert.ok(initRow, 'init event present');
  const out = transformQoderEvent(initRow, CAT);
  const sessionInit = Array.isArray(out) ? out[0] : out;
  assert.equal(sessionInit.type, 'session_init');
  assert.equal(typeof sessionInit.sessionId, 'string');
});

test('mcp status vocabulary: disconnected maps to failed (P1-C)', () => {
  assert.equal(mapQoderMcpStatus('disconnected'), 'failed');
  assert.equal(mapQoderMcpStatus('connected'), 'connected');
  assert.equal(mapQoderMcpStatus('weird-status'), undefined);
  const init = {
    type: 'system',
    subtype: 'init',
    session_id: 's1',
    mcp_servers: [{ name: 'x', status: 'disconnected' }],
  };
  const out = transformQoderEvent(init, CAT);
  const payload = JSON.parse(out[1].content);
  assert.equal(payload.servers[0].status, 'failed');
});

test('assistant text/thinking/tool_use blocks pass through (isomorphic)', () => {
  const rows = readFixture('tool-use');
  const events = rows.flatMap((r) => {
    const out = transformQoderEvent(r, CAT);
    return out == null ? [] : Array.isArray(out) ? out : [out];
  });
  const toolUse = events.find((m) => m.type === 'tool_use');
  assert.ok(toolUse, 'tool_use emitted');
  assert.equal(toolUse.toolName, 'Read');
  assert.equal(typeof toolUse.toolUseId, 'string');
});

test('auth-error dialect trap: is_error=true overrides subtype==="success" (P1-D)', () => {
  const rows = readFixture('auth-error');
  const resultRow = rows.find((r) => r.type === 'result');
  assert.equal(resultRow.subtype, 'success', 'fixture proves the trap shape');
  assert.equal(resultRow.is_error, true);
  assert.equal(isQoderResultErrorEvent(resultRow), true);
  const out = transformQoderEvent(resultRow, CAT);
  assert.equal(out.type, 'error');
});

test('permission denial: tool_result is_error is NOT an invocation error (terminal structured fields unreliable)', () => {
  const rows = readFixture('permission-denial');
  const resultRow = rows.find((r) => r.type === 'result');
  // 终态 result 是成功 invocation（is_error:false）——判错只认 is_error
  assert.equal(isQoderResultErrorEvent(resultRow), false);
  const out = transformQoderEvent(resultRow, CAT);
  assert.equal(out, null);
});

test('usage dialect: token fields are 0, credits are the real account (P1-B)', () => {
  const rows = readFixture('success');
  const resultRow = rows.find((r) => r.type === 'result');
  const { usage, billing } = extractQoderUsage(resultRow);
  // TokenUsage 不得含伪 token 数（result.usage 全 0）
  assert.equal(usage.inputTokens, undefined);
  assert.ok(billing.credits > 0, `credits captured: ${billing.credits}`);
  assert.ok(typeof resultRow.usage.context_usage_ratio === 'number');
});

test('contextWindow:0 guard — must not pollute contextWindowSize', () => {
  const rows = readFixture('silent-model-fallback');
  const resultRow = rows.find((r) => r.type === 'result');
  assert.equal(resultRow.modelUsage.auto.contextWindow, 0, 'fixture proves the zero shape');
  const { usage } = extractQoderUsage(resultRow);
  assert.equal(usage.contextWindowSize, undefined);
});

test('protocol version gate: known passes, unknown fails closed (P1-H)', () => {
  assert.equal(checkQoderProtocolVersion({ protocol_version: '1.4.0' }).ok, true);
  const bad = checkQoderProtocolVersion({ protocol_version: '2.0.0' });
  assert.equal(bad.ok, false);
  const drift = checkQoderProtocolVersion({ protocol_version: '1.4.0', qodercli_version: '1.2.0' });
  assert.equal(drift.ok, true);
  assert.match(drift.cliDrift, /1\.2\.0/);
});

test('qoder-only events pass through as system_info (P1-E), agent_loop never emitted (I-6)', () => {
  const rows = readFixture('success');
  const events = rows.flatMap((r) => {
    const out = transformQoderEvent(r, CAT);
    return out == null ? [] : Array.isArray(out) ? out : [out];
  });
  assert.equal(
    events.some((m) => m.type === 'agent_loop'),
    false,
    'I-6: agent_loop must not be emitted',
  );
  const hookInfo = events.find((m) => m.type === 'system_info' && JSON.parse(m.content).type === 'qoder_hook');
  assert.ok(hookInfo, 'hook events surfaced as system_info');
});

test('cancel signature from gate probe: graceful cancel still emits terminal result', () => {
  const rows = loadJsonl(join(FIXTURES, 'gate-probes', 'cancel.jsonl'));
  // 修正后的事实：SIGINT = 优雅取消，终态 result 正常收尾（exit 130 由 wrapper 体现）
  assert.equal(
    rows.some((r) => r.type === 'result'),
    true,
    'terminal result present',
  );
  const resultRow = rows.find((r) => r.type === 'result');
  assert.equal(isQoderResultErrorEvent(resultRow), false);
  const events = rows.flatMap((r) => {
    const out = transformQoderEvent(r, CAT);
    return out == null ? [] : Array.isArray(out) ? out : [out];
  });
  assert.equal(
    events.some((m) => m.type === 'error'),
    false,
  );
});

// ══ round-11（tool_calls 协议泄漏：operator 报告，live session 33e27ba4 实证形状）═══
// qodercn 把内部工具调用协议 <tool_calls>…</tool_calls> 作为 assistant text 块
// 发出（真文本前缀 + 完整跨度，实测 641 字符单块），解析器曾原样透传 → 协议
// 原文漏进 thread。修复语义：剥离协议跨度、保留真文本；纯协议块不 emit；
// 无协议的普通文本逐字透传不受影响。夹具为形状复刻（合成），不回灌项目数据。
// P3-1（点点复核）：真实样本内部是 2-3 个 <tool> 条目，夹具同形状。
const TOOLCALLS_BLOCK = [
  '<tool_calls>',
  '<tool>',
  '<tool_name>bash</tool_name>',
  '<command>which qodercn 2>/dev/null || echo "not in PATH"</command>',
  '<description>Find qodercn binary location</description>',
  '</tool>',
  '<tool>',
  '<tool_name>bash</tool_name>',
  '<command>ls -la /Users/yuhan/.qoder-cn/ 2>/dev/null || echo "no qoder config dir found"</command>',
  '<description>Check qoder config directory</description>',
  '</tool>',
  '</tool_calls>',
].join('\n');

test('round11: assistant text with an embedded <tool_calls> span forwards only the real text', () => {
  const event = {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: `谱谱传球接到。我来查可用的模型清单。\n\n${TOOLCALLS_BLOCK}` }],
    },
  };
  const out = transformQoderEvent(event, CAT);
  const texts = (Array.isArray(out) ? out : [out]).filter((m) => m && m.type === 'text');
  assert.equal(texts.length, 1, 'exactly one real-text message');
  assert.equal(texts[0].content, '谱谱传球接到。我来查可用的模型清单。');
  assert.ok(!texts[0].content.includes('<tool'), 'no protocol markup leaks');
});

test('round11: assistant text that is ONLY a <tool_calls> span emits no text message', () => {
  const event = {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: TOOLCALLS_BLOCK }] },
  };
  const out = transformQoderEvent(event, CAT);
  assert.equal(out, null, 'protocol-only text must not become a chat message');
});

test('round11: plain text without protocol spans passes through unchanged (control)', () => {
  const event = {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: '普通回复，含 < 尖括号但不是协议' }] },
  };
  const out = transformQoderEvent(event, CAT);
  const texts = (Array.isArray(out) ? out : [out]).filter((m) => m && m.type === 'text');
  assert.equal(texts.length, 1);
  assert.equal(texts[0].content, '普通回复，含 < 尖括号但不是协议');
});

// round-11 P2（点点复核）：max-token 截断在协议中间时，CLI 发出的仍是合法
// JSON 的 text 块——悬空开标签（有 <tool_calls> 无闭）与孤尾（</tool_calls>
// 无开）曾整段回退旧行为=原样透传泄漏。语义：剥离成对跨度后若仍残留协议
// 标记，fail-closed 截断（截后为空则不 emit），残余之后的内容一并丢弃。
test('round11 P2: dangling unclosed <tool_calls> truncates fail-closed at the marker', () => {
  const truncated = TOOLCALLS_BLOCK.slice(0, TOOLCALLS_BLOCK.indexOf('</tool_calls>'));
  const event = {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: `我先查一下再回。\n\n${truncated}` }] },
  };
  const out = transformQoderEvent(event, CAT);
  const texts = (Array.isArray(out) ? out : [out]).filter((m) => m && m.type === 'text');
  assert.equal(texts.length, 1, 'text before the dangling marker survives');
  assert.equal(texts[0].content, '我先查一下再回。');
  assert.ok(!texts[0].content.includes('<tool'), 'no protocol markup leaks from a truncated block');
});

test('round11 P2: orphan </tool_calls> tail truncates fail-closed at the marker', () => {
  const event = {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: '结论在前。\n</tool_calls>\n截断后不应再出现的内容' }],
    },
  };
  const out = transformQoderEvent(event, CAT);
  const texts = (Array.isArray(out) ? out : [out]).filter((m) => m && m.type === 'text');
  assert.equal(texts.length, 1);
  assert.equal(texts[0].content, '结论在前。');
  assert.ok(!texts[0].content.includes('tool_calls'), 'orphan tail and everything after it are dropped');
});

// ══ round-12（tool_call 单数方言泄漏：operator 报告，live session a06547db 实证形状）═══
// 2026-09-16：Qwen3.8-Max 经 qodercn 把 Qwen 原生函数调用方言 <tool_call>…
// </tool_call>（<function=…>/<parameter…> 子标记，实测含畸形 <parameter= 片段）
// 当纯文本吐进 assistant text 块（stop_reason end_turn）。round-11 的复数
// <tool_calls> 守护面对它 0 命中——红测实证：运行中的 #27+P2 dist 对 live
// 样本 verbatim 转发（protocol leaked: true）。语义与 round-11 完全同族：
// 剥离成对跨度、剥空不 emit、残留 fail-closed 截断。夹具为形状复刻（合成
// 描述文本），不回灌项目数据。
const TOOL_CALL_BLOCK = [
  '<tool_call>',
  '<function=Bash>',
  '<parameter=',
  '<parameter name="description">Probe environment prerequisites for the queued check',
  '</parameter>',
  '</function>',
  '</tool_call>',
].join('\n');

test('round12: live-shape singular <tool_call> span forwards only the real text', () => {
  const event = {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: `收到传球。先检查环境和凭证。\n\n${TOOL_CALL_BLOCK}` }],
    },
  };
  const out = transformQoderEvent(event, CAT);
  const texts = (Array.isArray(out) ? out : [out]).filter((m) => m && m.type === 'text');
  assert.equal(texts.length, 1, 'exactly one real-text message');
  assert.equal(texts[0].content, '收到传球。先检查环境和凭证。');
  assert.ok(!texts[0].content.includes('<tool'), 'singular dialect must not leak');
});

test('round12: protocol-only singular <tool_call> block emits no text message', () => {
  const event = {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: TOOL_CALL_BLOCK }] },
  };
  const out = transformQoderEvent(event, CAT);
  assert.equal(out, null, 'protocol-only singular block must not become a chat message');
});

test('round12: dangling unclosed <tool_call> truncates fail-closed at the marker', () => {
  const truncated = TOOL_CALL_BLOCK.slice(0, TOOL_CALL_BLOCK.indexOf('</tool_call>'));
  const event = {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: `我先查一下再回。\n\n${truncated}` }] },
  };
  const out = transformQoderEvent(event, CAT);
  const texts = (Array.isArray(out) ? out : [out]).filter((m) => m && m.type === 'text');
  assert.equal(texts.length, 1, 'text before the dangling marker survives');
  assert.equal(texts[0].content, '我先查一下再回。');
  assert.ok(!texts[0].content.includes('<tool'), 'truncated singular block must not leak');
});

test('round12: orphan </tool_call> tail truncates fail-closed at the marker', () => {
  const event = {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: '结论在前。\n</tool_call>\n截断后不应再出现的内容' }],
    },
  };
  const out = transformQoderEvent(event, CAT);
  const texts = (Array.isArray(out) ? out : [out]).filter((m) => m && m.type === 'text');
  assert.equal(texts.length, 1);
  assert.equal(texts[0].content, '结论在前。');
  assert.ok(!texts[0].content.includes('tool_call'), 'orphan tail and everything after it are dropped');
});

test('round12 control: plural and singular spans in one block both strip, real text survives', () => {
  const plural = [
    '<tool_calls>',
    '<tool>',
    '<tool_name>bash</tool_name>',
    '<command>which qodercn</command>',
    '</tool>',
    '</tool_calls>',
  ].join('\n');
  const event = {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: `前文\n\n${plural}\n中间真文本\n\n${TOOL_CALL_BLOCK}\n后文` }],
    },
  };
  const out = transformQoderEvent(event, CAT);
  const texts = (Array.isArray(out) ? out : [out]).filter((m) => m && m.type === 'text');
  assert.equal(texts.length, 1);
  assert.ok(!texts[0].content.includes('<tool'), 'neither dialect leaks');
  assert.match(texts[0].content, /^前文/);
  assert.match(texts[0].content, /后文$/);
  assert.ok(texts[0].content.includes('中间真文本'), 'real text between spans survives');
});

// ══ round-13（点点复审 P3-1：围栏内正当引用协议被吞——round-12 新引入的
// 假阳性面）═══ 猫在正文里用 ``` 围栏引用协议原文（讨论/教学场景）曾被整段
// 剥掉。收窄语义：完整成对 ``` 围栏段视为引用，原样保留、不参与剥离与
// 残留守护；围栏外协议照旧剥离。未闭合围栏（截断）不豁免——余下内容仍按
// 正文规则 fail-closed，保持 round-11 P2 语义。缩进/~~~ 围栏未见实证，不追。
test('round13: protocol quoted inside a fenced code block survives verbatim', () => {
  const text = `讨论一下这个方言：\n\n\`\`\`\n${TOOL_CALL_BLOCK}\n\`\`\`\n\n如上，别在正文里直接发。`;
  const event = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } };
  const out = transformQoderEvent(event, CAT);
  const texts = (Array.isArray(out) ? out : [out]).filter((m) => m && m.type === 'text');
  assert.equal(texts.length, 1, 'quoted protocol is not a leak — message survives');
  assert.equal(texts[0].content, text, 'fenced quote passes through byte-for-byte');
});

test('round13: protocol outside fences still strips when a fence is present', () => {
  const text = `先看示例：\n\n\`\`\`bash\nwhich qodercn\n\`\`\`\n\n然后执行：\n\n${TOOL_CALL_BLOCK}`;
  const event = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } };
  const out = transformQoderEvent(event, CAT);
  const texts = (Array.isArray(out) ? out : [out]).filter((m) => m && m.type === 'text');
  assert.equal(texts.length, 1);
  assert.ok(!texts[0].content.includes('<tool'), 'protocol outside the fence still strips');
  assert.ok(texts[0].content.includes('```bash'), 'fence itself survives');
  assert.ok(texts[0].content.includes('which qodercn'), 'fenced content survives');
  assert.match(texts[0].content, /然后执行：$/);
});

test('round13: residue after a fence still truncates fail-closed (message-level)', () => {
  const dangling = TOOL_CALL_BLOCK.slice(0, TOOL_CALL_BLOCK.indexOf('</tool_call>'));
  const text = `前文。\n\n\`\`\`bash\nwhich qodercn\n\`\`\`\n\n收尾一句。\n\n${dangling}\n截断后不应再出现的内容`;
  const event = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } };
  const out = transformQoderEvent(event, CAT);
  const texts = (Array.isArray(out) ? out : [out]).filter((m) => m && m.type === 'text');
  assert.equal(texts.length, 1);
  assert.ok(texts[0].content.includes('```bash'), 'fence before the residue survives');
  assert.ok(!texts[0].content.includes('<tool'), 'dangling marker never leaks');
  assert.ok(!texts[0].content.includes('截断后不应再出现的内容'), 'everything after the residue is dropped');
});

test('round13: unclosed fence is not exempt — residue rules still apply to its tail', () => {
  const text = `开始引用：\n\n\`\`\`\n${TOOL_CALL_BLOCK}`;
  const event = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } };
  const out = transformQoderEvent(event, CAT);
  const texts = (Array.isArray(out) ? out : [out]).filter((m) => m && m.type === 'text');
  assert.equal(texts.length, 1);
  assert.ok(!texts[0].content.includes('<tool'), 'protocol inside an unclosed fence still strips (not exempt)');
  assert.match(texts[0].content, /^开始引用：/, 'text before the unclosed fence survives');
});

// ══ round-14（点点复审 F1/F2：① 豁免谓词过宽——孤儿 ``` 与后续闭栏并段后
// 整段被豁免，裸协议原样漏出；② gate detector 裸扫原文无围栏感知——围栏内
// 正当引用照样把 turn 判死）═══ 修法：围栏判定改逐行状态机（行首 ``` 翻转
// 开/闭），任何未闭合 → 全消息丧失豁免（fail-closed）；detector 与 parser
// 共用同一剥离 helper（单一真相源）。
test('round14 F2: a closed fence elsewhere does not exempt an unclosed fence tail (A7)', () => {
  const text = `start\n\`\`\`\n${TOOL_CALL_BLOCK}\n\n\`\`\`\nok\n\`\`\``;
  const event = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } };
  const out = transformQoderEvent(event, CAT);
  const texts = (Array.isArray(out) ? out : [out]).filter((m) => m && m.type === 'text');
  assert.equal(texts.length, 1);
  assert.ok(!texts[0].content.includes('<tool'), 'unclosed fence tail must not be exempt — protocol strips');
  assert.match(texts[0].content, /^start/, 'text before the first fence survives');
});

test('round14 F2: bare protocol near odd fences strips (A4/A5 shapes)', () => {
  const mid = `一\n\`\`\`a\nx\n\`\`\`\n二\n\`\`\`\n${TOOL_CALL_BLOCK}`;
  const tail = `一\n\`\`\`\n${TOOL_CALL_BLOCK}\n\`\`\`\n二\n\`\`\`\nbare tail`;
  for (const text of [mid, tail]) {
    const event = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } };
    const out = transformQoderEvent(event, CAT);
    const texts = (Array.isArray(out) ? out : [out]).filter((m) => m && m.type === 'text');
    assert.equal(texts.length, 1);
    assert.ok(!texts[0].content.includes('<tool'), 'bare protocol never rides a neighboring fence exemption');
  }
});

test('round14 F1: fenced quote does not trip the unexecuted-tool gate', () => {
  const text = `讨论方言：\n\n\`\`\`\n${TOOL_CALL_BLOCK}\n\`\`\`\n\n如上。`;
  const event = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } };
  assert.equal(
    qoderEventContainsTextToolProtocol(event),
    false,
    'a legitimate fenced quote must not fail the turn (gate shares the fence-aware strip)',
  );
});

test('round14 F1: bare protocol still trips the unexecuted-tool gate', () => {
  const text = `先这样。\n\n${TOOL_CALL_BLOCK}`;
  const event = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } };
  assert.equal(qoderEventContainsTextToolProtocol(event), true, 'bare protocol outside fences still gates');
});

test('round14 F1 control: protocol outside a balanced fence still trips the gate', () => {
  const text = `示例：\n\n\`\`\`bash\nls\n\`\`\`\n\n然后：\n\n${TOOL_CALL_BLOCK}`;
  const event = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } };
  assert.equal(qoderEventContainsTextToolProtocol(event), true);
});

// ══ round-15（点点复审 round-14 的 P1/P2/P3：segment-join 在消息贴围栏边界时
// 注入原文没有的 \n，detector 的裸字符串不等比较把格式漂移读成协议剥离——
// 真实夹具（纯围栏零协议）端到端把 turn 判死。修法：行数组重建 + 显式
// removed 布尔，detector 用布尔不用字符串比较；闭合栏谓词收紧为裸栏）═══
test('round15 P1: fence-only text (no protocol at all) must not gate', () => {
  const text = '```\nF317-DETERMINISTIC-LINE-1\n```'; // 逐字取自 current/tool-use.jsonl
  assert.equal(
    qoderEventContainsTextToolProtocol({ type: 'assistant', message: { content: [{ type: 'text', text }] } }),
    false,
  );
  assert.equal(qoderEventContainsTextToolProtocol({ type: 'result', result: text }), false);
});

test('round15 P2: a legit fenced quote that ends the message must not gate', () => {
  const text = `讨论：\n\n\`\`\`\n${TOOL_CALL_BLOCK}\n\`\`\``;
  assert.equal(
    qoderEventContainsTextToolProtocol({ type: 'assistant', message: { content: [{ type: 'text', text }] } }),
    false,
  );
});

test('round15 P2: a legit fenced quote that starts the message must not gate', () => {
  const text = `\`\`\`\n${TOOL_CALL_BLOCK}\n\`\`\`\n\n补充说明在后面。`;
  assert.equal(
    qoderEventContainsTextToolProtocol({ type: 'assistant', message: { content: [{ type: 'text', text }] } }),
    false,
  );
});

test('round15 P1: fence-boundary messages without protocol pass through byte-identical', () => {
  const trailing = 'a\n```\nb\n```';
  const leading = '```\nb\n```\na';
  for (const text of [trailing, leading]) {
    const event = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } };
    const out = transformQoderEvent(event, CAT);
    const texts = (Array.isArray(out) ? out : [out]).filter((m) => m && m.type === 'text');
    assert.equal(texts.length, 1);
    assert.equal(texts[0].content, text, 'no injected separators — byte-identical passthrough');
    assert.equal(qoderEventContainsTextToolProtocol(event), false);
  }
});

test('round15 P3: adjacent fences keep byte-identical spacing', () => {
  const text = 'a\n```\nb\n```\n```\nc\n```';
  const event = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } };
  const out = transformQoderEvent(event, CAT);
  const texts = (Array.isArray(out) ? out : [out]).filter((m) => m && m.type === 'text');
  assert.equal(texts.length, 1);
  assert.equal(texts[0].content, text);
  assert.equal(qoderEventContainsTextToolProtocol(event), false);
});

test('round15 P3: info-string line inside a fence is content, not a closer', () => {
  const text = `\
\`\`\`\`markdown
\`\`\`js
${TOOL_CALL_BLOCK}
\`\`\`\``;
  const event = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } };
  assert.equal(qoderEventContainsTextToolProtocol(event), false, 'pseudo-closer must not void the exemption');
  const out = transformQoderEvent(event, CAT);
  const texts = (Array.isArray(out) ? out : [out]).filter((m) => m && m.type === 'text');
  assert.equal(texts.length, 1);
  assert.ok(texts[0].content.includes('<tool_call>'), 'quoted protocol inside the outer fence stays verbatim');
});
