/**
 * F317 Phase 1 Slice 1: 窄 QoderAgentService（非路由）
 *
 * I-4 边界：typed 构造注入（catId / binary / I-11 profile + fs）；缺 workingDirectory fail closed。
 * 安全硬编码（提案 + L1 实证 + Slice 1 review 修正）：
 *   - prompt 走 stdin（`-p -`，2026-09-13 一手验证通过），argv 不携带正文（进程表泄露消除）
 *   - permission mode 不传（CLI 默认 default），init.permissionMode 断言
 *   - `--tools ""` + strict deny-all MCP；init 门精确断言 tools==[] / mcp_servers==[] /
 *     protocol_version（fail closed）/ model（Auto fallback 规则），先于任何 assistant 事件
 *   - env 大小写归一剥离 qoder 前缀 + 拒绝 Node/Dyld 注入变量（NODE_OPTIONS 等），
 *     安全控制仅由本 Service 最终写入；CONFIG_DIR 只经构造注入
 *   - result.is_error 分流（auth-error 夹具实证 subtype:"success" 陷阱）；
 *     done 仅在「成功 result + exit 0」后发出；exit code/stderr/spawn error 全部进诊断
 *   - AbortSignal：取消即 SIGTERM；spawn ENOENT 事件显式处理
 */

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { CatId } from '@cat-cafe/shared';
import type { AgentMessage, AgentService, AgentServiceOptions, TokenUsage } from '../../types.js';
import {
  checkQoderProtocolVersion,
  extractQoderUsage,
  isQoderResultErrorEvent,
  type QoderBillingMetadata,
  transformQoderEvent,
} from './qoder-ndjson-parser.js';
import { auditQoderProfile, defaultQoderProfileFs, type QoderProfileFs } from './qoder-runtime-profile.js';

/** qoder pilot 允许的唯一 permission mode（bypass_permissions/auto 硬编码禁用） */
const REQUIRED_PERMISSION_MODE = 'default';
/** Slice 1 read-only pilot 的预期工具/MCP 面：全空（I-10 预授权在后续 slice 解锁） */
const EXPECTED_EMPTY_TOOLS: string[] = [];
const EXPECTED_EMPTY_MCP: string[] = [];

/** Node/动态链接器注入变量：任意 preload 会在所有安全门之前执行，一律拒绝 */
const DENIED_ENV_KEYS = new Set([
  'NODE_OPTIONS',
  'NODE_PRELOAD',
  'NODE_REQUIRE_MODULE',
  'ELECTRON_RUN_AS_NODE',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
]);

export interface QoderAgentServiceConfig {
  catId: CatId;
  /** I-11 runtime profile 目录（由 resolver 经 ensureQoderRuntimeProfile 提供并审计） */
  profileDir: string;
  /** 可选覆盖 binary（默认 resolveCliCommand('qodercn')；测试注入用） */
  binary?: string;
  /** 注入 spawn（测试） */
  spawnFn?: (cmd: string, args: string[], opts: object) => ChildProcessWithoutNullStreams;
  /** 注入 profile 审计文件系统（测试；默认真实 fs） */
  profileFs?: QoderProfileFs;
}

/** 构造 qodercn argv（无 prompt 正文——stdin 通道）。导出供单测锁定安全 flag 全集。 */
export function buildQoderArgs(input: { profileDir: string; sessionId?: string }): string[] {
  const args = ['-p', '-', '-o', 'stream-json', '--config-dir', input.profileDir];
  if (input.sessionId) args.push('-r', input.sessionId);
  args.push('--strict-mcp-config', '--allowed-mcp-server-names', 'nothing', '--tools', '', '--setting-sources', 'user');
  return args;
}

/** 大小写归一剥离 qoder 控制前缀 + 拒绝 Node/Dyld 注入变量（CONFIG_DIR 只能来自构造注入） */
export function sanitizeQoderEnv(env: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (DENIED_ENV_KEYS.has(k)) continue;
    if (k.toLowerCase().startsWith('qoder')) continue; // qodercn / qoder / Qodercn_* 全形态
    clean[k] = v;
  }
  return clean;
}

