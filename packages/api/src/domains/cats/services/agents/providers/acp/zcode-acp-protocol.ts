/** Shared ZCode ACP adapter types and 0.16.3 protocol helpers. */

import { chmodSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type JsonRpc = {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};

export type TurnFailure = { code?: string; message?: string };

export type TurnEvent = {
  delta?: string;
  terminal?: 'completed' | 'failed' | 'cancelled';
  failure?: TurnFailure;
};

export type ZcodeNativeModel = {
  providerId: string;
  modelId: string;
  variant?: string;
};

export function flattenAcpPrompt(prompt: unknown): string {
  if (typeof prompt === 'string') return prompt;
  if (!Array.isArray(prompt)) return '';
  const parts: string[] = [];
  for (const block of prompt) {
    if (typeof block === 'string') parts.push(block);
    else if (block && typeof block === 'object' && 'text' in block && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('');
}

export function zcodeLaunchPlan(bin: string): { command: string; args: string[] } {
  const args = ['app-server', '--surface', 'terminal', '--mode', 'yolo'];
  if (bin.endsWith('.cjs') || bin.endsWith('.js') || bin.endsWith('.mjs')) {
    return { command: process.execPath, args: [bin, ...args] };
  }
  return { command: bin, args };
}

type TurnPayload = {
  kind?: string;
  delta?: string;
  resultType?: string;
  error?: { type?: string; code?: string; message?: string };
  turnPhase?: string;
};

export function parseTurnEvent(msg: JsonRpc, sessionId: string): TurnEvent | undefined {
  if (msg.method !== 'session/event') return undefined;
  const params = (msg.params ?? {}) as { type?: string; payload?: TurnPayload; sessionId?: string };
  if (params.sessionId && params.sessionId !== sessionId) return undefined;
  const payload = params.payload ?? {};
  if (params.type === 'model.streaming' && payload.kind === 'text_delta' && payload.delta) {
    return { delta: payload.delta };
  }
  if (params.type === 'turn.completed' || params.type === 'turn.terminal') {
    if (payload.resultType === 'cancelled') return { terminal: 'cancelled' };
    if (payload.resultType && payload.resultType !== 'success') {
      return { terminal: 'failed', failure: { code: payload.resultType } };
    }
    return { terminal: 'completed' };
  }
  if (params.type === 'turn.failed') {
    const nested = payload.error;
    return {
      terminal: 'failed',
      failure: {
        code: nested?.code ?? nested?.type,
        message: nested?.message,
      },
    };
  }
  return undefined;
}

const CREDENTIAL_KEY = 'ANTHROPIC_API_KEY|ZCODE_API_KEY|x-api-key|api[_-]?key|access[_-]?token|secret|authorization';

const SECRET_PATTERNS: readonly RegExp[] = [
  new RegExp(`"(?:${CREDENTIAL_KEY})"\\s*:\\s*"(?:\\\\.|[^"\\\\])*"`, 'gi'),
  new RegExp(`'(?:${CREDENTIAL_KEY})'\\s*:\\s*'(?:\\\\.|[^'\\\\])*'`, 'gi'),
  new RegExp(`\\b(?:${CREDENTIAL_KEY})\\s*[:=]\\s*["']?[^\\s"']+`, 'gi'),
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bBearer\s+[A-Za-z0-9._\-+=/]+\b/gi,
];

export function sanitizeZcodeFailureText(value: string): string {
  let out = value;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, '[redacted]');
  }
  out = out.replace(/\b(ANTHROPIC_API_KEY|ZCODE_API_KEY)\b/g, '[redacted-env]');
  out = out.replace(/[A-Za-z0-9+/_-]{48,}={0,2}/g, '[redacted]');
  return out.slice(0, 400);
}

export function formatZcodeTurnFailure(failure: TurnFailure | undefined): string {
  const code = sanitizeZcodeFailureText(failure?.code?.trim() || 'turn.failed');
  const message = sanitizeZcodeFailureText(failure?.message?.trim() || 'ZCode turn failed');
  return `zcode ${code}: ${message}`;
}

export function extractZcodeFailure(error: unknown): TurnFailure {
  if (typeof error === 'string') return { message: error };
  if (error instanceof Error) return { code: error.name, message: error.message };
  if (!error || typeof error !== 'object') return { message: 'ZCode native error' };
  const rec = error as Record<string, unknown>;
  const nested = rec.error && typeof rec.error === 'object' ? (rec.error as Record<string, unknown>) : rec;
  const code = nested.code ?? nested.type;
  const message = nested.message;
  return {
    code: typeof code === 'string' || typeof code === 'number' ? String(code) : undefined,
    message: typeof message === 'string' ? message : undefined,
  };
}

const KNOWN_MODEL_ALIASES: Readonly<Record<string, ZcodeNativeModel>> = {
  'glm-5.2': { providerId: 'zai', modelId: 'glm-5.2' },
  'glm-5.1': { providerId: 'zai', modelId: 'glm-5.1' },
  'glm-5.3': { providerId: 'zai', modelId: 'glm-5.3' },
};

function trimmedNonEmpty(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function parseZcodeNativeModel(raw: string | undefined): ZcodeNativeModel | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== 'object') return undefined;
      const rec = parsed as Record<string, unknown>;
      const providerId = trimmedNonEmpty(rec.providerId);
      const modelId = trimmedNonEmpty(rec.modelId);
      const variant = trimmedNonEmpty(rec.variant);
      if (!providerId || !modelId) return undefined;
      return variant ? { providerId, modelId, variant } : { providerId, modelId };
    } catch {
      return undefined;
    }
  }
  const slash = trimmed.indexOf('/');
  if (slash > 0) {
    const providerId = trimmed.slice(0, slash).trim();
    const rest = trimmed.slice(slash + 1).trim();
    if (!providerId || !rest) return undefined;
    const colon = rest.indexOf(':');
    const modelId = (colon > 0 ? rest.slice(0, colon) : rest).trim();
    const variant = colon > 0 ? rest.slice(colon + 1).trim() : '';
    if (!modelId) return undefined;
    return variant ? { providerId, modelId, variant } : { providerId, modelId };
  }
  const alias = KNOWN_MODEL_ALIASES[trimmed.toLowerCase()];
  return alias ? { ...alias } : undefined;
}

