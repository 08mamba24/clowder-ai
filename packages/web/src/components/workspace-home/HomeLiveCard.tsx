'use client';

import type { ActiveExecutionProjection } from '@cat-cafe/shared';
import { useMemo } from 'react';
import { AppTooltip } from '@/components/AppTooltip';
import { CatAvatar } from '@/components/CatAvatar';
import { OverflowText } from '@/components/content-overflow/OverflowText';
import { ExecutionCancelButton } from '@/components/ExecutionCancelButton';
import { useShellCopy } from '@/components/shell/shell-copy';
import { ThreadChatLink } from '@/components/workspace/ThreadChatLink';
import { groupRunningWork, type RunningWork } from '@/components/workspace/workspace-running-work';
import { useCatData } from '@/hooks/useCatData';
import { resolveCatDisplayName } from '@/lib/cat-display-name';
import { activeExecutionKey, useActiveExecutionStore } from '@/stores/activeExecutionStore';
import { formatElapsed, homeActivityLabel } from './format';
import { useHomeClock } from './use-home-clock';
import { homeCopy } from './workspace-home.shell-copy';

/**
 * 正在发生 on the new shell's Workspace home (home-northstar §1.8 / §1.12 窄栏 1) — presentation only.
 *
 * The data is the classic card's, untouched: the canonical `activeExecutionStore` projection grouped by
 * `groupRunningWork` (one row per cat × conversation). Each row keeps what the classic row had — open the conversation,
 * 详情 for a live turn, ■ for each execution — and the sub-rows a multi-execution row lists. New here: the avatar, the
 * 当前对话 mark on the row that belongs to the conversation you are in, and the elapsed clock on a background task.
 */

interface RowActionsProps {
  execution: ActiveExecutionProjection;
  onSelectExecution?: (execution: ActiveExecutionProjection) => void;
}

function RowActions({ execution, onSelectExecution }: RowActionsProps) {
  const t = useShellCopy(homeCopy);
  return (
    <>
      {onSelectExecution && execution.kind === 'live_invocation' && execution.turnInvocationId && (
        <AppTooltip label={t.live.detail} side="bottom">
          <button
            type="button"
            className="home-btn shell-focusable text-xs"
            onClick={() => onSelectExecution(execution)}
            data-testid="workspace-open-running-object"
            aria-label={t.live.detail}
          >
            ›
          </button>
        </AppTooltip>
      )}
      <AppTooltip label={t.live.stop} side="bottom">
        <ExecutionCancelButton
          execution={execution}
          label="■"
          pendingLabel="■"
          className="home-stop shell-focusable text-xs"
        />
      </AppTooltip>
    </>
  );
}

function LiveRow({
  work,
  catName,
  here,
  now,
  onSelectExecution,
}: {
  work: RunningWork;
  catName: string;
  here: boolean;
  now: number;
  onSelectExecution?: (execution: ActiveExecutionProjection) => void;
}) {
  const t = useShellCopy(homeCopy);
  const single = work.executions.length === 1 ? work.executions[0] : undefined;
  const hasLiveTurn = work.executions.some((execution) => execution.kind === 'live_invocation');
  const status = hasLiveTurn ? t.live.replying : t.live.waitingBackground;
  const title = work.threadTitle ?? work.threadId;

  return (
    <article className="home-live-row" data-testid="workspace-running-object" data-here={here ? 'true' : undefined}>
      <div className="home-live-main">
        <ThreadChatLink threadId={work.threadId} className="home-live-link shell-focusable">
          <CatAvatar catId={work.catId} size={22} ring="none" />
          <span className="home-live-text">
            <b className="home-live-name text-compact">
              <OverflowText className="home-live-name-text" text={catName} />
              <small className="home-live-clock text-xs">
                {formatElapsed(now - Math.min(...work.executions.map((item) => item.startedAt)))}
              </small>
              {here && (
                <span className="home-badge text-label" data-testid="workspace-running-here">
                  {t.live.here}
                </span>
              )}
            </b>
            <OverflowText className="home-live-sub text-xs" text={title} multiline />
            <small className="home-live-status text-xs">
              {status}
              {single?.kind === 'managed_command' && ` · ${homeActivityLabel(single.activity, t.activity)}`}
            </small>
          </span>
        </ThreadChatLink>
        <span className="home-actions">
          {single && <RowActions execution={single} onSelectExecution={onSelectExecution} />}
        </span>
      </div>
      {!single && (
        <div className="home-live-subs">
          {work.executions.map((execution) => (
            <div
              key={activeExecutionKey(execution)}
              className="home-live-subrow text-xs"
              data-testid="workspace-running-activity"
            >
              <span className="home-live-subtext">
                {execution.kind === 'managed_command'
                  ? `${t.live.background(homeActivityLabel(execution.activity, t.activity))} · ${formatElapsed(now - execution.startedAt)}`
                  : t.live.liveRun}
              </span>
              <span className="home-actions">
                <RowActions execution={execution} onSelectExecution={onSelectExecution} />
              </span>
            </div>
          ))}
        </div>
      )}
    </article>
  );
}

export function HomeLiveCard({
  threadId,
  onSelectExecution,
}: {
  threadId?: string;
  onSelectExecution?: (execution: ActiveExecutionProjection) => void;
}) {
  const t = useShellCopy(homeCopy);
  const { getCatById } = useCatData();
  const executionsByKey = useActiveExecutionStore((state) => state.executionsByKey);
  const hydration = useActiveExecutionStore((state) => state.hydration);
  const running = useMemo(() => groupRunningWork(Object.values(executionsByKey)), [executionsByKey]);
  const ticking = running.length > 0;
  const now = useHomeClock(ticking, 1000);

  if (running.length === 0) {
    if (hydration === 'loading') {
      return (
        <section className="home-card home-note text-xs" data-testid="workspace-developing-status">
          {t.live.loading}
        </section>
      );
    }
    if (hydration === 'error') {
      return (
        <section className="home-card home-note text-xs" data-tone="warn" data-testid="workspace-developing-status">
          {t.live.unverified}
        </section>
      );
    }
    return null;
  }

  return (
    <section className="home-card" data-testid="workspace-developing" aria-labelledby="home-live-title">
      <header className="home-card-head">
        <span className="home-dot" data-tone="live" aria-hidden="true" />
        <h2 id="home-live-title" className="home-card-title text-sm">
          {t.live.title}
        </h2>
        <span className="home-card-scope text-xs">{t.live.scope(running.length)}</span>
      </header>
      <div className="home-rows">
        {running.map((work) => (
          <LiveRow
            key={work.key}
            work={work}
            catName={resolveCatDisplayName(work.catId, getCatById)}
            here={threadId !== undefined && work.threadId === threadId}
            now={now}
            onSelectExecution={onSelectExecution}
          />
        ))}
      </div>
      {hydration === 'error' && (
        <p className="home-card-foot text-xs" data-tone="warn">
          {t.live.stale}
        </p>
      )}
    </section>
  );
}
