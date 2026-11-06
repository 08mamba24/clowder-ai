import type { FamilyToolDefinition, McpServerFamily } from './tool-governance-snapshot.js';
import type { McpToolDefinition } from './tool-governance-types.js';

export type CanonicalToolSources = Readonly<Record<McpServerFamily, readonly McpToolDefinition[]>>;

export type CanonicalToolsetEnv = {
  readonly?: boolean;
  hasAgentKey?: boolean;
  desktopMode?: string;
  /** Explicit opt-in for the readonly+agent-key union. */
  agentKeyUnion?: boolean;
  /**
   * Explicit launcher capability bit for invocation/agent-key callback
   * credentials. `false` means this mount cannot authenticate callback calls
   * (for example the Qoder readonly memory shim, which only receives identity
   * vars). `undefined` preserves the historical surface for every other mount.
   *
   * This is a declaration, never a runtime probe: the projection must not call
   * getCallbackConfig() or guess from incidental environment variables.
   */
  callbackCredentials?: boolean;
};

/**
 * A tool is callback-only when none of its declared authorization paths can be
 * satisfied by the local process. Such tools are advertised only on mounts that
 * explicitly declare callback credentials.
 */
function hasLocalProcessAuthorization(definition: FamilyToolDefinition): boolean {
  const operation = definition.operation;
  const paths =
    operation.kind === 'single'
      ? operation.boundary.authorizationPaths
      : operation.variants.flatMap((variant) => variant.boundary.authorizationPaths);
  return paths.some((path) => path.credentialSource === 'local-process');
}

export function callbackOnlyToolNames(registry: readonly FamilyToolDefinition[]): ReadonlySet<string> {
  return new Set(registry.filter((definition) => !hasLocalProcessAuthorization(definition)).map((d) => d.name));
}

function applyCallbackCapability(
  tools: readonly FamilyToolDefinition[],
  env: CanonicalToolsetEnv,
): readonly FamilyToolDefinition[] {
  if (env.callbackCredentials !== false) return tools;
  return tools.filter(hasLocalProcessAuthorization);
}

const DESKTOP_PROFILES = {
  'fable-phase0': 'desktop:fable-phase0',
  'cloud-pro-phase0': 'desktop:cloud-pro-phase0',
  'live-companion': 'desktop:live-companion',
} as const;

function assertGovernedDefinition(definition: McpToolDefinition): void {
  const candidate = definition as Partial<McpToolDefinition>;
  const annotations = candidate.annotations;
  if (
    !candidate.operation ||
    !candidate.implementation?.ref ||
    !candidate.policy?.resourceFamily?.trim() ||
    !candidate.policy.schemaDelivery?.policy ||
    !candidate.policy.runtimeProfiles?.length ||
    !candidate.actionInventory?.length ||
    !candidate.effectiveRisk ||
    !annotations ||
    typeof annotations.readOnlyHint !== 'boolean' ||
    typeof annotations.destructiveHint !== 'boolean' ||
    typeof annotations.openWorldHint !== 'boolean'
  ) {
    throw new Error(`MCP tool ${candidate.name ?? '<unnamed>'} is missing its governance certificate`);
  }
  if (
    candidate.policy.resourceFamily === 'plugin-manager' &&
    candidate.policy.runtimeProfiles.includes('readonly') &&
    candidate.effectiveRisk.level !== 'read'
  ) {
    throw new Error(`Plugin Manager tool ${candidate.name ?? '<unnamed>'} exposes a write operation in readonly`);
  }
}

export function buildCanonicalToolRegistry(sources: CanonicalToolSources): readonly FamilyToolDefinition[] {
  const registry = (Object.entries(sources) as [McpServerFamily, readonly McpToolDefinition[]][]).flatMap(
    ([serverFamily, definitions]) =>
      definitions.map((definition) => {
        assertGovernedDefinition(definition);
        return { ...definition, serverFamily };
      }),
  );
  const seen = new Set<string>();
  for (const definition of registry) {
    if (seen.has(definition.name)) throw new Error(`Duplicate canonical MCP tool: ${definition.name}`);
    seen.add(definition.name);
  }
  return registry.sort((left, right) => left.name.localeCompare(right.name));
}

export function projectCanonicalToolRegistry(
  registry: readonly FamilyToolDefinition[],
  env: CanonicalToolsetEnv,
): readonly FamilyToolDefinition[] {
  const project = (selected: readonly FamilyToolDefinition[]) => applyCallbackCapability(selected, env);
  if (env.desktopMode) {
    const profile = DESKTOP_PROFILES[env.desktopMode as keyof typeof DESKTOP_PROFILES];
    if (!profile) {
      throw new Error(
        `Unknown CAT_CAFE_DESKTOP_MODE: "${env.desktopMode}". Valid modes: ${Object.keys(DESKTOP_PROFILES).join(', ')}`,
      );
    }
    return project(registry.filter((definition) => definition.policy.runtimeProfiles.includes(profile)));
  }
  if (!env.readonly) {
    return project(registry.filter((definition) => definition.policy.runtimeProfiles.includes('full')));
  }
  // readonly is strict unless the launcher explicitly opted into the
  // agent-key union (agentKeyUnion) AND agent-key credentials are present.
  // Incidental CAT_CAFE_AGENT_KEY_* vars inherited from a parent environment
  // no longer widen a read-only mount.
  return project(
    registry.filter(
      (definition) =>
        definition.policy.runtimeProfiles.includes('readonly') ||
        (!!env.agentKeyUnion && !!env.hasAgentKey && definition.policy.runtimeProfiles.includes('agent-key')),
    ),
  );
}

export function projectServerFamily(
  registry: readonly FamilyToolDefinition[],
  serverFamily: McpServerFamily,
  env: CanonicalToolsetEnv,
): readonly FamilyToolDefinition[] {
  return projectCanonicalToolRegistry(
    registry.filter((definition) => definition.serverFamily === serverFamily),
    env,
  );
}

export function derivedProfileSet(
  registry: readonly FamilyToolDefinition[],
  profile: FamilyToolDefinition['policy']['runtimeProfiles'][number],
): ReadonlySet<string> {
  return new Set(
    registry
      .filter((definition) => definition.policy.runtimeProfiles.includes(profile))
      .map((definition) => definition.name),
  );
}
