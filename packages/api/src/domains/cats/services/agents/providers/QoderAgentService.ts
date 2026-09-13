/**
 * F317 Phase 1 Slice 1: 窄 QoderAgentService（非路由）
 *
 * I-4 边界：只依赖 spawnCli / cli-resolve 等通用设施；不复制 Claude 载体语义
 * （无 carrier、无 effort、无 partial 去重）。typed inputs 经构造注入：
 * catId + binary + I-11 runtime profileDir；缺 workingDirectory fail closed。
 * 安全硬编码（提案 P1-D/I-8/L1 实证）：
 *   - permission mode 不传（CLI 默认 default），init.permissionMode 断言
 *   - `--tools ""` + strict deny-all MCP；hook/工具面在 init 事件上断言
 *   - protocol_version fail closed（首个 assistant 事件之前执行 init 门）
 *   - env 剥离 QODER 与 QODERCN 前缀（含 accountEnv —— CONFIG_DIR 只经本 Service 注入）
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { CatId } from '@cat-cafe/shared';
import type { AgentMessage, AgentService, AgentServiceOptions, TokenUsage } from '../../types.js';
import {
  checkQoderProtocolVersion,
  extractQoderUsage,
  type QoderBillingMetadata,
  transformQoderEvent,
} from './qoder-ndjson-parser.js';
import { auditQoderProfile, type QoderProfileDeps } from './qoder-runtime-profile.js';

/** qoder pilot 允许的唯一 permission mode（bypass_permissions/auto 硬编码禁用） */
const REQUIRED_PERMISSION_MODE = 'default';

export interface QoderAgentServiceConfig {
  catId: CatId;
  /** I-11 runtime profile 目录（由 resolver 经 ensureQoderRuntimeProfile 提供并审计） */
  profileDir: string;
  /** 可选覆盖 binary（默认 resolveCliCommand('qodercn')，测试注入用） */
  binary?: string;
  /** 注入 spawn（测试） */
  spawnFn?: typeof spawn;
  /** 注入 profile 审计依赖（测试） */
  profileDeps?: QoderProfileDeps;
}

/** 构造 qodercn argv。导出供单测锁定（含安全 flag 全集）。 */
export function buildQoderArgs(input: { prompt: string; profileDir: string; sessionId?: string }): string[] {
  const args = ['-p', input.prompt, '-o', 'stream-json', '--config-dir', input.profileDir];
  if (input.sessionId) args.push('-r', input.sessionId);
  args.push(
    '--strict-mcp-config',
    '--allowed-mcp-server-names',
    'nothing', // Slice 1 read-only pilot：MCP 全禁（I-10 预授权在后续 slice 解锁）
    '--tools',
    '', // 内置工具全禁（Bash/Write/Edit/WebFetch/WebSearch/ImageGen/VideoGen）
    '--setting-sources',
    'user',
  );
  return args;
}

/** 剥离 account/env 注入面里的 qoder 控制变量 —— CONFIG_DIR 只能来自构造注入 */
export function sanitizeQoderEnv(env: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith('QODER')) continue;
    if (v !== undefined) clean[k] = v;
  }
  return clean;
}

