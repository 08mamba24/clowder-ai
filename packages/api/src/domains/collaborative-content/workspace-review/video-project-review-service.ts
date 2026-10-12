import type {
  VideoProjectReviewAction,
  VideoProjectReviewResult,
  VideoProjectReviewSource,
  VideoProjectReviewTarget,
  WorkspaceContentAnnotation,
  WorkspaceContentReview,
  WorkspaceContentReviewView,
} from '@cat-cafe/shared';
import { videoProjectReviewActionSchema } from '@cat-cafe/shared';
import type { VideoProjectPrincipal } from '../../video-studio/project/access.js';
import type { VideoProjectReadPort as VideoProjectReviewPort } from '../../video-studio/project/types.js';
import { WorkspaceContentReviewError } from './errors.js';
import { assertProjectTargetChanged } from './result-proof/target.js';
import type { WorkspaceContentReviewStore, WorkspaceReviewMutation } from './store.js';
import { applyProjectReviewAction, effectiveProjectReviewTargets } from './video-project-review-actions.js';
import { projectReviewAnchor, validateProjectAnchor } from './video-project-review-anchors.js';
import { readVideoProjectReview, videoProjectLedgerSource } from './video-project-review-source.js';
import {
  validateWorkspaceReviewBody,
  validateWorkspaceReviewId,
  workspaceAnnotationId,
  workspaceReviewIdentity,
} from './workspace-review-anchors.js';
import { appendWorkspaceSourceHistory } from './workspace-review-mutations.js';

type MutationInput = {
  principal: VideoProjectPrincipal;
  reviewId: string;
  expectedRevision: number;
  operationId: string;
};

