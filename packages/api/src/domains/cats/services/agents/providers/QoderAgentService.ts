/**
 * F317 Phase 1 Slice 1: 窄 QoderAgentService（非路由）—— round-3 rework
 *
 * I-4 边界：typed 构造注入（catId / binary / model / I-11 profile + fs）；
 * 缺 workingDirectory fail closed。Round-3 review 修正（砚砚六组 P1）：
 *   P1① stderr 不内联进用户可见错误——脱敏/有界由共享 spawnCli 拥有（F212 AC-A9：
 *      暴露面同步 sanitize、humanized message、封顶尾窗）；本文件不再持有 stderr
 *   P1② abort 检查先于 recorder；prepared request 深度冻结（落档字节 = 出境字节）
 *   P1③ 复用 shared spawnCli（stdin EPIPE 守卫、CliTerminationController 有界终止、
 *      exit/close 等待、liveness 接线）+ CliRawArchive 落档；删除手写
 *      terminateBounded（非 unref 5s 计时器）与 250×20ms exit 轮询
 *   P1④ init.model 精确匹配（大小写敏感，auth-error 夹具实测小写 auto 漂移必须红）；
 *      argv 过 assertExplicitModelFlag（显式 -m provenance），done metadata 记录 provenance
 *   P1⑥ resume 二次审计（qoder-runtime-profile.auditQoderResumeSession）
 *   P1⑤ 见 qoder-runtime-profile.ts（swap 收尾失败如实返回）
 *
 * Round-4 修正（PR #24 review，砚砚 2×P1 + 1×P2）：
 *   P1-2 options.spawnCliOverride（F089 seam）优先于共享 spawnCli；
 *      CliSpawnOptions 接 rawArchivePath（timeout 诊断定位 raw archive）
 *   P1-3 resume 审计按 provider canonical slug 精确定位（见 qoder-runtime-profile.ts）
 *   P2-4 spawn 层异常不再从 iterable 逸出——统一转 qoder typed error 终态
 */

import { spawnSync } from 'node:child_process';
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { CatId } from '@cat-cafe/shared';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';
import { formatCliNotFoundError, resolveCliCommand } from '../../../../../utils/cli-resolve.js';
import {
  isCliError,
  isCliTimeout,
  isLivenessWarning,
  resolveVerdictGhGuardBin,
  spawnCli,
} from '../../../../../utils/cli-spawn.js';
import type { SpawnFn } from '../../../../../utils/cli-types.js';
import { isParseError } from '../../../../../utils/ndjson-parser.js';
import { CliRawArchive } from '../../session/CliRawArchive.js';
import type {
  AgentMessage,
  AgentService,
  AgentServiceOptions,
  PreparedProviderRequestV1,
  TokenUsage,
  ToolExecutionPolicy,
} from '../../types.js';
import { type RawArchiveSink, sanitizeRawEvent } from './codex-audit-hooks.js';
import {
  checkQoderProtocolVersion,
  extractQoderUsage,
  isQoderResultErrorEvent,
  type QoderBillingMetadata,
  qoderEventContainsTextToolProtocol,
  transformQoderEvent,
} from './qoder-ndjson-parser.js';
import {
  auditQoderProfile,
  auditQoderResumeSession,
  defaultQoderProfileFs,
  type QoderProfileFs,
} from './qoder-runtime-profile.js';

const log = createModuleLogger('qoder-agent-service');

const REQUIRED_PERMISSION_MODE = 'default';

/**
 * F317 L2 operator decision: expose the complete basic coding surface at once.
 * Deliberately excludes orchestration/generation surfaces (Agent, Cron, Task*,
 * Image*, Video*, Workflow, Skill): those are not "basic coding tools".
 */
export const QODER_BASIC_TOOLS = Object.freeze(['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write'] as const);

export const QODER_MEMORY_MCP_SERVER = 'cat-cafe-memory';

/**
 * Exact readonly surface of the split `packages/mcp-server/dist/memory.js`
 * entrypoint. A cross-package test pins this duplicate projection to
 * buildMemoryTools({ readonly: true }) so registry drift fails CI.
 */
export const QODER_READONLY_MEMORY_TOOLS = Object.freeze([
  'cat_cafe_graph_resolve',
  'cat_cafe_list_external_runtime_sessions',
  'cat_cafe_list_recent',
  'cat_cafe_list_session_chain',
  'cat_cafe_read_external_runtime_session',
  'cat_cafe_read_file_slice',
  'cat_cafe_read_invocation_detail',
  'cat_cafe_read_meeting_artifact',
  'cat_cafe_read_session_digest',
  'cat_cafe_read_session_events',
  'cat_cafe_run_perspective',
  'cat_cafe_search_evidence',
] as const);

export type QoderToolAccess = 'controlled' | 'disabled';

const QODER_MEMORY_TOOL_NAMES = Object.freeze(
  QODER_READONLY_MEMORY_TOOLS.map((name) => `mcp__${QODER_MEMORY_MCP_SERVER}__${name}`),
);

type QoderInitExpectation = {
  readonly tools: readonly string[];
  readonly mcpServerNames: readonly string[];
};

const DISABLED_INIT_EXPECTATION: QoderInitExpectation = Object.freeze({
  tools: Object.freeze([]),
  mcpServerNames: Object.freeze([]),
});

const CONTROLLED_INIT_EXPECTATION: QoderInitExpectation = Object.freeze({
  tools: Object.freeze([...QODER_BASIC_TOOLS, ...QODER_MEMORY_TOOL_NAMES]),
  mcpServerNames: Object.freeze([QODER_MEMORY_MCP_SERVER]),
});

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

const CONTROLLED_ENV_PASSTHROUGH = new Set([
  'PATH',
  'LANG',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'TZ',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
]);

const READONLY_MEMORY_IDENTITY_ENV_KEYS = [
  'CAT_CAFE_API_URL',
  'CAT_CAFE_USER_ID',
  'CAT_CAFE_CAT_ID',
  'CAT_CAFE_THREAD_ID',
] as const;