export function requireZcodeNativeModel(env: NodeJS.ProcessEnv): ZcodeNativeModel {
  const model = parseZcodeNativeModel(env.ZCODE_MODEL);
  if (!model) {
    throw new Error(
      'ZCODE_MODEL must be a 0.16.3 {providerId,modelId} ref such as zai/glm-5.2 or catalog GLM-5.2',
    );
  }
  return model;
}

export function hasZcodeProviderCredential(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.ANTHROPIC_API_KEY?.trim() || env.ZCODE_API_KEY?.trim());
}

export type ZcodeSpawnReadyResult = { ok: true; model: ZcodeNativeModel } | { ok: false; error: Error };

export function diagnoseZcodeSpawnReady(env: NodeJS.ProcessEnv): ZcodeSpawnReadyResult {
  const model = parseZcodeNativeModel(env.ZCODE_MODEL);
  if (!model) {
    return {
      ok: false,
      error: new Error(
        'ZCode ACP skipped: ZCODE_MODEL must map to 0.16.3 {providerId,modelId}. Use zai/glm-5.2 or catalog GLM-5.2.',
      ),
    };
  }
  if (!hasZcodeProviderCredential(env)) {
    return {
      ok: false,
      error: new Error(
        'ZCode ACP skipped: no provider credential. Bind a Hub API-key account to @zcode, or export ANTHROPIC_API_KEY before starting Hub. Hub uses an isolated app-server home; do not write the user ~/.zcode.',
      ),
    };
  }
  return { ok: true, model };
}

export function resolveZcodeIsolatedHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CAT_CAFE_ZCODE_HOME?.trim();
  if (override) return override;
  const catCafeHome = env.CAT_CAFE_HOME?.trim();
  const root = catCafeHome || join(env.HOME?.trim() || homedir(), '.cat-cafe');
  return join(root, 'zcode', 'app-server-home');
}

export function ensureZcodeIsolatedHome(home: string): string {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  try {
    chmodSync(home, 0o700);
  } catch {
    /* best-effort on platforms that ignore mode */
  }
  return home;
}

export function zcodeAppServerEnv(parent: NodeJS.ProcessEnv, isolatedHome: string): NodeJS.ProcessEnv {
  return {
    ...parent,
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    XDG_CONFIG_HOME: join(isolatedHome, '.config'),
    XDG_DATA_HOME: join(isolatedHome, '.local', 'share'),
    XDG_STATE_HOME: join(isolatedHome, '.local', 'state'),
    XDG_CACHE_HOME: join(isolatedHome, '.cache'),
  };
}

export function zcodeWorkspace(cwd: string): { workspacePath: string; workspaceKey: string } {
  return { workspacePath: cwd, workspaceKey: cwd };
}

export function readZcodeSessionId(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const rec = result as Record<string, unknown>;
  const session = rec.session;
  if (session && typeof session === 'object') {
    const sessionId = (session as { sessionId?: unknown }).sessionId;
    if (typeof sessionId === 'string' && sessionId.trim()) return sessionId;
  }
  return typeof rec.sessionId === 'string' && rec.sessionId.trim() ? rec.sessionId : undefined;
}