/** Project-specific trusted Human/Cat entry point sharing F309's one injected ledger. */
export class VideoProjectReviewService {
  private readonly now: () => string;
  constructor(
    private readonly options: {
      store: WorkspaceContentReviewStore;
      projects: VideoProjectReviewPort;
      now?: () => string;
    },
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async prepare(input: {
    principal: VideoProjectPrincipal;
    contentRef: string;
    ownerRevision?: number;
    operationId: string;
  }): Promise<WorkspaceContentReviewView> {
    this.assertPrincipal(input.principal);
    validateWorkspaceReviewId(input.operationId);
    const snapshot = await this.options.projects.load(input);
    const existing = this.options.store.getByContent(input.principal.userId, snapshot.contentRef);
    if (existing) return this.read({ principal: input.principal, reviewId: existing.reviewId });
    await this.options.projects.authorize({ ...input, permission: 'write' });
    if (snapshot.document.archivedAt) throw new WorkspaceContentReviewError('source_changed');
    const source = videoProjectLedgerSource(snapshot);
    const now = this.now();
    const review = this.options.store.create(
      {
        version: 1,
        reviewId: workspaceReviewIdentity(input.principal.userId, snapshot.contentRef),
        ownerUserId: input.principal.userId,
        contentRef: snapshot.contentRef,
        source,
        sourceHistory: [source],
        revision: 1,
        annotations: [],
        createdAt: now,
        updatedAt: now,
      },
      {
        operationId: input.operationId,
        actor: input.principal.actor,
        kind: 'prepare:video-project',
        now,
        request: { contentRef: snapshot.contentRef, ownerRevision: snapshot.ownerRevision },
      },
    );
    return this.read({ principal: input.principal, reviewId: review.reviewId });
  }

  async read(input: { principal: VideoProjectPrincipal; reviewId: string }): Promise<WorkspaceContentReviewView> {
    const review = await this.requireReview(input.principal, input.reviewId, 'read');
    return readVideoProjectReview(this.options.projects, review, input.principal);
  }

  async operationReceipt(input: { principal: VideoProjectPrincipal; reviewId: string; operationId: string }) {
    await this.requireReview(input.principal, input.reviewId, 'read');
    return this.options.store.operationReceipt(input.reviewId, validateWorkspaceReviewId(input.operationId));
  }

  async annotate(input: MutationInput & { body: string; target: VideoProjectReviewTarget }) {
    const review = await this.requireReview(input.principal, input.reviewId, 'write');
    const mutation = this.mutation(input, 'annotate:video-project', { body: input.body, target: input.target });
    const replay = this.options.store.replay(mutation);
    if (replay) return replay;
    const view = await readVideoProjectReview(this.options.projects, review, input.principal);
    if (!view.canWrite) throw new WorkspaceContentReviewError('source_changed');
    const snapshot = await this.options.projects.load({
      principal: input.principal,
      contentRef: review.contentRef,
      ownerRevision: review.source.kind === 'video-project' ? review.source.ownerRevision : undefined,
    });
    const anchor = projectReviewAnchor(snapshot, input.target);
    const body = validateWorkspaceReviewBody(input.body);
    return this.options.store.mutate(mutation, (current) => ({
      ...current,
      revision: current.revision + 1,
      updatedAt: mutation.now,
      annotations: [
        ...current.annotations,
        {
          id: workspaceAnnotationId(current.reviewId, input.operationId),
          operationId: input.operationId,
          anchor,
          body,
          author: input.principal.actor,
          createdAt: mutation.now,
          updatedAt: mutation.now,
          state: 'open',
          replies: [],
          projectHistory: [
            {
              kind: 'created',
              actor: input.principal.actor,
              at: mutation.now,
              operationId: input.operationId,
              targets: [anchor],
            },
          ],
        },
      ],
    }));
  }

  async act(input: MutationInput & { action: VideoProjectReviewAction }) {
    const review = await this.requireReview(input.principal, input.reviewId, 'write');
    const parsed = videoProjectReviewActionSchema.safeParse(input.action);
    if (!parsed.success) throw new WorkspaceContentReviewError('invalid_action');
    const action = parsed.data;
    const mutation = this.mutation(input, `project:${action.kind}`, { action });
    const replay = this.options.store.replay(mutation);
    if (replay) return replay;
    const head = await this.options.projects.load({ principal: input.principal, contentRef: review.contentRef });
    if (head.document.archivedAt) throw new WorkspaceContentReviewError('source_changed');
    const annotation = review.annotations.find((item) => item.id === action.annotationId);
    if (!annotation) throw new WorkspaceContentReviewError('not_found');
    const metadata: VideoProjectReviewSource[] = [];
    if (action.kind === 'located') {
      for (const target of action.targets) {
        await validateProjectAnchor(this.options.projects, input.principal, review.contentRef, target);
        metadata.push(
          videoProjectLedgerSource(
            await this.options.projects.load({
              principal: input.principal,
              contentRef: review.contentRef,
              ownerRevision: target.baseOwnerRevision,
            }),
          ),
        );
      }
    } else if (action.kind === 'addressed') {
      const source = await this.validateResult(review, annotation, action.result, input.principal);
      if (source) metadata.push(source);
    }
    // The F138 receipt is confirmed before this separate F309 transaction; there is no fake atomic commit across owners.
    return this.options.store.mutate(mutation, (current) => {
      let next = {
        ...current,
        revision: current.revision + 1,
        updatedAt: mutation.now,
        annotations: current.annotations.map((item) =>
          item.id === action.annotationId
            ? applyProjectReviewAction(item, action, input.principal.actor, mutation.now, input.operationId)
            : item,
        ),
      };
      for (const source of metadata) next = { ...next, sourceHistory: appendWorkspaceSourceHistory(next, source) };
      return next;
    });
  }

  async refresh(input: MutationInput & { expectedOwnerRevision: number }): Promise<WorkspaceContentReviewView> {
    const review = await this.requireReview(input.principal, input.reviewId, 'write');
    const mutation = this.mutation(input, 'refresh:video-project', {
      expectedOwnerRevision: input.expectedOwnerRevision,
    });
    const replay = this.options.store.replay(mutation);
    if (replay) return this.read({ principal: input.principal, reviewId: input.reviewId });
    const snapshot = await this.options.projects.load({ principal: input.principal, contentRef: review.contentRef });
    if (snapshot.document.archivedAt) throw new WorkspaceContentReviewError('source_changed');
    if (snapshot.ownerRevision !== input.expectedOwnerRevision) throw new WorkspaceContentReviewError('source_changed');
    const source = videoProjectLedgerSource(snapshot);
    if (
      review.source.kind === 'video-project' &&
      review.source.ownerRevision === source.ownerRevision &&
      review.source.revision === source.revision
    )
      this.options.store.recordNoop(mutation);
    else
      this.options.store.mutate(mutation, (current) => ({
        ...current,
        source,
        sourceHistory: appendWorkspaceSourceHistory(current, source),
        revision: current.revision + 1,
        updatedAt: mutation.now,
      }));
    return this.read({ principal: input.principal, reviewId: input.reviewId });
  }

  private async validateResult(
    review: WorkspaceContentReview,
    annotation: WorkspaceContentAnnotation,
    result: VideoProjectReviewResult,
    principal: VideoProjectPrincipal,
  ): Promise<VideoProjectReviewSource | undefined> {
    if ('kind' in result) return; // Explicit not-changed results carry a nonblank reason in the schema.
    const targets = effectiveProjectReviewTargets(annotation);
    const snapshot = await this.options.projects.load({
      principal,
      contentRef: review.contentRef,
      ownerRevision: result.ownerRevision,
    });
    if ('contentRef' in result) {
      if (result.contentRef !== review.contentRef || result.blobDigest !== snapshot.blobDigest)
        throw new WorkspaceContentReviewError('invalid_action');
      const receipt = await this.options.projects.operationReceipt({
        principal,
        contentRef: review.contentRef,
        operationId: result.operationId,
      });
      if (
        !receipt ||
        receipt.contentRef !== result.contentRef ||
        receipt.ownerRevision !== result.ownerRevision ||
        receipt.blobDigest !== result.blobDigest
      )
        throw new WorkspaceContentReviewError('invalid_action');
    }
    // One addressed event claims the whole effective set. Partial work uses not-changed + reason.
    for (const anchor of targets) {
      if (result.ownerRevision <= anchor.baseOwnerRevision) throw new WorkspaceContentReviewError('invalid_action');
      const original = await this.options.projects.load({
        principal,
        contentRef: review.contentRef,
        ownerRevision: anchor.baseOwnerRevision,
      });
      if (original.blobDigest !== anchor.baseRevision) throw new WorkspaceContentReviewError('source_changed');
      assertProjectTargetChanged(
        original.document,
        snapshot.document,
        anchor.target,
        'assetVersionRef' in result ? result.assetVersionRef : undefined,
      );
    }
    return videoProjectLedgerSource(snapshot);
  }

  private mutation(input: MutationInput, kind: string, request: unknown): WorkspaceReviewMutation {
    return {
      reviewId: input.reviewId,
      expectedRevision: input.expectedRevision,
      operationId: validateWorkspaceReviewId(input.operationId),
      actor: input.principal.actor,
      now: this.now(),
      kind,
      request,
    };
  }

  private assertPrincipal(principal: VideoProjectPrincipal) {
    if (principal.actor.kind === 'human' ? principal.actor.actorId !== principal.userId : !principal.invocationId)
      throw new WorkspaceContentReviewError('access_denied');
  }

  private async requireReview(
    principal: VideoProjectPrincipal,
    reviewId: string,
    permission: 'read' | 'write',
  ): Promise<WorkspaceContentReview> {
    this.assertPrincipal(principal);
    const review = this.options.store.get(validateWorkspaceReviewId(reviewId));
    if (!review) throw new WorkspaceContentReviewError('not_found');
    if (review.ownerUserId !== principal.userId) throw new WorkspaceContentReviewError('access_denied');
    if (review.source.kind !== 'video-project') throw new WorkspaceContentReviewError('unsupported_content');
    await this.options.projects.authorize({ principal, contentRef: review.contentRef, permission });
    return review;
  }
}