export interface QoderAgentServiceConfig {
  catId: CatId;
  /** I-11 runtime profile 目录（由 resolver 经 ensureQoderRuntimeProfile 提供并审计） */
  profileDir: string;
  /** 必填：显式选定并下发 `-m` 的 model（P1-D：精确匹配，漂移即失败） */
  model: string;
  /** 可选覆盖 binary（默认 resolveCliCommand('qodercn')；测试注入用） */
  binary?: string;
  /** 注入 spawn（测试；生产走共享 spawnCli 的默认 spawn） */
  spawnFn?: SpawnFn;
  /** 注入 profile 审计文件系统（测试；默认真实 fs） */
  profileFs?: QoderProfileFs;
  /** #780 先例：raw NDJSON 落档 sink（默认 CliRawArchive） */
  rawArchive?: RawArchiveSink;
  /** L2 产品路径 = controlled；disabled 仅用于只读策略与历史夹具回放。 */
  toolAccess?: QoderToolAccess;
  /** split readonly memory MCP entrypoint（生产由注册工厂绑定到 runtime dist）。 */
  memoryMcpServerPath?: string;
  /** Runtime root, explicit so memory policy scope never depends on wrapper placement. */
  runtimeRoot?: string;
  /** Runtime-owned Qoder shell-prefix wrapper. */
  shellSandboxWrapperPath?: string;
  /** macOS Seatbelt binary（测试 seam；生产动态解析 sandbox-exec）。 */
  sandboxBinary?: string;
  /** Unit-test seam only; production factory never injects this. */
  sandboxProbe?: (input: QoderSandboxProbeInput) => void;
}

export type QoderSandboxProbeInput = {
  readonly childEnv: Readonly<Record<string, string | null>>;
  readonly denyCanaryPath: string;
  readonly guardedGhPath?: string;
  readonly scratchDir: string;
  readonly shellSandboxWrapperPath: string;
};

/** 构造 qodercn argv（stdin prompt 通道 + 显式 model + 安全 flag 全集） */
export function buildQoderArgs(input: {
  profileDir: string;
  model: string;
  sessionId?: string;
  toolAccess: QoderToolAccess;
  mcpConfigPath?: string;
  workingDirectory?: string;
}): string[] {
  const args = ['-p', '-', '-m', input.model, '-o', 'stream-json', '--config-dir', input.profileDir];
  if (input.sessionId) args.push('-r', input.sessionId);
  if (input.toolAccess === 'disabled') {
    args.push(
      '--strict-mcp-config',
      '--allowed-mcp-server-names',
      'nothing',
      '--tools',
      '',
      '--setting-sources',
      'user',
    );
    return args;
  }
  if (!input.mcpConfigPath) throw new Error('controlled qoder tools require a readonly memory MCP config');
  if (!input.workingDirectory) throw new Error('controlled qoder tools require a workspace permission root');
  args.push('--tools', ...QODER_BASIC_TOOLS);
  const normalizedWorkspace = resolve(input.workingDirectory).replaceAll('\\', '/');
  const absoluteWorkspacePattern = `//${normalizedWorkspace.replace(/^\/+/, '')}/**`;
  const allowedTools = [
    `Read(${absoluteWorkspacePattern})`,
    `Edit(${absoluteWorkspacePattern})`,
    `Write(${absoluteWorkspacePattern})`,
    `Glob(${absoluteWorkspacePattern})`,
    `Grep(${absoluteWorkspacePattern})`,
    'Bash',
    ...QODER_MEMORY_TOOL_NAMES,
  ];
  for (const tool of allowedTools) {
    args.push('--allowed-tools', tool);
  }
  args.push(
    '--mcp-config',
    input.mcpConfigPath,
    '--strict-mcp-config',
    '--allowed-mcp-server-names',
    QODER_MEMORY_MCP_SERVER,
    '--setting-sources',
    'user',
  );
  return args;
}

/** P1④：argv 必须显式携带 `-m <model>`（provenance 断言，缺/错即拒发） */
export function assertExplicitModelFlag(argv: readonly string[], model: string): void {
  const i = argv.indexOf('-m');
  if (!model || i === -1 || argv[i + 1] !== model) {
    throw new Error(`qoder argv missing explicit -m ${JSON.stringify(model)} (silent-model-fallback guard)`);
  }
}

/**
 * P1③：env 以「覆盖表」交给共享 buildChildEnv 合并（E2BIG 剥离 + PWD/INIT_CWD 钉在 cwd）。
 * 纪律不变：denylist（大小写归一）与 qoder* 前缀一律从子进程 env 删除（null = delete），
 * inputs 里的 qoder* 不转发；QODERCN_CONFIG_DIR 只由 resolver 单点注入（I-11 §5）。
 */
export function buildQoderEnvOverrides(input: {
  profileDir: string;
  inheritEnv?: Record<string, string | undefined>;
  callbackEnv?: Record<string, string>;
  accountEnv?: Record<string, string>;
}): Record<string, string | null> {
  const overrides: Record<string, string | null> = {};
  const isDenied = (k: string) => DENIED_ENV_KEYS.has(k.toUpperCase()) || k.toLowerCase().startsWith('qoder');
  for (const [k, v] of Object.entries(input.inheritEnv ?? process.env)) {
    if (v === undefined) continue;
    if (isDenied(k)) overrides[k] = null;
  }
  for (const src of [input.callbackEnv, input.accountEnv]) {
    for (const [k, v] of Object.entries(src ?? {})) {
      if (isDenied(k)) continue;
      overrides[k] = v;
    }
  }
  overrides.QODERCN_CONFIG_DIR = input.profileDir;
  return overrides;
}

function exactStringSet(actual: unknown[], expected: readonly string[]): boolean {
  if (!actual.every((value): value is string => typeof value === 'string')) return false;
  if (actual.length !== expected.length) return false;
  const sortedActual = [...actual].sort();
  const sortedExpected = [...expected].sort();
  return sortedActual.every((value, index) => value === sortedExpected[index]);
}

