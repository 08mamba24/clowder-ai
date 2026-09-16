/**
 * Qoder (qodercn) CLI NDJSON event parser — 独立方言层（F317 Phase 1）
 *
 * 事件形状与 Claude Code 大面积同构（assistant text/thinking/tool_use、user tool_result、
 * system/init、result），但存在已实证的方言断点（L1 夹具驱动，见
 * packages/api/test/fixtures/qoder/current/ 与 gate-probes/）：
 *   - 无 stream_event（无 partial）→ 不发 agent_loop（I-6 终决）、无 partialText 去重路径
 *   - usage token 字段恒 0，真账是 total_credits + usage.context_usage_ratio（P1-B）
 *   - MCP status 词表含 `disconnected`，须在共享提取前映射为 `failed`（P1-C）
 *   - result.is_error 必须压过 subtype==="success"（auth-error 夹具实证，P1-D）
 *   - 独有事件：system/hook_*、system/artifacts_update、assistant.message.context_management（P1-E，
 *     compact_boundary 冻结中——只透传不接线）
 */

import type { CatId } from '@cat-cafe/shared';
import type { AgentMessage, TokenUsage } from '../../types.js';

/** qoder 独有计费/协议元数据（P1-B：不进 TokenUsage，authoritativeUsage 语义为 false） */
export interface QoderBillingMetadata {
  /** credit 制真账（result.total_credits） */
  credits: number;
  /** result.usage.context_usage_ratio，带 provenance 的比例观测 */
  contextUsageRatio?: number;
  protocolVersion?: string;
  qodercliVersion?: string;
}

/** qoder init.mcp_servers 的 status 词表 → 共享词表（P1-C 前置映射，防静默丢弃） */
const QODER_MCP_STATUS_MAP: Record<string, string> = {
  connected: 'connected',
  disconnected: 'failed',
  failed: 'failed',
};

/**
 * round-11：qodercn 内部工具调用协议跨度（live session 实证：真文本前缀 +
 * 完整 <tool_calls>…</tool_calls> 单块）。协议不是话术——转发前剥离。
 * 仅用于 String.replace（/g 会随 replace 重置 lastIndex，勿改作 test/exec）。
 */
const QODER_TOOLCALLS_SPAN_RE = /<tool_calls>[\s\S]*?<\/tool_calls>/g;

/**
 * round-12（operator 报告，live session a06547db 实证）：Qwen3.8-Max 还会把
 * 单数 Qwen 原生函数调用方言 <tool_call>…</tool_call>（<function=…>/
 * <parameter…> 子标记，实测含畸形 <parameter= 片段）当纯文本吐进 text 块。
 * round-11 复数守护面对它 0 命中——运行中的 #27+P2 dist 红测 verbatim 透传。
 * 剥离语义与 round-11 完全同族。属性变体（<tool_call name="x">）未见实证，不追。
 */
const QODER_TOOL_CALL_SPAN_RE = /<tool_call>[\s\S]*?<\/tool_call>/g;

/**
 * round-11 P2（点点复核）：max-token 截断在协议中间时，CLI 发出的仍是合法
 * JSON 的 text 块——悬空开标签 / 孤尾闭标签剥不出成对跨度。残留协议标记
 * 一律 fail-closed 截断（残余之后的内容一并丢弃，截后为空则不 emit）。
 * 非 /g：只取首个残留位置。round-12 并入单数方言：`s?` 同时覆盖
 * <tool_call(s)> 与 </tool_call(s)> 四种残留形态。
 */
const QODER_TOOL_PROTOCOL_RESIDUE_RE = /<\/?tool_calls?>/;

/**
 * Qoder can report a successful CLI turn while embedding an unexecuted tool request in an
 * assistant text block and/or the terminal result string. The Service uses this signal to reject
 * that false-success terminal; the parser still owns stripping provider-native protocol from
 * user-visible text.
 */
export function qoderEventContainsTextToolProtocol(event: unknown): boolean {
  if (typeof event !== 'object' || event === null) return false;
  const e = event as Record<string, unknown>;
  if (e.type === 'result') {
    return typeof e.result === 'string' && QODER_TOOL_PROTOCOL_RESIDUE_RE.test(e.result);
  }
  if (e.type !== 'assistant') return false;
  const message = e.message as Record<string, unknown> | undefined;
  if (!Array.isArray(message?.content)) return false;
  return message.content.some((block) => {
    if (typeof block !== 'object' || block === null) return false;
    const b = block as Record<string, unknown>;
    return b.type === 'text' && typeof b.text === 'string' && QODER_TOOL_PROTOCOL_RESIDUE_RE.test(b.text);
  });
}

