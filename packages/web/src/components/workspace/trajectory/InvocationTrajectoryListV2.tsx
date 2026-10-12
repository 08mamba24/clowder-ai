import type { InvocationTrajectorySummary } from '@cat-cafe/shared';
import { formatTrajectoryDuration, TRAJECTORY_STATUS_CLASS, TRAJECTORY_STATUS_LABEL } from './invocation-trajectory-ui';
import { TrajectoryCatIdentity } from './TrajectoryCatIdentity';
import { TrajectoryId } from './TrajectoryId';
import { type FirstAssistantPreview, firstAssistantPreview } from './trajectory-first-output';

function FirstOutputPreview({ preview }: { preview: FirstAssistantPreview }) {
  return (
    <span
      className="mt-1 block whitespace-pre-wrap break-words text-xs text-cafe-muted"
      data-testid="first-assistant-preview"
      data-preview-kind={preview.kind}
    >
      {preview.kind !== 'sentence' && (
        <span className="block" data-testid="first-assistant-preview-label">
          {preview.label}
        </span>
      )}
      {preview.kind !== 'unavailable' && (
        <span className="block" data-testid="first-assistant-preview-content">
          {preview.content}
        </span>
      )}
    </span>
  );
}

export function InvocationTrajectoryListV2({
  invocations,
  onOpen,
}: {
  invocations: InvocationTrajectorySummary[];
  onOpen: (summary: InvocationTrajectorySummary) => void;
}) {
  return (
    <div className="space-y-2 p-3" data-testid="invocation-trajectory-list">
      {invocations.map((summary) => (
        <article
          key={`${summary.sessionId}:${summary.invocationId}`}
          data-invocation-id={summary.invocationId}
          className="console-list-card min-w-0 rounded-xl p-3"
        >
          <button
            type="button"
            onClick={() => onOpen(summary)}
            className="flex w-full min-w-0 items-start gap-3 rounded-lg text-left hover:bg-cafe-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cafe-accent"
          >
            <span
              className={`mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-micro font-semibold ${TRAJECTORY_STATUS_CLASS[summary.status]}`}
            >
              {TRAJECTORY_STATUS_LABEL[summary.status]}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <TrajectoryCatIdentity catId={summary.catId} />
                <span className="text-micro text-cafe-muted">第 {summary.sessionSeq + 1} 段</span>
                <span className="text-micro text-cafe-muted">{formatTrajectoryDuration(summary.durationMs)}</span>
              </span>
              <span className="mt-1 block text-xs text-cafe-secondary">
                {summary.toolUseCount} 个工具 · {summary.messageCount} 条消息 · {summary.statusEventCount} 条状态
              </span>
              <FirstOutputPreview preview={firstAssistantPreview(summary)} />
            </span>
            <span aria-hidden="true" className="text-cafe-muted">
              ›
            </span>
          </button>
          <div className="mt-1 min-w-0">
            <TrajectoryId kind="调用" value={summary.invocationId} />
            <TrajectoryId kind="会话" value={summary.sessionId} />
          </div>
        </article>
      ))}
    </div>
  );
}