/** init 门（任何 assistant 事件之前，fail closed）。tools/mcp 必须与本次请求精确全等。 */
export function qoderInitGate(
  initEvent: unknown,
  requestedModel: string,
  expected: QoderInitExpectation = DISABLED_INIT_EXPECTATION,
): { ok: true; cliDrift?: string; model?: string } | { ok: false; reason: string } {
  const version = checkQoderProtocolVersion(initEvent);
  if (!version.ok) return version;
  if (typeof initEvent !== 'object' || initEvent === null) return { ok: false, reason: 'init missing' };
  const e = initEvent as Record<string, unknown>;
  if (e.permissionMode !== REQUIRED_PERMISSION_MODE) {
    return { ok: false, reason: `permissionMode ${String(e.permissionMode)} != ${REQUIRED_PERMISSION_MODE}` };
  }
  if (!Array.isArray(e.tools)) return { ok: false, reason: 'init.tools missing (not an array)' };
  if (!exactStringSet(e.tools, expected.tools)) {
    return { ok: false, reason: `tools mismatch: ${JSON.stringify(e.tools)}` };
  }
  if (!Array.isArray(e.mcp_servers)) return { ok: false, reason: 'init.mcp_servers missing (not an array)' };
  const mcpNames: string[] = [];
  for (const raw of e.mcp_servers) {
    if (typeof raw !== 'object' || raw === null) {
      return { ok: false, reason: `invalid mcp server entry: ${JSON.stringify(raw)}` };
    }
    const server = raw as Record<string, unknown>;
    if (typeof server.name !== 'string') return { ok: false, reason: 'mcp server name missing' };
    if (server.status !== 'connected') {
      return { ok: false, reason: `mcp server ${server.name} status ${String(server.status)} != connected` };
    }
    mcpNames.push(server.name);
  }
  if (!exactStringSet(mcpNames, expected.mcpServerNames)) {
    return { ok: false, reason: `mcp server set mismatch: ${JSON.stringify(mcpNames)}` };
  }
  // P1④ 精确匹配（大小写敏感）。L1 夹具实测：未认证 CLI 回报小写 auto（auth-error），
  // 静默回落回报 Auto（silent-model-fallback）——任何与请求值不同的字符串（含大小写
  // 漂移）都是 fail closed；配置值必须等于 CLI 精确回报值。
  const actualModel = e.model;
  if (typeof actualModel !== 'string' || actualModel !== requestedModel) {
    return {
      ok: false,
      reason: `model ${String(actualModel)} != requested ${requestedModel} (exact-match: silent fallback or case drift)`,
    };
  }
  return {
    ok: true,
    cliDrift: 'cliDrift' in version ? version.cliDrift : undefined,
    model: actualModel,
  };
}

type QoderInvocationLease = {
  readonly mcpConfigPath: string;
  readonly childEnv: Record<string, string | null>;
  readonly denyCanaryPath: string;
  readonly guardedGhPath?: string;
  readonly scratchDir: string;
  dispose(): void;
};

type GitMetadataAccess = {
  readonly readRoots: readonly string[];
  readonly writeRoots: readonly string[];
  readonly writeLiterals: readonly string[];
  readonly workspaceWriteExclusions: readonly string[];
  readonly deniedWriteRoots: readonly string[];
  readonly deniedWriteLiterals: readonly string[];
  readonly deniedWriteUnlinkRoots: readonly string[];
};

const EMPTY_GIT_METADATA_ACCESS: GitMetadataAccess = Object.freeze({
  readRoots: Object.freeze([]),
  writeRoots: Object.freeze([]),
  writeLiterals: Object.freeze([]),
  workspaceWriteExclusions: Object.freeze([]),
  deniedWriteRoots: Object.freeze([]),
  deniedWriteLiterals: Object.freeze([]),
  deniedWriteUnlinkRoots: Object.freeze([]),
});

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function seatbeltLiteral(value: string): string {
  return JSON.stringify(value);
}