/**
 * init 事件门（任何 assistant 事件之前执行，fail closed）：
 * protocol_version / permissionMode / model（Auto fallback 规则）/ 空 tools / 空 MCP。
 */
export function qoderInitGate(
  initEvent: unknown,
  requestedModel?: string,
): { ok: true; cliDrift?: string; model?: string } | { ok: false; reason: string } {
  const version = checkQoderProtocolVersion(initEvent);
  if (!version.ok) return version;
  if (typeof initEvent !== 'object' || initEvent === null) return { ok: false, reason: 'init missing' };
  const e = initEvent as Record<string, unknown>;
  if (e.permissionMode !== REQUIRED_PERMISSION_MODE) {
    return { ok: false, reason: `permissionMode ${String(e.permissionMode)} != ${REQUIRED_PERMISSION_MODE}` };
  }
  const tools = e.tools;
  if (JSON.stringify(tools ?? []) !== JSON.stringify(EXPECTED_EMPTY_TOOLS)) {
    return { ok: false, reason: `tools not empty: ${JSON.stringify(tools)}` };
  }
  const mcp = e.mcp_servers;
  if (JSON.stringify(mcp ?? []) !== JSON.stringify(EXPECTED_EMPTY_MCP)) {
    return { ok: false, reason: `mcp_servers not empty: ${JSON.stringify(mcp)}` };
  }
  const actualModel = e.model;
  if (requestedModel && actualModel !== requestedModel) {
    return { ok: false, reason: `model ${String(actualModel)} != requested ${requestedModel}` };
  }
  return {
    ok: true,
    cliDrift: 'cliDrift' in version ? version.cliDrift : undefined,
    model: typeof actualModel === 'string' ? actualModel : undefined,
  };
}

export class QoderAgentService implements AgentService {
  private readonly config: QoderAgentServiceConfig;

  constructor(config: QoderAgentServiceConfig) {
    this.config = config;
  }

