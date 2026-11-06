import type { AtomicCutoverManifest, CutoverFinding, CutoverSurfaceEntry } from './tool-cutover.js';
import { digestGovernanceValue } from './tool-governance-bootstrap.js';

type CompositionInput = {
  before: readonly CutoverSurfaceEntry[];
  after: readonly CutoverSurfaceEntry[];
  manifests: readonly AtomicCutoverManifest[];
  protectedTargetSha?: string;
};

function hasFamilyDelta(input: CompositionInput, family: string): boolean {
  const before = new Map(
    input.before.filter((entry) => entry.resourceFamily === family).map((entry) => [entry.name, entry]),
  );
  const after = new Map(
    input.after.filter((entry) => entry.resourceFamily === family).map((entry) => [entry.name, entry]),
  );
  return (
    [...after.keys()].some((name) => !before.has(name)) ||
    [...before.values()].some((entry) => {
      const current = after.get(entry.name);
      return !current || entry.runtimeProfiles.some((profile) => !current.runtimeProfiles.includes(profile));
    })
  );
}

function validComposition(value: unknown): value is NonNullable<AtomicCutoverManifest['composition']> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    JSON.stringify(Object.keys(record).sort()) ===
      JSON.stringify(['historicalManifestDigests', 'protectedTargetSha']) &&
    typeof record.protectedTargetSha === 'string' &&
    /^[a-f0-9]{40}$/.test(record.protectedTargetSha) &&
    Array.isArray(record.historicalManifestDigests) &&
    record.historicalManifestDigests.length > 0 &&
    record.historicalManifestDigests.every(
      (digest) => typeof digest === 'string' && /^sha256:[a-f0-9]{64}$/.test(digest),
    ) &&
    new Set(record.historicalManifestDigests).size === record.historicalManifestDigests.length
  );
}

function historicalMatches(input: CompositionInput, digest: string, manifestIndex: number, family: string): number[] {
  return input.manifests.flatMap((historical, index) =>
    index !== manifestIndex &&
    historical.composition === undefined &&
    historical.resource.kind === 'family' &&
    historical.resource.resourceFamily === family &&
    digestGovernanceValue(historical) === digest
      ? [index]
      : [],
  );
}

function resolveHistoricalIndexes(
  input: CompositionInput,
  composition: NonNullable<AtomicCutoverManifest['composition']>,
  manifestIndex: number,
  family: string,
): number[] | undefined {
  const historicalIndexes: number[] = [];
  for (const digest of composition.historicalManifestDigests) {
    const matches = historicalMatches(input, digest, manifestIndex, family);
    const [historicalIndex] = matches;
    if (matches.length !== 1 || historicalIndex === undefined) return undefined;
    historicalIndexes.push(historicalIndex);
  }
  return historicalIndexes;
}

export function resolveCutoverCompositions(input: CompositionInput): {
  historicalManifestIndexes: ReadonlySet<number>;
  findings: readonly CutoverFinding[];
} {
  const historicalManifestIndexes = new Set<number>();
  const findings: CutoverFinding[] = [];
  input.manifests.forEach((manifest, manifestIndex) => {
    if (manifest.composition === undefined) return;
    const invalid = (message: string) => findings.push({ code: 'invalid-cutover-composition', manifestIndex, message });
    if (!validComposition(manifest.composition) || manifest.resource.kind !== 'family') {
      invalid('Cutover composition requires a closed exact-target contract for one resource family');
      return;
    }
    const composition = manifest.composition;
    if (manifest.rollbackRevision !== composition.protectedTargetSha) {
      invalid('Cutover composition rollback revision must equal its exact protected target');
      return;
    }
    const family = manifest.resource.resourceFamily;
    const historicalIndexes = resolveHistoricalIndexes(input, composition, manifestIndex, family);
    if (!historicalIndexes) {
      invalid('Cutover composition must identify one unchanged historical manifest of the same family per digest');
      return;
    }
    // A landed aggregate remains evidence, but cannot keep authorizing future transitions.
    if (!hasFamilyDelta(input, family)) return;
    if (!input.protectedTargetSha || composition.protectedTargetSha !== input.protectedTargetSha) {
      invalid('Active cutover composition does not match the exact protected target');
      return;
    }
    historicalIndexes.forEach((index) => {
      historicalManifestIndexes.add(index);
    });
  });
  return { historicalManifestIndexes, findings };
}