function shellLiteral(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function isPathWithin(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

function gitRefWriteLiterals(gitDir: string, commonDir: string): string[] {
  const line = readFileSync(join(gitDir, 'HEAD'), 'utf8').split(/\r?\n/, 1)[0]?.trim() ?? '';
  const name = line.startsWith('ref:') ? line.slice('ref:'.length).trim() : '';
  const headsRoot = join(commonDir, 'refs', 'heads');
  const currentRef = name ? resolve(commonDir, name) : '';
  const literals = [join(commonDir, 'refs', 'stash')];
  if (currentRef && name.startsWith('refs/heads/') && isPathWithin(headsRoot, currentRef)) {
    literals.unshift(currentRef);
  }
  return literals.flatMap((literal) => [literal, `${literal}.lock`]);
}

function worktreeLocalGitWriteLiterals(gitDir: string): string[] {
  return [
    'AUTO_MERGE',
    'BISECT_LOG',
    'CHERRY_PICK_HEAD',
    'COMMIT_EDITMSG',
    'FETCH_HEAD',
    'HEAD',
    'HEAD.lock',
    'MERGE_MSG',
    'MERGE_RR',
    'ORIG_HEAD',
    'REVERT_HEAD',
    'index',
    'index.lock',
  ].map((name) => join(gitDir, name));
}

function protectedGitWrites(gitRoot: string): Pick<GitMetadataAccess, 'deniedWriteRoots' | 'deniedWriteLiterals'> {
  return {
    deniedWriteRoots: [join(gitRoot, 'hooks')],
    deniedWriteLiterals: [join(gitRoot, 'config'), join(gitRoot, 'config.worktree')],
  };
}

function externalGitMetadataAccess(workingDirectory: string): GitMetadataAccess {
  const dotGit = join(workingDirectory, '.git');
  if (!existsSync(dotGit)) return EMPTY_GIT_METADATA_ACCESS;
  try {
    if (lstatSync(dotGit).isDirectory()) {
      const gitRoot = canonicalPath(dotGit);
      return {
        readRoots: [gitRoot],
        writeRoots: [join(gitRoot, 'objects'), join(gitRoot, 'logs')],
        writeLiterals: [...gitRefWriteLiterals(gitRoot, gitRoot), ...worktreeLocalGitWriteLiterals(gitRoot)],
        // The workspace grant would otherwise recursively re-open .git.
        workspaceWriteExclusions: [gitRoot],
        // Reflogs only ever grow by append; losing them removes the shared
        // recovery path, so deletion stays denied even where writes are needed.
        deniedWriteUnlinkRoots: [join(gitRoot, 'logs')],
        ...protectedGitWrites(gitRoot),
      };
    }
    const line = readFileSync(dotGit, 'utf8').split(/\r?\n/, 1)[0]?.trim() ?? '';
    if (!line.startsWith('gitdir:')) return EMPTY_GIT_METADATA_ACCESS;
    const gitDir = canonicalPath(resolve(workingDirectory, line.slice('gitdir:'.length).trim()));
    const commonDirFile = join(gitDir, 'commondir');
    const backPointerFile = join(gitDir, 'gitdir');
    if (!lstatSync(gitDir).isDirectory() || !existsSync(commonDirFile) || !existsSync(backPointerFile)) {
      return EMPTY_GIT_METADATA_ACCESS;
    }
    const commonDir = canonicalPath(resolve(gitDir, readFileSync(commonDirFile, 'utf8').trim()));
    const worktreesRoot = join(commonDir, 'worktrees');
    const backPointer = canonicalPath(resolve(gitDir, readFileSync(backPointerFile, 'utf8').trim()));
    if (basename(commonDir) !== '.git' || dirname(gitDir) !== worktreesRoot || backPointer !== canonicalPath(dotGit)) {
      // The workspace-owned .git file is attacker-writable. Only Git's reciprocal
      // gitdir pointer proves that this metadata actually belongs to this workspace.
      return EMPTY_GIT_METADATA_ACCESS;
    }
    const protectedWrites = protectedGitWrites(commonDir);
    return {
      readRoots: [gitDir, commonDir],
      // A normal commit needs the worktree-local index/HEAD plus shared objects,
      // its own branch ref and reflogs. It never needs recursive write over
      // every shared ref in commonDir.
      writeRoots: [gitDir, join(commonDir, 'objects'), join(commonDir, 'logs')],
      writeLiterals: gitRefWriteLiterals(gitDir, commonDir),
      workspaceWriteExclusions: [],
      deniedWriteUnlinkRoots: [join(commonDir, 'logs')],
      deniedWriteRoots: [...protectedWrites.deniedWriteRoots, join(gitDir, 'hooks')],
      deniedWriteLiterals: [
        ...protectedWrites.deniedWriteLiterals,
        join(gitDir, 'config'),
        join(gitDir, 'config.worktree'),
        // These reciprocal identity files are the trust proof above. Git does
        // not mutate them during ordinary add/commit, so keep them immutable.
        backPointerFile,
        commonDirFile,
      ],
    };
  } catch {
    // A malformed/untrusted .git indirection must not widen the sandbox.
    return EMPTY_GIT_METADATA_ACCESS;
  }
}

function buildSeatbeltPolicy(input: {
  deniedReadRoots: readonly string[];
  allowedReadRoots: readonly string[];
  allowedReadLiterals?: readonly string[];
  deniedReadRootsFinal?: readonly string[];
  deniedReadLiterals?: readonly string[];
  allowedWriteRoots: readonly string[];
  allowedWriteLiterals?: readonly string[];
  writeExclusions?: readonly string[];
  deniedWriteRoots?: readonly string[];
  deniedWriteLiterals?: readonly string[];
  deniedWriteUnlinkRoots?: readonly string[];
}): string {
  const unique = (values: readonly string[]) => [...new Set(values.map(canonicalPath))];
  const filters = (roots: readonly string[]) => unique(roots).map((root) => `(subpath ${seatbeltLiteral(root)})`);
  const readLiterals = unique(input.allowedReadLiterals ?? []);
  const metadataAncestors = unique([...input.allowedReadRoots, ...readLiterals]).flatMap((root) => {
    const ancestors: string[] = [];
    let cursor = root;
    while (cursor !== dirname(cursor)) {
      ancestors.push(cursor);
      cursor = dirname(cursor);
    }
    return ancestors;
  });
  const writeExclusions = unique(input.writeExclusions ?? []);
  const writeFilters = unique(input.allowedWriteRoots).map((root) => {
    const exclusions = writeExclusions.filter((candidate) => candidate !== root && isPathWithin(root, candidate));
    if (exclusions.length === 0) return `(subpath ${seatbeltLiteral(root)})`;
    return `(require-all (subpath ${seatbeltLiteral(root)}) ${exclusions
      .map((candidate) => `(require-not (subpath ${seatbeltLiteral(candidate)}))`)
      .join(' ')})`;
  });
  return [
    '(version 1)',
    '(allow default)',
    ...filters(input.deniedReadRoots).map((filter) => `(deny file-read* ${filter})`),
    ...unique(metadataAncestors).map((root) => `(allow file-read-metadata (literal ${seatbeltLiteral(root)}))`),
    ...filters(input.allowedReadRoots).map((filter) => `(allow file-read* ${filter})`),
    ...readLiterals.map((literal) => `(allow file-read* (literal ${seatbeltLiteral(literal)}))`),
    ...filters(input.deniedReadRootsFinal ?? []).map((filter) => `(deny file-read* ${filter})`),
    ...unique(input.deniedReadLiterals ?? []).map(
      (literal) => `(deny file-read* (literal ${seatbeltLiteral(literal)}))`,
    ),
    '(deny file-write*)',
    ...writeFilters.map((filter) => `(allow file-write* ${filter})`),
    ...unique(input.allowedWriteLiterals ?? []).map(
      (literal) => `(allow file-write* (literal ${seatbeltLiteral(literal)}))`,
    ),
    ...filters(input.deniedWriteRoots ?? []).map((filter) => `(deny file-write* ${filter})`),
    ...unique(input.deniedWriteLiterals ?? []).map(
      (literal) => `(deny file-write* (literal ${seatbeltLiteral(literal)}))`,
    ),
    ...filters(input.deniedWriteUnlinkRoots ?? []).map((filter) => `(deny file-write-unlink ${filter})`),
    '',
  ].join('\n');
}

type ControlledToolPath = {
  readonly path: string | null;
  readonly allowedReadRoots: readonly string[];
  readonly guardedGhPath?: string;
};

function controlledToolPath(operatorHome: string): ControlledToolPath {
  const inherited = process.env.PATH ?? null;
  if (process.platform !== 'darwin') return { path: inherited, allowedReadRoots: [] };
  const result = spawnSync('/usr/bin/xcrun', ['--no-cache', '--find', 'git'], {
    encoding: 'utf8',
    timeout: 5_000,
  });
  if (result.status !== 0) throw new Error('qoder controlled PATH cannot resolve the system git toolchain');
  const gitPath = result.stdout.trim();
  if (!gitPath) throw new Error('qoder controlled PATH resolved an empty git toolchain path');
  const explicitBins: string[] = [];
  const allowedReadRoots: string[] = [];
  let guardedGhPath: string | undefined;
  try {
    explicitBins.push(dirname(realpathSync(gitPath)), dirname(realpathSync(process.execPath)));
    const guardedBin = resolveVerdictGhGuardBin();
    if (!guardedBin) throw new Error('runtime-owned guarded gh is unavailable');
    explicitBins.push(guardedBin);
    allowedReadRoots.push(guardedBin);
    guardedGhPath = join(guardedBin, 'gh');
    const resolvedPnpm = resolveCliCommand('pnpm');
    if (resolvedPnpm && isAbsolute(resolvedPnpm) && existsSync(resolvedPnpm)) {
      const pnpmPath = resolve(resolvedPnpm);
      const pnpmBin = dirname(pnpmPath);
      explicitBins.push(pnpmBin);
      allowedReadRoots.push(pnpmBin);
      const packageRoot = resolve(pnpmBin, '..', 'node_modules', 'pnpm');
      if (existsSync(packageRoot) && lstatSync(packageRoot).isDirectory()) allowedReadRoots.push(packageRoot);
    }
    const explicitCanonical = new Set(explicitBins.map(canonicalPath));
    const inheritedBins = (inherited ?? '')
      .split(delimiter)
      .filter(Boolean)
      .filter((entry) => {
        const canonical = canonicalPath(entry);
        return explicitCanonical.has(canonical) || !isPathWithin(operatorHome, canonical);
      });
    const path = [...new Set([...explicitBins, ...inheritedBins])].join(delimiter);
    return {
      path: path || null,
      allowedReadRoots: [...new Set([...allowedReadRoots, dirname(realpathSync(process.execPath))])],
      ...(guardedGhPath ? { guardedGhPath } : {}),
    };
  } catch (error) {
    throw new Error(`qoder controlled PATH is unsafe: ${String(error)}`);
  }
}

export function validateQoderControlledRuntimePaths(input: {
  memoryMcpServerPath: string;
  shellSandboxWrapperPath: string;
  sandboxBinary?: string;
}): { ok: true } | { ok: false; reason: string } {
  try {
    const memory = lstatSync(input.memoryMcpServerPath);
    if (!memory.isFile() || memory.isSymbolicLink())
      return { ok: false, reason: 'memory MCP entrypoint is not a real file' };
    const wrapper = lstatSync(input.shellSandboxWrapperPath);
    if (!wrapper.isFile() || wrapper.isSymbolicLink())
      return { ok: false, reason: 'shell-prefix wrapper is not a real file' };
    accessSync(input.shellSandboxWrapperPath, constants.R_OK | constants.X_OK);
    if (input.sandboxBinary) {
      if (!statSync(input.sandboxBinary).isFile()) return { ok: false, reason: 'sandbox binary is not a file' };
      accessSync(input.sandboxBinary, constants.X_OK);
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `runtime sandbox asset unavailable: ${String(error)}` };
  }
}

function buildControlledQoderEnv(input: {
  profileDir: string;
  scratchDir: string;
  shellSandboxWrapperPath: string;
  sandboxBinary: string;
  workspacePolicyPath: string;
  memoryPolicyPath: string;
  memoryShimPath: string;
  toolPath: string | null;
}): Record<string, string | null> {
  const overrides: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(process.env)) {
    overrides[key] = CONTROLLED_ENV_PASSTHROUGH.has(key) || key.startsWith('LC_') ? (value ?? null) : null;
  }
  overrides.PATH = input.toolPath;
  overrides.HOME = join(input.scratchDir, 'home');
  overrides.TMPDIR = input.scratchDir;
  overrides.QODERCN_CONFIG_DIR = input.profileDir;
  overrides.QODERCN_SHELL_PREFIX = input.shellSandboxWrapperPath;
  overrides.CAT_CAFE_QODER_SANDBOX_BIN = input.sandboxBinary;
  overrides.CAT_CAFE_QODER_WORKSPACE_POLICY = input.workspacePolicyPath;
  overrides.CAT_CAFE_QODER_MEMORY_POLICY = input.memoryPolicyPath;
  overrides.CAT_CAFE_QODER_MEMORY_SHIM = input.memoryShimPath;
  return overrides;
}

function createQoderInvocationLease(input: {
  memoryMcpServerPath: string;
  runtimeRoot: string;
  shellSandboxWrapperPath: string;
  sandboxBinary: string;
  profileDir: string;
  workingDirectory: string;
  callbackEnv?: Readonly<Record<string, string>>;
}): QoderInvocationLease {
  const dir = mkdtempSync(join(tmpdir(), 'cat-cafe-qoder-l2-'));
  try {
    const scratchDir = join(dir, 'scratch');
    const homeDir = join(scratchDir, 'home');
    const mcpDataDir = join(scratchDir, 'mcp-data');
    mkdirSync(homeDir, { recursive: true, mode: 0o700 });
    mkdirSync(mcpDataDir, { recursive: true, mode: 0o700 });

    const workspace = canonicalPath(input.workingDirectory);
    const runtimeRoot = canonicalPath(input.runtimeRoot);
    const memoryDistRoot = canonicalPath(dirname(input.memoryMcpServerPath));
    const scratch = canonicalPath(scratchDir);
    // Unlike os.homedir(), userInfo().homedir does not trust the mutable HOME
    // environment variable. The sandbox must fence the OS account home even if
    // a launcher omits or redirects HOME.
    const operatorHome = canonicalPath(userInfo().homedir);
    if (!operatorHome || operatorHome === dirname(operatorHome)) {
      throw new Error('operator home is unresolvable or unsafe');
    }
    const systemTmp = canonicalPath('/tmp');
    const deniedReadRoots = [operatorHome, systemTmp, canonicalPath(tmpdir())];
    const protectedRuntimeReadRoots = [join(runtimeRoot, '.cat-cafe'), join(runtimeRoot, 'mcp-creds')];
    const protectedRuntimeReadLiterals = [
      join(runtimeRoot, '.env'),
      join(runtimeRoot, '.env.local'),
      join(runtimeRoot, '.npmrc'),
      join(runtimeRoot, 'credentials.json'),
      join(runtimeRoot, 'evidence.sqlite'),
      join(runtimeRoot, 'event-memory.sqlite'),
    ];
    const gitAccess = externalGitMetadataAccess(workspace);
    const toolPath = controlledToolPath(operatorHome);
    const workspacePolicyPath = join(dir, 'workspace.sb');
    const memoryPolicyPath = join(dir, 'memory.sb');
    const memoryShimPath = join(dir, 'memory-shim');
    const denyCanaryPath = join(dir, 'deny-canary');
    writeFileSync(denyCanaryPath, 'sandbox-deny-canary', { encoding: 'utf8', mode: 0o600 });
    writeFileSync(
      memoryShimPath,
      `#!/bin/sh\nexec ${shellLiteral(process.execPath)} ${shellLiteral(input.memoryMcpServerPath)}\n`,
      { encoding: 'utf8', mode: 0o700 },
    );
    writeFileSync(
      workspacePolicyPath,
      buildSeatbeltPolicy({
        deniedReadRoots,
        allowedReadRoots: [workspace, scratch, ...gitAccess.readRoots, ...toolPath.allowedReadRoots],
        deniedReadRootsFinal: protectedRuntimeReadRoots,
        deniedReadLiterals: protectedRuntimeReadLiterals,
        allowedWriteRoots: [workspace, scratch, ...gitAccess.writeRoots],
        allowedWriteLiterals: ['/dev/null', ...gitAccess.writeLiterals],
        writeExclusions: gitAccess.workspaceWriteExclusions,
        deniedWriteRoots: gitAccess.deniedWriteRoots,
        deniedWriteLiterals: gitAccess.deniedWriteLiterals,
        deniedWriteUnlinkRoots: gitAccess.deniedWriteUnlinkRoots,
      }),
      { encoding: 'utf8', mode: 0o600 },
    );
    writeFileSync(
      memoryPolicyPath,
      buildSeatbeltPolicy({
        deniedReadRoots,
        // Never grant the whole runtime root: it contains deployment credentials.
        // The readonly MCP needs only compiled code, dependencies and its immutable shim.
        allowedReadRoots: [workspace, scratch, memoryDistRoot, join(runtimeRoot, 'node_modules')],
        allowedReadLiterals: [
          memoryShimPath,
          input.memoryMcpServerPath,
          process.execPath,
          join(runtimeRoot, 'package.json'),
          join(runtimeRoot, 'packages', 'mcp-server', 'package.json'),
        ],
        deniedReadRootsFinal: protectedRuntimeReadRoots,
        deniedReadLiterals: protectedRuntimeReadLiterals,
        allowedWriteRoots: [scratch],
        allowedWriteLiterals: ['/dev/null'],
      }),
      { encoding: 'utf8', mode: 0o600 },
    );

    const mcpConfigPath = join(dir, 'mcp-config.json');
    const env: Record<string, string> = {
      ALLOWED_WORKSPACE_DIRS: workspace,
      CAT_CAFE_DATA_DIR: mcpDataDir,
      CAT_CAFE_READONLY: 'true',
      // Incidental agent-key vars inherited by qodercn must never widen this mount.
      CAT_CAFE_READONLY_AGENT_KEY_UNION: 'false',
      HOME: homeDir,
      TMPDIR: scratchDir,
    };
    for (const key of READONLY_MEMORY_IDENTITY_ENV_KEYS) {
      const value = input.callbackEnv?.[key];
      if (value) env[key] = value;
    }
    writeFileSync(
      mcpConfigPath,
      JSON.stringify({
        mcpServers: {
          [QODER_MEMORY_MCP_SERVER]: {
            command: memoryShimPath,
            args: [],
            env,
          },
        },
      }),
      { encoding: 'utf8', mode: 0o600 },
    );
    let disposed = false;
    return {
      mcpConfigPath,
      denyCanaryPath,
      ...(toolPath.guardedGhPath ? { guardedGhPath: toolPath.guardedGhPath } : {}),
      scratchDir,
      childEnv: buildControlledQoderEnv({
        profileDir: input.profileDir,
        scratchDir,
        shellSandboxWrapperPath: input.shellSandboxWrapperPath,
        sandboxBinary: input.sandboxBinary,
        workspacePolicyPath,
        memoryPolicyPath,
        memoryShimPath,
        toolPath: toolPath.path,
      }),
      dispose() {
        if (disposed) return;
        disposed = true;
        rmSync(dir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

function effectiveChildEnv(overrides: Readonly<Record<string, string | null>>): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(overrides).filter((entry): entry is [string, string] => entry[1] !== null));
}

function runQoderSandboxProbe(input: QoderSandboxProbeInput): void {
  const env = effectiveChildEnv(input.childEnv);
  const allowPath = join(input.scratchDir, 'allow-canary');
  const run = (command: string) =>
    spawnSync(process.execPath, [input.shellSandboxWrapperPath, command], {
      env,
      encoding: 'utf8',
      timeout: 5_000,
    });
  const allowed = run(`/usr/bin/touch ${shellLiteral(allowPath)}`);
  if (allowed.status !== 0 || !existsSync(allowPath)) {
    throw new Error(`qoder sandbox allow canary failed (exit=${String(allowed.status)})`);
  }
  const denied = run(`/bin/cat ${shellLiteral(input.denyCanaryPath)}`);
  if (denied.status === 0) throw new Error('qoder sandbox deny canary failed open');
  if (input.guardedGhPath) {
    const resolvedGh = run('command -v gh');
    if (resolvedGh.status !== 0 || resolvedGh.stdout.trim() !== input.guardedGhPath) {
      throw new Error('qoder sandbox guarded gh resolution canary failed');
    }
    const guardedGh = run('gh --version');
    if (guardedGh.status !== 0) throw new Error('qoder sandbox guarded gh execution canary failed');
  }
}

/** P1②：深冻 prepared request —— recorder 落档字节与后续出境字节不可分叉（Kimi 同款契约） */
function freezePreparedRequest(r: PreparedProviderRequestV1): PreparedProviderRequestV1 {
  return Object.freeze({
    ...r,
    message: Object.freeze({ ...r.message }),
    nativeInstructions: Object.freeze(r.nativeInstructions.map((i) => Object.freeze({ ...i }))),
    runtime: Object.freeze({ ...r.runtime }),
    tools: Object.freeze({
      ...r.tools,
      declaredServerNames: Object.freeze([...(r.tools.declaredServerNames ?? [])]),
    }),
  });
}

export class QoderAgentService implements AgentService {
  private readonly config: QoderAgentServiceConfig;
  private readonly rawArchive: RawArchiveSink;

  constructor(config: QoderAgentServiceConfig) {
    this.config = config;
    this.rawArchive = config.rawArchive ?? new CliRawArchive();
  }

  supportsToolExecutionPolicy(policy: ToolExecutionPolicy): boolean {
    return policy.mode === 'read_only';
  }

  async *invoke(prompt: string, options?: AgentServiceOptions): AsyncIterable<AgentMessage> {
    const workingDirectory = options?.workingDirectory;
    if (!workingDirectory) {
      yield this.error('qoder invoke rejected: workingDirectory is required (fail closed)');
      return;
    }

    // P1②：abort 检查先于 recorder —— 已取消的请求不落档、不出境
    const signal = options?.signal;
    if (signal?.aborted) {
      yield this.error('qoder invoke aborted before provider-request recorder');
      return;
    }

    const fs = this.config.profileFs ?? defaultQoderProfileFs();
    const audit = auditQoderProfile(this.config.profileDir, fs);
    if (!audit.ok) {
      yield this.error(`qoder invoke rejected: runtime profile audit failed: ${audit.violations.join('; ')}`);
      return;
    }

    // P1⑥/round-4 P1-3：resume 是对 provider 已初始化 profile 的二次信任——session 必须存在于
    // 本 profile 的 canonical 项目目录 projects/<qoderProjectSlug(cwd)>/<sessionId>.jsonl
    // （I-11：resume 语义依赖同 config-dir + 同 cwd，跨 cwd 精确拒绝）
    if (options?.sessionId) {
      const resumeAudit = auditQoderResumeSession({
        profileDir: this.config.profileDir,
        sessionId: options.sessionId,
        workingDirectory,
        fs,
      });
      if (!resumeAudit.ok) {
        yield this.error(`qoder invoke rejected: resume audit failed: ${resumeAudit.reason}`);
        return;
      }
    }

    let binary = this.config.binary;
    if (!binary) {
      const resolved = resolveCliCommand('qodercn');
      if (!resolved) {
        yield this.error(formatCliNotFoundError('qodercn'));
        return;
      }
      binary = resolved;
    }

    const configuredToolAccess = this.config.toolAccess ?? 'disabled';
    const toolAccess: QoderToolAccess =
      configuredToolAccess === 'disabled' || options?.toolExecutionPolicy?.mode === 'read_only'
        ? 'disabled'
        : 'controlled';
    let controlledRuntime:
      | {
          memoryMcpServerPath: string;
          runtimeRoot: string;
          shellSandboxWrapperPath: string;
          sandboxBinary: string;
        }
      | undefined;
    if (toolAccess === 'controlled') {
      const memoryMcpServerPath = this.config.memoryMcpServerPath;
      const runtimeRoot = this.config.runtimeRoot;
      const shellSandboxWrapperPath = this.config.shellSandboxWrapperPath;
      if (!memoryMcpServerPath || !runtimeRoot || !shellSandboxWrapperPath) {
        yield this.error('qoder invoke rejected: controlled tools require runtime-owned MCP and shell sandbox paths');
        return;
      }
      const sandboxBinary = this.config.sandboxBinary ?? resolveCliCommand('sandbox-exec') ?? undefined;
      if (!sandboxBinary) {
        yield this.error('qoder invoke rejected: sandbox-exec is required for controlled Bash/Edit/Write access');
        return;
      }
      const runtimeAssets = validateQoderControlledRuntimePaths({
        memoryMcpServerPath,
        shellSandboxWrapperPath,
        sandboxBinary,
      });
      if (!runtimeAssets.ok) {
        yield this.error(`qoder invoke rejected: ${runtimeAssets.reason}`);
        return;
      }
      controlledRuntime = { memoryMcpServerPath, runtimeRoot, shellSandboxWrapperPath, sandboxBinary };
    }
    const expectedInit = toolAccess === 'controlled' ? CONTROLLED_INIT_EXPECTATION : DISABLED_INIT_EXPECTATION;
    let invocationLease: QoderInvocationLease | undefined;

    try {
      if (controlledRuntime) {
        invocationLease = createQoderInvocationLease({
          memoryMcpServerPath: controlledRuntime.memoryMcpServerPath,
          runtimeRoot: controlledRuntime.runtimeRoot,
          shellSandboxWrapperPath: controlledRuntime.shellSandboxWrapperPath,
          sandboxBinary: controlledRuntime.sandboxBinary,
          profileDir: this.config.profileDir,
          workingDirectory,
          callbackEnv: options?.callbackEnv,
        });
        (this.config.sandboxProbe ?? runQoderSandboxProbe)({
          childEnv: invocationLease.childEnv,
          denyCanaryPath: invocationLease.denyCanaryPath,
          ...(invocationLease.guardedGhPath ? { guardedGhPath: invocationLease.guardedGhPath } : {}),
          scratchDir: invocationLease.scratchDir,
          shellSandboxWrapperPath: controlledRuntime.shellSandboxWrapperPath,
        });
      }
      const args = buildQoderArgs({
        profileDir: this.config.profileDir,
        model: this.config.model,
        sessionId: options?.sessionId,
        toolAccess,
        ...(invocationLease ? { mcpConfigPath: invocationLease.mcpConfigPath, workingDirectory } : {}),
      });
      // P1④：显式 -m provenance —— argv 断言不过即 0 spawn
      assertExplicitModelFlag(args, this.config.model);

      // F299：正文/runtime/tool surface 形成后、spawn 前过 recorder —— 拒绝即 0 spawn；
      // 落档字节深冻（P1②），recorder 之后核验未被改写
      if (options?.beforeProviderLaunch) {
        const prepared = freezePreparedRequest({
          v: 1,
          message: { accuracy: 'exact', body: prompt },
          nativeInstructions: [],
          runtime: {
            provider: 'qoder',
            carrier: 'qodercn-cli',
            model: this.config.model,
            protocol: 'stream-json/1.4.0',
            toolExecutionPolicy: toolAccess === 'controlled' ? 'workspace_write' : 'read_only',
          },
          tools: {
            finalSurface: 'declared_only',
            declaredServerNames: toolAccess === 'controlled' ? [QODER_MEMORY_MCP_SERVER] : [],
          },
          providerNativeVisibility: 'unknown',
        });
        try {
          await options.beforeProviderLaunch(prepared);
        } catch (err) {
          yield this.error(`qoder invoke rejected by provider-request recorder: ${String(err)}`);
          return;
        }
        if (!('body' in prepared.message) || prepared.message.body !== prompt) {
          yield this.error('qoder invoke rejected: prepared request mutated across recorder boundary');
          return;
        }
      }

      // P1③：spawn/stdin(EPIPE 守卫)/有界终止/exit 等待/liveness 全部由共享 spawnCli 拥有；
      // 门内 fail-closed 终止（init 门红/时序违规）通过 break 触发其 finally 的
      // CliTerminationController 有界终止（SIGTERM → 等待 → SIGKILL，计时器 unref）
      const cliOpts = {
        command: binary,
        args,
        cwd: workingDirectory,
        stdinInput: prompt,
        env:
          invocationLease?.childEnv ??
          buildQoderEnvOverrides({
            profileDir: this.config.profileDir,
            callbackEnv: options?.callbackEnv,
            accountEnv: options?.accountEnv,
          }),
        managedArgvFlags: [
          '-p',
          '-m',
          '-o',
          '--config-dir',
          '--mcp-config',
          '--strict-mcp-config',
          '--allowed-mcp-server-names',
          '--tools',
          '--allowed-tools',
          '--setting-sources',
        ],
        ...(signal ? { signal } : {}),
        ...(options?.invocationId ? { invocationId: options.invocationId } : {}),
        ...(options?.cliSessionId ? { cliSessionId: options.cliSessionId } : {}),
        ...(options?.livenessProbe ? { livenessProbe: options.livenessProbe } : {}),
        ...(options?.parentSpan ? { parentSpan: options.parentSpan } : {}),
        // round-4 P1-2：与 Claude/Kimi/OpenCode 共享接线——rawArchivePath 让 __cliTimeout
        // 诊断能定位到本 invocation 的 raw archive
        ...(options?.invocationId && this.rawArchive.getPath
          ? { rawArchivePath: this.rawArchive.getPath(options.invocationId) }
          : {}),
      };
      // F089 seam（round-4 P1-2）：per-invocation spawnCliOverride（tmux-based spawner 等）
      // 优先于共享 spawnCli —— 路由/acceptance 只能经 options 注入，不得绕死
      const events = options?.spawnCliOverride
        ? options.spawnCliOverride(cliOpts)
        : spawnCli(cliOpts, this.config.spawnFn ? { spawnFn: this.config.spawnFn } : undefined);

      yield* this.consumeStream(events, expectedInit, toolAccess, options);
    } catch (err) {
      yield this.error(`qoder spawn failed: ${String(err)}`);
    } finally {
      invocationLease?.dispose();
    }
  }

  /** 真·流式：init 过门后逐条 yield；终态在流后收敛判定 */
  private async *consumeStream(
    events: AsyncGenerator<unknown, void, undefined>,
    expectedInit: QoderInitExpectation,
    toolAccess: QoderToolAccess,
    options?: AgentServiceOptions,
  ): AsyncIterable<AgentMessage> {
    const { catId, model } = this.config;
    let initSeen = false;
    let usage: TokenUsage | undefined;
    let billing: QoderBillingMetadata | undefined;
    let resultError: string | undefined;
    let successResultSeen = false;
    let unavailableToolRequestSeen = false;
    let actualModel: string | undefined;

    for await (const event of events) {
      // #780 先例：raw 事件过 sanitize 后 fire-and-forget 落档（仅诊断用途）
      if (options?.invocationId) {
        this.rawArchive
          .append(options.invocationId, sanitizeRawEvent(event))
          .catch((err) => log.warn({ catId, invocationId: options.invocationId, err }, 'Raw archive write failed'));
      }

      if (isLivenessWarning(event)) {
        const w = event as { level?: string; silenceDurationMs?: number };
        log.warn(
          { catId, level: w.level, silenceMs: w.silenceDurationMs },
          '[QoderAgent] liveness warning — CLI may be stuck',
        );
        continue;
      }
      if (isParseError(event)) {
        continue; // 非协议行：跳过（不喂方言层）
      }
      if (isCliTimeout(event)) {
        yield this.error(`qoder ${event.message}`);
        return;
      }
      if (isCliError(event)) {
        // P1①：humanized message（含 exit code）+ reasonCode；raw stderr 由共享层拥有，绝不内联
        yield this.error(
          `qoder process error: ${event.message}${event.reasonCode ? ` (reason: ${event.reasonCode})` : ''}`,
        );
        return;
      }

      const e = event as Record<string, unknown>;
      if (e.type === 'system' && e.subtype === 'init') {
        const gate = qoderInitGate(event, model, expectedInit);
        if (!gate.ok) {
          resultError = `qoder init gate failed (fail closed): ${gate.reason}`;
          break; // 触发 spawnCli finally 的共享有界终止
        }
        initSeen = true;
        actualModel = gate.model;
        const initOut = transformQoderEvent(event, catId);
        if (initOut) yield* flat(initOut);
        if (gate.cliDrift) {
          yield {
            type: 'system_info',
            catId,
            content: JSON.stringify({ type: 'qoder_cli_drift', catId, warning: gate.cliDrift }),
            timestamp: Date.now(),
          };
        }
        continue;
      }
      if (!initSeen && (e.type === 'assistant' || e.type === 'user')) {
        resultError = 'qoder stream violated ordering: assistant/user event before passing init gate';
        break;
      }
      if (qoderEventContainsTextToolProtocol(e)) unavailableToolRequestSeen = true;
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
      if (out) yield* flat(out);
    }

    if (resultError) {
      yield this.error(resultError);
      return;
    }
    if (!initSeen) {
      yield this.error('qoder stream ended without init event (fail closed)');
      return;
    }
    if (!successResultSeen) {
      yield this.error('qoder stream ended without a successful result event');
      return;
    }
    if (unavailableToolRequestSeen) {
      yield this.error(
        toolAccess === 'disabled'
          ? 'qoder requested a tool while the tool surface is disabled; no tool was executed'
          : 'qoder emitted an unavailable/unexecuted textual tool request; no tool was executed',
      );
      return;
    }

    const done: AgentMessage = { type: 'done', catId, timestamp: Date.now() };
    done.metadata = {
      provider: 'qoder',
      model: actualModel ?? 'unknown',
      requestedModel: model,
      modelProvenance: 'explicit-cli-flag',
      usage,
      ...(billing ? { qoderBilling: billing } : {}),
    } as unknown as NonNullable<AgentMessage['metadata']>;
    yield done;
  }

  /** F317 P1-B 初始能力画像：credits 只进 typed billing metadata，不进 TokenUsage；
   *  无 runtime window 上报、无权威 usage、无 native 窗口/压缩控制 */
  contextCapability(): import('../../types.js').AgentContextCapability {
    return {
      provider: 'qoder',
      carrier: 'qodercn-cli',
      reportsRuntimeWindow: false,
      authoritativeUsage: false,
      usageTelemetry: 'unavailable',
      nativeWindowControl: false,
      nativeCompressionControl: false,
      observesCompression: false,
      reason:
        'F317 P1-B: credits observed via typed billing metadata only; runtime window and authoritative usage unproven for this carrier',
    };
  }

  private error(message: string): AgentMessage {
    return { type: 'error', catId: this.config.catId, error: message, timestamp: Date.now() };
  }
}

async function* flat(out: AgentMessage | AgentMessage[]): AsyncGenerator<AgentMessage> {
  if (Array.isArray(out)) {
    for (const m of out) yield m;
  } else {
    yield out;
  }
}