  async *invoke(prompt: string, options?: AgentServiceOptions): AsyncIterable<AgentMessage> {
    const workingDirectory = options?.workingDirectory;
    if (!workingDirectory) {
      yield this.error('qoder invoke rejected: workingDirectory is required (fail closed)');
      return;
    }
    const fs = this.config.profileFs ?? defaultQoderProfileFs();
    const audit = auditQoderProfile(this.config.profileDir, fs);
    if (!audit.ok) {
      yield this.error(`qoder invoke rejected: runtime profile audit failed: ${audit.violations.join('; ')}`);
      return;
    }

    let binary = this.config.binary;
    if (!binary) {
      const { resolveCliCommand } = await import('../../../../../utils/cli-resolve.js');
      const resolved = resolveCliCommand('qodercn');
      if (!resolved) {
        yield this.error('qoder binary not found (resolveCliCommand(qodercn) returned null)');
        return;
      }
      binary = resolved;
    }
    const args = buildQoderArgs({ profileDir: this.config.profileDir, sessionId: options?.sessionId });
    const env = sanitizeQoderEnv({ ...process.env, ...(options?.callbackEnv ?? {}), ...(options?.accountEnv ?? {}) });

    let child: ChildProcessWithoutNullStreams;
    try {
      child = (this.config.spawnFn ?? spawn)(binary, args, {
        cwd: workingDirectory, // resume 语义依赖同 cwd（I-11 第 6 条）
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      yield this.error(`qoder spawn failed: ${String(err)}`);
      return;
    }

    child.stdin.write(prompt);
    child.stdin.end();

    // 取消：signal 即终止子进程（不留后台计费）
    const signal = options?.signal;
    const onAbort = () => child.kill('SIGTERM');
    if (signal) {
      if (signal.aborted) {
        child.kill('SIGTERM');
        yield this.error('qoder invoke aborted before stream start');
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      yield* this.consumeStream(child);
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (!child.killed) child.kill('SIGTERM');
    }
  }

  private async *consumeStream(child: ChildProcessWithoutNullStreams): AsyncIterable<AgentMessage> {
    const { catId } = this.config;
    const rl = createInterface({ input: child.stdout });
    const stderrChunks: string[] = [];
    child.stderr.on('data', (d: Buffer) => stderrChunks.push(d.toString()));
    const collected: AgentMessage[] = [];
    let initSeen = false;
    let usage: TokenUsage | undefined;
    let billing: QoderBillingMetadata | undefined;
    let resultError: string | undefined;
    let successResultSeen = false;
    let actualModel: string | undefined;
    let exitCode: number | null | undefined;
    let spawnError: Error | undefined;
    child.on('error', (err) => {
      spawnError = err;
    });
    child.on('close', (code) => {
      exitCode = code;
    });

    // 先排空事件流（收集到 collected），流自然结束后统一判定终态——
    // cancel/排序违规时 SIGTERM 会让 readline 提前结束，exitCode 随后到位。
    try {
      for await (const line of rl) {
        if (!line.trim()) continue;
        let event: unknown;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        const e = event as Record<string, unknown>;

        if (e.type === 'system' && e.subtype === 'init') {
          const gate = qoderInitGate(event);
          if (!gate.ok) {
            resultError = `qoder init gate failed (fail closed): ${gate.reason}`;
            child.kill('SIGTERM');
            break;
          }
          initSeen = true;
          actualModel = gate.model;
          const initOut = transformQoderEvent(event, catId);
          if (initOut) collected.push(...(Array.isArray(initOut) ? initOut : [initOut]));
          if (gate.cliDrift) {
            collected.push({
              type: 'system_info',
              catId,
              content: JSON.stringify({ type: 'qoder_cli_drift', catId, warning: gate.cliDrift }),
              timestamp: Date.now(),
            });
          }
          continue;
        }
        if (!initSeen && (e.type === 'assistant' || e.type === 'user')) {
          resultError = 'qoder stream violated ordering: assistant/user event before passing init gate';
          child.kill('SIGTERM');
          break;
        }
        if (e.type === 'result') {
          if (isQoderResultErrorEvent(e)) {
            resultError = `qoder result error: ${typeof e.result === 'string' ? e.result : 'unknown'}`;
            continue;
          }
          const extracted = extractQoderUsage(e);
          usage = extracted.usage;
          billing = extracted.billing;
          successResultSeen = true;
          continue;
        }
        const out = transformQoderEvent(event, catId);
        if (out) collected.push(...(Array.isArray(out) ? out : [out]));
      }
    } catch (err) {
      resultError = resultError ?? `stream read failed: ${String(err)}`;
    }
    rl.close();

    // 等 exit code / spawn error 到位（SIGTERM 后 close 很快）
    for (let i = 0; i < 100 && exitCode === undefined && !spawnError; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }

    for (const m of collected) yield m;

    if (spawnError) {
      yield this.error(`qoder process error: ${String(spawnError)}`);
      return;
    }
    if (resultError) {
      yield this.error(diagnostic(resultError, stderrChunks));
      return;
    }
    if (!initSeen) {
      yield this.error(diagnostic('qoder stream ended without init event (fail closed)', stderrChunks));
      return;
    }
    if (!successResultSeen) {
      yield this.error(diagnostic('qoder stream ended without a successful result event', stderrChunks));
      return;
    }
    if (exitCode !== 0) {
      yield this.error(diagnostic(`qoder exited with code ${String(exitCode)}`, stderrChunks));
      return;
    }

    // P1-B：TokenUsage 保持诚实；真账（credits）走独立 billing metadata
    const done: AgentMessage = { type: 'done', catId, timestamp: Date.now() };
    done.metadata = {
      provider: 'qoder',
      model: actualModel ?? 'unknown',
      usage,
      ...(billing ? { qoderBilling: billing } : {}),
    } as unknown as NonNullable<AgentMessage['metadata']>;
    yield done;
  }

  /** 供内部展开（数组/单值统一 yield）—— 通过闭包收集 */
  private error(message: string): AgentMessage {
    return { type: 'error', catId: this.config.catId, error: message, timestamp: Date.now() };
  }
}

function diagnostic(message: string, stderrChunks: string[]): string {
  const tail = stderrChunks.join('').trim().slice(-500);
  return tail ? `${message} | stderr tail: ${tail}` : message;
}
