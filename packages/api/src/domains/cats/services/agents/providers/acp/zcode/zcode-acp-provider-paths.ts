import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { normalizeZcodeAnthropicBaseUrl, readZcodeEnvModel } from './zcode-acp-protocol.js';

/** Resolve the selected installation, never a different App's provider catalog. */
export function zcodeProviderPaths(bin: string): Record<string, string> {
  const entryDir = dirname(realpathSync(bin));
  // CLI distributions use an adjacent provider/; desktop bundles put config/
  // beside glm/. CLI 0.16.5 does not discover that desktop layout itself.
  const candidates = [
    join(entryDir, 'provider', 'zcode-builtin.json'),
    join(entryDir, '..', 'config', 'provider', 'zcode-builtin.json'),
  ];
  const builtin = candidates.find((path) => existsSync(path) && statSync(path).isFile());
  if (!builtin) {
    throw new Error(`ZCode provider config missing for selected CLI ${bin}. Expected: ${candidates.join(', ')}`);
  }
  return {
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtin,
  };
}

/**
 * Native 0.16.5 selects models from schemaVersion 1 provider rules, not
 * ZCODE_MODEL. This generated input belongs to one child; session data stays
 * in the persistent isolated home. Never overwrite a shared personal config.
 */
export function createZcodeProviderConfig(home: string, env: NodeJS.ProcessEnv): { path: string; dispose: () => void } {
  removeAbandonedProviderInputs(home);
  const modelId = readZcodeEnvModel(env.ZCODE_MODEL);
  const providerId = 'anthropic';
  const config = {
    providerConfigRules: {
      providerRules: modelId
        ? [
            {
              providerId,
              providerName: 'Clowder AI',
              config: {
                group: 'standard-personal',
                access: { type: 'api-key', apiKey: env.ANTHROPIC_API_KEY?.trim() || env.ZCODE_API_KEY?.trim() },
                api: {
                  type: 'anthropic-messages',
                  baseUrl: normalizeZcodeAnthropicBaseUrl(env.ANTHROPIC_BASE_URL) || 'https://api.anthropic.com/v1',
                },
                personalModelIds: [modelId],
                modelOrder: [modelId],
              },
            },
          ]
        : [],
    },
    modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
    ...(modelId ? { defaultModelSelection: { providerId, modelId } } : {}),
  };
  const dir = mkdtempSync(join(home, `.provider-runtime-${process.pid}-`));
  const path = join(dir, 'provider.json');
  const dispose = (): void => rmSync(dir, { recursive: true, force: true });
  try {
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, config }), { mode: 0o600 });
  } catch (error) {
    dispose();
    throw error;
  }
  return { path, dispose };
}

/** Only these generated inputs are ephemeral. Native history is never swept. */
function removeAbandonedProviderInputs(home: string): void {
  for (const entry of readdirSync(home, { withFileTypes: true })) {
    const owner = /^\.provider-runtime-([1-9][0-9]*)-[A-Za-z0-9]+$/.exec(entry.name);
    if (!entry.isDirectory() || !owner) continue;
    const pid = Number(owner[1]);
    if (!Number.isSafeInteger(pid) || pid > 2147483647) continue;
    let gone = false;
    try {
      process.kill(pid, 0);
    } catch (error) {
      gone = (error as NodeJS.ErrnoException).code === 'ESRCH';
    }
    // EPERM and PID reuse both leave the directory alone. A live owner's
    // provider polling must never be affected by another adapter starting.
    if (gone) rmSync(join(home, entry.name), { recursive: true, force: true });
  }
}
