import type { ConnectorSource } from '@cat-cafe/shared';
import type { CodexNativeImageOrigin } from '../../../cats/services/agents/providers/codex-native-image-origin.js';
import type { ReviewReturnIntent } from '../../artifact-review/return-store.js';

/** Platform source, explicitly distinct from the original human decision receipt. */
export interface MediaPublicationReturnIntent extends Omit<ReviewReturnIntent, 'kind' | 'requestId'> {
  kind: 'resume_media_publication';
  requestId: string;
  source: {
    kind: 'platform_publication';
    sourceMessageId: string;
    sourceMessageRevision: string;
    requestReceiptRef: string;
    publicationMessageId: string;
    publicationRevision: string;
    publicationItemId: string;
    artifactRef: string;
    artifactRevision: string;
    nativeOrigin: CodexNativeImageOrigin;
  };
  visibility: 'public' | 'whisper';
  whisperTo?: readonly string[];
}

export function mediaPublicationProjection(intent: MediaPublicationReturnIntent) {
  const source: ConnectorSource = {
    connector: 'content-review',
    label: '作品生成完成：原任务续办',
    icon: 'cat-cafe',
    meta: {
      v: 1,
      kind: intent.kind,
      returnRef: intent.receiptRef,
      requestId: intent.requestId,
      sourceMessageId: intent.source.sourceMessageId,
      sourceMessageRevision: intent.source.sourceMessageRevision,
      requestReceiptRef: intent.source.requestReceiptRef,
      taskId: intent.taskId,
      targetCatId: intent.targetCatId,
      expectedTaskRevision: intent.expectedTaskRevision,
      reviewId: intent.reviewId,
      round: intent.round,
      contentRef: intent.contentRef,
      ownerRevision: intent.ownerRevision,
      publicationMessageId: intent.source.publicationMessageId,
      publicationRevision: intent.source.publicationRevision,
      publicationItemId: intent.source.publicationItemId,
      artifactRef: intent.source.artifactRef,
      artifactRevision: intent.source.artifactRevision,
      producingInvocationId: intent.source.nativeOrigin.invocationId,
    },
  };
  const content = `原请求的生成图片已发布，请继续原 Task，读取确切 Artifact 并逐条回应原批注，交回待决定候选。不要再生成、不要自动采用。\n${JSON.stringify({ requestId: intent.requestId, taskId: intent.taskId, reviewId: intent.reviewId, round: intent.round, artifactRef: intent.source.artifactRef, expectedArtifactRevision: intent.source.artifactRevision })}`;
  return intent.visibility === 'whisper'
    ? { content, source, visibility: 'whisper' as const, whisperTo: intent.whisperTo ?? [] }
    : { content, source, visibility: 'public' as const };
}
