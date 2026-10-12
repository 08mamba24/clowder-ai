import type { Dispatch, SetStateAction } from 'react';
import type { BuiltinAccountClient } from './hub-accounts.types';
import { HubIcon } from './hub-icons';
import { TagEditor } from './hub-tag-editor';
import { formInputClass } from './mcp-form-helpers';

/** Match accounts-schemas.ts: mixed-case tails are valid, CAT_CAFE_ stays reserved. */
export function isValidAccountEnvKey(key: string): boolean {
  return /^[A-Z_][A-Za-z0-9_]*$/.test(key) && !key.startsWith('CAT_CAFE_');
}
/** Suggested models per client — kept in sync with cat-template.json clientDefaults. */
const MODEL_SUGGESTIONS: Partial<Record<BuiltinAccountClient, string[]>> = {
  anthropic: [
    'claude-sonnet-4-6',
    'claude-opus-4-6',
    'claude-opus-4-6[1m]',
    'claude-sonnet-4-5-20250929',
    'claude-opus-4-5-20251101',
  ],
  openai: ['gpt-5.4', 'gpt-5.3-codex', 'gpt-5.3-codex-spark'],
  google: [
    'Gemini 3.1 Pro (High)',
    'Gemini 3.1 Pro (Low)',
    'Gemini 3.6 Flash (High)',
    'Gemini 3.5 Flash (High)',
    'Claude Opus 4.6 (Thinking)',
  ],
  opencode: ['claude-sonnet-4-6', 'claude-opus-4-6'],
};

export function AccountConnectionFields({
  isOAuth,
  isCodexLogin,
  isEdit,
  initialClientId,
  clientId,
  baseUrl,
  setBaseUrl,
  apiKey,
  setApiKey,
  models,
  setModels,
  envEntries,
  setEnvEntries,
  advancedOpen,
  setAdvancedOpen,
  clearError,
}: {
  isOAuth: boolean;
  isCodexLogin: boolean;
  isEdit: boolean;
  initialClientId?: BuiltinAccountClient;
  clientId?: BuiltinAccountClient;
  baseUrl: string;
  setBaseUrl: (value: string) => void;
  apiKey: string;
  setApiKey: (value: string) => void;
  models: string[];
  setModels: (value: string[]) => void;
  envEntries: Array<{ key: string; value: string }>;
  setEnvEntries: (value: Array<{ key: string; value: string }>) => void;
  advancedOpen: boolean;
  setAdvancedOpen: Dispatch<SetStateAction<boolean>>;
  clearError: () => void;
}) {
  return (
    <>
      {/* API Key mode: Base URL + API Key */}
      {!isOAuth && (
        <>
          <div>
            <label className="mb-1 block text-xs font-medium text-cafe-secondary">API 服务地址 (Base URL)</label>
            <input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.openai.com/v1"
              className={formInputClass}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-cafe-secondary">
              API Key{isEdit && '（留空保持不变）'}
            </label>
            <input
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value);
                clearError();
              }}
              placeholder={isEdit ? '••••••••••••' : 'sk-...'}
              className={formInputClass}
            />
          </div>
        </>
      )}

      {(!isCodexLogin || isEdit) && (
        <>
          {/* 可用模型 */}
          <div>
            <label className="mb-1 block text-xs font-medium text-cafe-secondary">可用模型</label>
            <TagEditor
              tags={models}
              tone="purple"
              addLabel="+ 添加"
              placeholder="输入模型名"
              emptyLabel={isOAuth ? '(可选，留空使用默认模型)' : '(至少添加 1 个模型)'}
              onChange={setModels}
              minCount={0}
            />
            {/* Model suggestions for builtin clients */}
            {isOAuth &&
              clientId &&
              (MODEL_SUGGESTIONS[initialClientId ?? clientId] ?? []).filter((m) => !models.includes(m)).length > 0 && (
                <div className="mt-1.5 flex flex-wrap items-center gap-1">
                  <span className="text-micro text-cafe-muted">推荐</span>
                  {(MODEL_SUGGESTIONS[initialClientId ?? clientId] ?? [])
                    .filter((m) => !models.includes(m))
                    .map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => setModels([...models, m])}
                        className="rounded-full border border-dashed border-[var(--console-border-soft)] px-2 py-0.5 text-micro text-cafe-secondary transition hover:border-cafe-accent hover:text-cafe-accent"
                      >
                        + {m}
                      </button>
                    ))}
                </div>
              )}
          </div>

          {/* F171: 高级配置 — collapsible env var injection */}
          <div className="rounded-lg border border-[var(--console-border-soft)]">
            <button
              type="button"
              onClick={() => setAdvancedOpen((v) => !v)}
              className="flex w-full items-center gap-1 px-3 py-2 text-xs font-medium text-cafe-secondary hover:bg-[var(--console-card-bg)]"
            >
              <span className="text-micro">{advancedOpen ? '\u25BE' : '\u25B8'}</span>
              高级配置 (可选)
            </button>
            {advancedOpen && (
              <div className="console-divider-t px-3 pb-3 pt-2">
                <p className="mb-2 text-micro text-cafe-muted">
                  自定义环境变量，启动 agent 时注入子进程 (CAT_CAFE_ 前缀为保留变量)
                </p>
                <div className="space-y-1.5">
                  {envEntries.map((entry, i) => (
                    <div key={i} className="flex items-center gap-1.5">
                      <div className="w-[38%] shrink-0">
                        <input
                          value={entry.key}
                          onChange={(e) => {
                            const next = [...envEntries];
                            next[i] = { ...next[i], key: e.target.value };
                            setEnvEntries(next);
                          }}
                          placeholder="KEY"
                          className={`font-mono ${
                            entry.key.trim() && !isValidAccountEnvKey(entry.key.trim())
                              ? `${formInputClass} !border-semantic-critical !bg-semantic-critical-surface !text-semantic-critical`
                              : formInputClass
                          }`}
                        />
                      </div>
                      <span className="text-micro text-cafe-muted">=</span>
                      <div className="min-w-0 flex-1">
                        <input
                          value={entry.value}
                          onChange={(e) => {
                            const next = [...envEntries];
                            next[i] = { ...next[i], value: e.target.value };
                            setEnvEntries(next);
                          }}
                          placeholder="value"
                          className={`font-mono ${formInputClass}`}
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => setEnvEntries(envEntries.filter((_, j) => j !== i))}
                        className="text-xs text-cafe-muted hover:text-semantic-critical"
                        title="删除"
                      >
                        <HubIcon name="trash" className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                  {envEntries.some((e) => e.key.trim() && !isValidAccountEnvKey(e.key.trim())) && (
                    <p className="text-micro text-semantic-critical">
                      {envEntries.some((e) => e.key.trim().startsWith('CAT_CAFE_')) ? 'CAT_CAFE_ 前缀为系统保留；' : ''}
                      变量名须以大写字母或下划线开头，后续可含 A-Z、a-z、0-9、_
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => setEnvEntries([...envEntries, { key: '', value: '' }])}
                  className="mt-2 text-micro font-medium text-cafe-accent hover:text-cafe-accent-hover"
                >
                  + 添加变量
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}