export function mapQoderMcpStatus(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  return QODER_MCP_STATUS_MAP[raw];
}

/**
 * P1-H 版本断言分轨：protocol_version 未知 → fail closed（事件形状是承重墙）；
 * qodercli_version 漂移仅返回告警（由调用方记日志）。
 */
export function checkQoderProtocolVersion(
  initEvent: unknown,
): { ok: true; cliDrift?: string } | { ok: false; reason: string } {
  if (typeof initEvent !== 'object' || initEvent === null) return { ok: false, reason: 'init event missing' };
  const e = initEvent as Record<string, unknown>;
  const pv = e.protocol_version;
  if (pv !== '1.4.0') {
    return { ok: false, reason: `unsupported protocol_version: ${String(pv)}` };
  }
  const cli = e.qodercli_version;
  if (typeof cli === 'string' && cli !== '1.1.51') return { ok: true, cliDrift: `qodercli ${cli} != 1.1.51` };
  return { ok: true };
}

/**
 * Transform a raw qodercn NDJSON event into AgentMessage(s).
 * Returns null to skip events we don't care about (result/success terminal, builtin hook noise
 * is surfaced as system_info per P1-E passthrough).
 */
export function transformQoderEvent(event: unknown, catId: CatId): AgentMessage | AgentMessage[] | null {
  if (typeof event !== 'object' || event === null) return null;
  const e = event as Record<string, unknown>;

  // system/init → session_init (+ MCP status 前置映射)
  if (e.type === 'system' && e.subtype === 'init') {
    const sessionId = e.session_id;
    if (typeof sessionId !== 'string') return null;
    const sessionInit = {
      type: 'session_init',
      catId,
      sessionId,
      timestamp: Date.now(),
    } satisfies AgentMessage;
    const servers = Array.isArray(e.mcp_servers) ? e.mcp_servers : [];
    const mapped = servers
      .map((s) => {
        if (typeof s !== 'object' || s === null) return null;
        const rec = s as Record<string, unknown>;
        const name = typeof rec.name === 'string' ? rec.name : null;
        const status = mapQoderMcpStatus(rec.status);
        return name ? { name, status: status ?? 'unknown' } : null;
      })
      .filter((x): x is { name: string; status: string } => x !== null);
    if (mapped.length === 0) return sessionInit;
    return [
      sessionInit,
      {
        type: 'system_info',
        catId,
        content: JSON.stringify({
          type: 'mcp_server_status',
          provider: 'qoder',
          catId,
          sessionId,
          servers: mapped,
        }),
        timestamp: Date.now(),
      },
    ];
  }

  // P1-E 透传：system/hook_* 与 system/artifacts_update → system_info（诊断可见，不参与语义）
  if (
    e.type === 'system' &&
    (e.subtype === 'hook_started' || e.subtype === 'hook_progress' || e.subtype === 'hook_response')
  ) {
    return {
      type: 'system_info',
      catId,
      content: JSON.stringify({
        type: 'qoder_hook',
        catId,
        hookName: typeof e.hook_name === 'string' ? e.hook_name : undefined,
        hookEvent: typeof e.hook_event === 'string' ? e.hook_event : undefined,
        subtype: e.subtype,
        exitCode: typeof e.exit_code === 'number' ? e.exit_code : undefined,
      }),
      timestamp: Date.now(),
    };
  }
  if (e.type === 'system' && e.subtype === 'artifacts_update') {
    return {
      type: 'system_info',
      catId,
      content: JSON.stringify({ type: 'qoder_artifacts_update', catId }),
      timestamp: Date.now(),
    };
  }

  // assistant → text / thinking / tool_use（同构块；无 partial 去重——qoder 无 stream_event）
  if (e.type === 'assistant') {
    const message = e.message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (!Array.isArray(content)) return null;
    // P1-E：context_management 字段只透传（compact_boundary 冻结中，不接 provider_signal）
    const contextManagement = message?.context_management;
    const messages: AgentMessage[] = [];
    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue;
      const b = block as Record<string, unknown>;
      if (b.type === 'text' && typeof b.text === 'string' && b.text.length > 0) {
        // round-11（operator 报告，live session 实证）：qodercn 把内部工具调用协议
        // <tool_calls>…</tool_calls> 作为 assistant text 块发出——协议不是话术，
        // 剥离后才转发；剥空（纯协议块）不 emit；无协议的普通文本逐字透传。
        // round-11 P2 + round-12：剥离成对跨度（复数与单数方言，复数先行——
        // 若单数块嵌在复数跨度内会被外层一次性剥掉）后仍残留协议标记
        // （悬空开/孤尾闭，任一方言）→ fail-closed 截断，残余之后的内容一并丢弃。
        const stripped = b.text.replace(QODER_TOOLCALLS_SPAN_RE, '').replace(QODER_TOOL_CALL_SPAN_RE, '');
        const residueIdx = stripped.search(QODER_TOOL_PROTOCOL_RESIDUE_RE);
        let content: string;
        if (residueIdx >= 0) {
          content = stripped.slice(0, residueIdx).trim();
        } else {
          content = stripped === b.text ? b.text : stripped.trim();
        }
        if (content.length > 0) {
          messages.push({ type: 'text', catId, content, timestamp: Date.now() });
        }
      } else if (b.type === 'tool_use' && typeof b.name === 'string') {
        const msg: AgentMessage = {
          type: 'tool_use',
          catId,
          toolName: b.name,
          toolInput: (b.input as Record<string, unknown>) ?? {},
          timestamp: Date.now(),
        };
        if (typeof b.id === 'string') msg.toolUseId = b.id;
        messages.push(msg);
      }
    }
    if (messages.length === 0 && contextManagement != null) {
      // assistant 仅有 context_management 时的最小透传，防静默丢事件
      return {
        type: 'system_info',
        catId,
        content: JSON.stringify({ type: 'qoder_context_management', catId, value: contextManagement }),
        timestamp: Date.now(),
      };
    }
    return messages.length > 0 ? messages : null;
  }

  // result：is_error 压过 subtype（auth-error 夹具实证：is_error:true 但 subtype:"success"）
  if (isQoderResultErrorEvent(e)) {
    const rawErrors = Array.isArray(e.errors) ? e.errors : [];
    const errors = rawErrors.filter((item): item is string => typeof item === 'string').join('; ');
    const resultText = typeof e.result === 'string' ? e.result : '';
    const subtype = typeof e.subtype === 'string' ? e.subtype : undefined;
    const fallbackError = subtype ? `Qoder result error (${subtype})` : 'Unknown qoder error';
    return {
      type: 'error',
      catId,
      error: errors || resultText || fallbackError,
      content: JSON.stringify({ errorSubtype: subtype, isError: e.is_error === true }),
      timestamp: Date.now(),
    };
  }

  // result/success 终态由 Service 消费（usage 提取），parser 不重复产出
  return null;
}