/** init 事件门：P1-H 版本 fail-closed + P1-D model/permissionMode 断言，先于任何 assistant 事件 */
export function qoderInitGate(
  initEvent: unknown,
  requestedModel?: string,
): { ok: true } | { ok: false; reason: string } {
  const version = checkQoderProtocolVersion(initEvent);
  if (!version.ok) return version;
  if (typeof initEvent !== 'object' || initEvent === null) return { ok: false, reason: 'init missing' };
  const e = initEvent as Record<string, unknown>;
  if (e.permissionMode !== REQUIRED_PERMISSION_MODE) {
    return { ok: false, reason: `permissionMode ${String(e.permissionMode)} != ${REQUIRED_PERMISSION_MODE}` };
  }
  const actualModel = e.model;
  // P1-D「Auto 必须显式」：请求了具体 model 时静默回落 Auto 判失败；未请求时 Auto 是 pilot 预期终态
  if (requestedModel && actualModel !== requestedModel) {
    return { ok: false, reason: `model ${String(actualModel)} != requested ${requestedModel}` };
  }
  return { ok: true };
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
    // I-11: 每次 invocation 前洁净审计，红即拒发
    const audit = auditQoderProfile(this.config.profileDir, this.config.profileDeps ?? defaultProfileDeps());
    if (!audit.ok) {
      yield this.error(`qoder invoke rejected: runtime profile audit failed: ${audit.violations.join('; ')}`);
      return;
    }

    // 惰性解析：binary 注入（测试/托管）时零依赖；真实路径仅在需要时加载
    const binary =
      this.config.binary ?? (await import('../../../../../utils/cli-resolve.js')).resolveCliCommand('qodercn');
    const args = buildQoderArgs({ prompt, profileDir: this.config.profileDir, sessionId: options?.sessionId });
    const env = sanitizeQoderEnv({ ...process.env, ...(options?.callbackEnv ?? {}), ...(options?.accountEnv ?? {}) });

    const child = (this.config.spawnFn ?? spawn)(binary, args, {
      cwd: workingDirectory, // resume 语义依赖同 cwd（I-11 第 6 条）
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    yield* this.consumeStream(child, options?.sessionId);
  }

  private async *consumeStream(
    child: ReturnType<typeof spawn>,
    _resumeSessionId?: string,
  ): AsyncIterable<AgentMessage> {
    const { catId } = this.config;
    const rl = createInterface({ input: child.stdout });
    let initSeen = false;
    let initEvent: unknown = null;
    let usage: TokenUsage | undefined;
    let billing: QoderBillingMetadata | undefined;

    try {
      for await (const line of rl) {
        if (!line.trim()) continue;
        let event: unknown;
        try {
          event = JSON.parse(line);
        } catch {
          continue; // 非 JSON 行（CLI banner 等）跳过，不视为协议错误
        }
        const e = event as Record<string, unknown>;

        // init 门：任何 assistant 事件之前必须通过；hook 事件先于 init 是 qoder 已实证形态
        if (e.type === 'system' && e.subtype === 'init') {
          initEvent = event;
          const gate = qoderInitGate(event);
          if (!gate.ok) {
            yield this.error(`qoder init gate failed (fail closed): ${gate.reason}`);
            child.kill('SIGTERM');
            return;
          }
          initSeen = true;
        } else if (e.type === 'assistant' && !initSeen) {
          yield this.error('qoder stream violated ordering: assistant event before passing init gate');
          child.kill('SIGTERM');
          return;
        }

        if (e.type === 'result') {
          const extracted = extractQoderUsage(e);
          usage = extracted.usage;
          billing = extracted.billing;
          continue; // 终态由 done 消息承载（含 usage/billing）
        }

        const out = transformQoderEvent(event, catId);
        if (out == null) continue;
        if (Array.isArray(out)) {
          for (const m of out) yield m;
        } else {
          yield out;
        }
      }

      if (!initSeen) {
        yield this.error('qoder stream ended without init event (fail closed)');
        return;
      }

      // P1-B：TokenUsage 保持诚实（token 字段恒 0 不装）；真账（credits）走独立 billing metadata
      const done: AgentMessage = { type: 'done', catId, timestamp: Date.now() };
      const meta: Record<string, unknown> = { provider: 'qoder', model: 'Auto', usage };
      if (billing) meta.qoderBilling = billing;
      done.metadata = meta as unknown as NonNullable<AgentMessage['metadata']>;
      yield done;
    } finally {
      rl.close();
      if (!child.killed) child.kill('SIGTERM');
    }
  }

  private error(message: string): AgentMessage {
    return { type: 'error', catId: this.config.catId, error: message, timestamp: Date.now() };
  }
}

function defaultProfileDeps(): QoderProfileDeps {
  // 延迟 require 避免纯函数模块顶层依赖 fs（测试注入友好）
  const fs = require('node:fs') as typeof import('node:fs');
  return {
    readFileSync: (p) => fs.readFileSync(p, 'utf8'),
    copySync: (src, dest) => fs.cpSync(src, dest, { recursive: true }),
  };
}
