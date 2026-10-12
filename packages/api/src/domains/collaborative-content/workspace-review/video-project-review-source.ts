import type {
  VideoProjectReviewAnchor,
  VideoProjectReviewSource,
  WorkspaceContentAnnotationResolution,
  WorkspaceContentReview,
  WorkspaceContentReviewView,
} from '@cat-cafe/shared';
import type { VideoProjectPrincipal } from '../../video-studio/project/access.js';
import type {
  VideoProjectReadPort as VideoProjectReviewPort,
  VideoProjectSnapshot,
} from '../../video-studio/project/types.js';
import { WorkspaceContentReviewError } from './errors.js';
import { resolveProjectAnchor } from './video-project-review-resolution.js';

export type {
  VideoProjectReadPort as VideoProjectReviewPort,
  VideoProjectSnapshot,
} from '../../video-studio/project/types.js';

export function videoProjectLedgerSource(snapshot: VideoProjectSnapshot): VideoProjectReviewSource {
  return {
    kind: 'video-project',
    contentRef: snapshot.contentRef,
    ownerRevision: snapshot.ownerRevision,
    revision: snapshot.blobDigest,
    mime: 'application/vnd.cat-cafe.video-project+json',
  };
}

export async function readVideoProjectReview(
  port: VideoProjectReviewPort | undefined,
  review: WorkspaceContentReview,
  principal: VideoProjectPrincipal,
): Promise<WorkspaceContentReviewView> {
  if (!port || review.source.kind !== 'video-project') throw new WorkspaceContentReviewError('unsupported_content');
  if (review.ownerUserId !== principal.userId || review.source.contentRef !== review.contentRef)
    throw new WorkspaceContentReviewError('access_denied');
  const current = await port.load({ principal, contentRef: review.contentRef });
  const sources = new Map<number, Promise<VideoProjectSnapshot>>();
  sources.set(current.ownerRevision, Promise.resolve(current));
  const load = (ownerRevision: number) => {
    let snapshot = sources.get(ownerRevision);
    if (!snapshot) {
      snapshot = port.load({ principal, contentRef: review.contentRef, ownerRevision });
      sources.set(ownerRevision, snapshot);
    }
    return snapshot;
  };
  const frozen = await load(review.source.ownerRevision);
  if (frozen.blobDigest !== review.source.revision) throw new WorkspaceContentReviewError('source_changed');
  const annotationResolutions: WorkspaceContentAnnotationResolution[] = await Promise.all(
    review.annotations.map(async (annotation) => {
      if (!('kind' in annotation.anchor) || annotation.anchor.kind !== 'video-project')
        return { annotationId: annotation.id, status: 'orphaned' as const };
      const anchor = annotation.anchor;
      const targets = new Map<string, VideoProjectReviewAnchor>();
      for (const target of [anchor, ...(annotation.projectHistory ?? []).flatMap((event) => event.targets ?? [])])
        targets.set(JSON.stringify(target), target);
      const projectTargets = await Promise.all(
        [...targets.values()].map(async (target) => {
          const original = await load(target.baseOwnerRevision);
          if (original.blobDigest !== target.baseRevision) throw new WorkspaceContentReviewError('source_changed');
          return { anchor: target, status: resolveProjectAnchor(target, original, current) };
        }),
      );
      return { annotationId: annotation.id, status: projectTargets[0]?.status ?? 'orphaned', projectTargets };
    }),
  );
  const currentSource = videoProjectLedgerSource(current);
  const sourceState =
    current.ownerRevision === review.source.ownerRevision && current.blobDigest === review.source.revision
      ? 'current'
      : 'changed';
  let writeAuthorized = false;
  if (!current.document.archivedAt) {
    try {
      await port.authorize({ principal, contentRef: review.contentRef, permission: 'write' });
      writeAuthorized = true;
    } catch {
      // Reading succeeded; any failed write-authority probe closes editing/reply capability and grants nothing.
    }
  }
  return {
    review,
    currentSource,
    sourceState,
    annotationResolutions,
    canReply: writeAuthorized,
    canWrite: sourceState === 'current' && writeAuthorized,
    historyReadOnly: sourceState !== 'current' || Boolean(current.document.archivedAt),
  };
}