export function isQoderResultErrorEvent(event: unknown): boolean {
  if (typeof event !== 'object' || event === null) return false;
  const e = event as Record<string, unknown>;
  return e.type === 'result' && e.is_error === true;
}

/**
 * P1-B：qoder 的 result.usage token 字段恒 0 —— TokenUsage 只承载非零可靠字段，
 * 真账（credits/context_usage_ratio）走独立 QoderBillingMetadata。
 * modelUsage.contextWindow 为 camelCase 且实测可为 0 —— `> 0` 守卫防污染 contextWindowSize。
 */
export function extractQoderUsage(e: Record<string, unknown>): {
  usage: TokenUsage;
  billing: QoderBillingMetadata;
} {
  const usage: TokenUsage = {};
  const billing: QoderBillingMetadata = { credits: 0 };

  if (typeof e.total_credits === 'number') billing.credits = e.total_credits;
  const rawUsage = (e.usage ?? {}) as Record<string, unknown>;
  if (typeof rawUsage.context_usage_ratio === 'number') billing.contextUsageRatio = rawUsage.context_usage_ratio;
  if (typeof e.protocol_version === 'string') billing.protocolVersion = e.protocol_version;
  if (typeof e.qodercli_version === 'string') billing.qodercliVersion = e.qodercli_version;

  if (typeof e.total_cost_usd === 'number' && e.total_cost_usd > 0) usage.costUsd = e.total_cost_usd;
  if (typeof e.duration_ms === 'number') usage.durationMs = e.duration_ms;
  if (typeof e.duration_api_ms === 'number') usage.durationApiMs = e.duration_api_ms;
  if (typeof e.num_turns === 'number') usage.numTurns = e.num_turns;

  const modelUsage = e.modelUsage as Record<string, Record<string, unknown>> | undefined;
  if (modelUsage) {
    for (const data of Object.values(modelUsage)) {
      const contextWindow = typeof data.contextWindow === 'number' ? data.contextWindow : undefined;
      if (contextWindow != null && contextWindow > 0) {
        usage.contextWindowSize = contextWindow;
        break;
      }
    }
  }

  return { usage, billing };
}
