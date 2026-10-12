import type {
  ActionSuccessorHolderOutcome,
  ActionSuccessorLease,
  ActionSuccessorReplacementTransition,
} from './action-successor-state-machine.js';

const terminalDelegateLineageOutcomes: ReadonlySet<ActionSuccessorHolderOutcome> = new Set([
  'failed',
  'canceled',
  'unavailable',
]);

export interface ActionSuccessorDelegateLineageRoute {
  ownerCatId: string;
  ownerThreadId: string;
  childThreadId: string;
}

export function sameSingleActionSuccessorHolder(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  return left?.length === 1 && right?.length === 1 && left[0] === right[0];
}

export function isTerminalDelegateLineageOutcome(outcome: ActionSuccessorHolderOutcome | undefined): boolean {
  return outcome !== undefined && terminalDelegateLineageOutcomes.has(outcome);
}

export function replacementTransitionMatchesDelegateLineage(
  transition: ActionSuccessorReplacementTransition,
  route: ActionSuccessorDelegateLineageRoute,
): boolean {
  const terminalOutcomes = Object.values(transition.holderOutcomes);
  const hasValidReasonEvidence =
    transition.reason === 'interrupted'
      ? terminalOutcomes.length === 0
      : sameSingleActionSuccessorHolder(Object.keys(transition.holderOutcomes), transition.fromHolderCatIds) &&
        terminalOutcomes.every(
          (entry) =>
            isTerminalDelegateLineageOutcome(entry.outcome) &&
            entry.evidenceRef.trim().length > 0 &&
            Number.isFinite(entry.at),
        );
  return (
    transition.fromGeneration >= 1 &&
    transition.toGeneration === transition.fromGeneration + 1 &&
    transition.fromHolderCatIds.length === 1 &&
    Boolean(transition.fromHolderCatIds[0]?.trim()) &&
    transition.toHolderCatIds.length === 1 &&
    Boolean(transition.toHolderCatIds[0]?.trim()) &&
    transition.fromHolderThreadId === route.childThreadId &&
    transition.toHolderThreadId === route.childThreadId &&
    transition.issuerCatId === route.ownerCatId &&
    transition.issuerThreadId === route.ownerThreadId &&
    transition.evidenceRefs.length > 0 &&
    transition.evidenceRefs.every((ref) => ref.trim().length > 0) &&
    Number.isFinite(transition.at) &&
    hasValidReasonEvidence
  );
}

export function boundGenerationHasTerminalDelegateOutcome(
  lease: ActionSuccessorLease,
  generation: number,
  expectedReporterCatIds: readonly string[] | undefined,
  childThreadId: string,
): boolean {
  if (
    lease.generation !== generation ||
    lease.status !== 'replaceable' ||
    lease.holderThreadId !== childThreadId ||
    !sameSingleActionSuccessorHolder(lease.holderCatIds, expectedReporterCatIds) ||
    Object.keys(lease.completionCandidates).length > 0
  ) {
    return false;
  }
  const outcomes = Object.values(lease.holderOutcomes);
  return outcomes.length === 1 && isTerminalDelegateLineageOutcome(outcomes[0]?.outcome);
}

export function isCurrentDelegateLineageGeneration(input: {
  lease: ActionSuccessorLease;
  route: ActionSuccessorDelegateLineageRoute;
  generation: number;
  reporterCatIds: readonly string[];
}): boolean {
  const { lease, route, generation, reporterCatIds } = input;
  const activeReturnEdge = lease.returnTransitions.some(
    (entry) =>
      entry.toGeneration + 1 === lease.generation &&
      entry.predecessorCatId === route.ownerCatId &&
      entry.predecessorThreadId === route.ownerThreadId &&
      entry.rejectingThreadId === route.childThreadId,
  );
  const activeReplacementEdge = (lease.replacementTransitions ?? []).some(
    (entry) =>
      entry.toGeneration === lease.generation &&
      sameSingleActionSuccessorHolder(entry.toHolderCatIds, reporterCatIds) &&
      replacementTransitionMatchesDelegateLineage(entry, route),
  );
  return (
    lease.generation === generation &&
    lease.status === 'active' &&
    lease.holderThreadId === route.childThreadId &&
    reporterCatIds.length === 1 &&
    lease.predecessorCatId === route.ownerCatId &&
    lease.predecessorThreadId === route.ownerThreadId &&
    Object.keys(lease.holderOutcomes).length === 0 &&
    Object.keys(lease.completionCandidates).length === 0 &&
    (activeReturnEdge || activeReplacementEdge)
  );
}

export function delegateLineageGenerationWasSuperseded(input: {
  lease: ActionSuccessorLease;
  route: ActionSuccessorDelegateLineageRoute;
  generation: number;
  expectedReporterCatIds: readonly string[] | undefined;
}): boolean {
  const { lease, route, generation, expectedReporterCatIds } = input;
  if (boundGenerationHasTerminalDelegateOutcome(lease, generation, expectedReporterCatIds, route.childThreadId)) {
    return true;
  }
  if (lease.generation <= generation) return false;
  const supersedingReturn = lease.returnTransitions.some(
    (entry) =>
      entry.fromGeneration === generation &&
      entry.toGeneration === generation + 1 &&
      entry.rejectingCatId === expectedReporterCatIds?.[0] &&
      entry.rejectingThreadId === route.childThreadId &&
      entry.predecessorCatId === route.ownerCatId &&
      entry.predecessorThreadId === route.ownerThreadId,
  );
  const supersedingReplacement = (lease.replacementTransitions ?? []).some(
    (entry) =>
      entry.fromGeneration === generation &&
      sameSingleActionSuccessorHolder(entry.fromHolderCatIds, expectedReporterCatIds) &&
      replacementTransitionMatchesDelegateLineage(entry, route),
  );
  return supersedingReturn || supersedingReplacement;
}
