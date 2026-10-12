import type { RequestGenerationGapV1, RequestGenerationProjectionV1 } from '@cat-cafe/shared';
import { useShellPresentation } from '@/components/shell/shell-presentation';
import { TrajectoryId } from './TrajectoryId';

const STATE_LABEL = {
  available: '可展开',
  redacted: '默认遮蔽',
  deleted: '来源已删除',
  unknown: '来源未能核验',
  unsupported: 'Provider 不支持',
} as const;

function shortDigest(value: string | undefined): string {
  if (!value) return '未报告';
  const [, digest = value] = value.split(':', 2);
  return `${digest.slice(0, 10)}…`;
}

function channelLabel(channel: RequestGenerationProjectionV1['envelope']['channels'][number]['channel']): string {
  if (channel === 'message') return '提交消息';
  if (channel === 'native_instruction') return '原生系统指令';
  return 'Provider 内部视野';
}

function Generation({ generation }: { generation: RequestGenerationProjectionV1 }) {
  const isV2 = useShellPresentation() === 'v2';
  const { envelope } = generation;
  const runtime = envelope.runtime.requested;
  return (
    <article
      className={
        isV2
          ? 'min-w-0 break-words rounded-xl border border-cafe-subtle bg-cafe-surface p-3'
          : 'rounded-xl border border-cafe-subtle bg-cafe-surface p-3'
      }
      data-generation-ordinal={envelope.generationOrdinal}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className={isV2 ? 'min-w-0 flex-1' : undefined}>
          <h4 className="text-xs font-semibold text-cafe-primary">
            {isV2 ? `第 ${envelope.generationOrdinal} 次提交` : `Generation #${envelope.generationOrdinal}`}
          </h4>
          {isV2 ? (
            <TrajectoryId kind="会话" value={envelope.sessionId} />
          ) : (
            <p className="mt-0.5 font-mono text-micro text-cafe-muted">Session {envelope.sessionId}</p>
          )}
        </div>
        <span className="rounded-full border border-cafe px-2 py-0.5 text-micro text-cafe-secondary">
          {generation.terminal?.outcome ??
            (generation.observed ? (isV2 ? '已观测' : 'observed') : isV2 ? '已组装' : 'assembled')}
        </span>
      </div>

      <dl
        className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-micro sm:grid-cols-4"
        style={isV2 ? { gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 120px), 1fr))' } : undefined}
      >
        <div>
          <dt className="text-cafe-muted">{isV2 ? '服务方 / 通道' : 'Provider / carrier'}</dt>
          <dd className="text-cafe-secondary">
            {runtime.provider} / {runtime.carrier}
          </dd>
        </div>
        <div>
          <dt className="text-cafe-muted">{isV2 ? '模型' : 'Model'}</dt>
          <dd className="text-cafe-secondary">{generation.observed?.evidence.model ?? runtime.model ?? '未知'}</dd>
        </div>
        <div>
          <dt className="text-cafe-muted">{isV2 ? '上下文' : 'Continuity'}</dt>
          <dd className="text-cafe-secondary">
            {envelope.continuity.mode ?? envelope.continuity.capability}
            {envelope.continuity.contextEpoch === undefined
              ? ''
              : ` · ${isV2 ? '版本' : 'epoch'} ${envelope.continuity.contextEpoch}`}
          </dd>
        </div>
        <div>
          <dt className="text-cafe-muted">{isV2 ? '边界' : 'Boundary'}</dt>
          <dd className="text-cafe-secondary">{envelope.retryBoundary.reason ?? (isV2 ? '首次提交' : 'initial')}</dd>
        </div>
      </dl>

      <div className="mt-3 space-y-2">
        {envelope.channels.map((channel, index) => (
          <div
            key={`${channel.channel}-${index}`}
            className="rounded-lg border border-cafe-subtle bg-cafe-surface-canvas px-2.5 py-2"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 text-micro">
              <span className="font-semibold text-cafe-secondary">
                {isV2 && channel.channel === 'provider_native_hidden'
                  ? '服务方内部视野'
                  : channelLabel(channel.channel)}
              </span>
              <span className="text-cafe-muted">
                {isV2 && channel.state === 'unsupported' ? '服务方不支持' : STATE_LABEL[channel.state]}
              </span>
            </div>
            <p className="mt-1 text-micro text-cafe-muted">
              {channel.byteLength === undefined
                ? isV2
                  ? '字节数未报告'
                  : 'bytes 未报告'
                : `${channel.byteLength} ${isV2 ? '字节' : 'bytes'}`}{' '}
              · {isV2 ? '摘要' : 'digest'} <span className="font-mono">{shortDigest(channel.keyedContentDigest)}</span>
              {channel.injectionDecision ? ` · ${channel.injectionDecision}` : ''}
            </p>
            {channel.state === 'available' && channel.body !== undefined && (
              <details className="mt-2">
                <summary className="cursor-pointer text-xs font-semibold text-cafe-accent">展开实际提交内容</summary>
                <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded-lg bg-cafe-surface p-2 text-micro text-cafe-secondary">
                  {channel.body}
                </pre>
              </details>
            )}
            {channel.state === 'unknown' && (
              <p className="mt-2 text-micro text-cafe-muted">
                {isV2
                  ? '来源或版本当前无法核验。'
                  : 'Source owner 或版本当前无法核验；没有猜成可见、已删除或 Provider 未支持。'}
              </p>
            )}
          </div>
        ))}
      </div>

      <p className="mt-2 text-micro text-cafe-muted">
        {isV2 ? '工具' : 'Tools'}: {envelope.tools.finalSurface} · {isV2 ? 'Clowder AI 接口' : 'Clowder AI schemas'}:{' '}
        <span className="font-mono">{shortDigest(envelope.tools.catCafeSchemaSetHash)}</span> ·{' '}
        {isV2 ? '声明服务' : 'Declared servers'}:{' '}
        <span className="font-mono">{shortDigest(envelope.tools.declaredServerSetHash)}</span> ·{' '}
        {isV2 ? '服务方观测' : 'Provider observed'}:{' '}
        <span className="font-mono">{shortDigest(envelope.tools.providerObservedSchemaSetHash)}</span>
      </p>
      <p className="mt-1 text-micro text-cafe-muted">
        {isV2 ? '压缩' : 'Compactions'}: {envelope.continuity.compactionRefs.length} ·{' '}
        {isV2 ? '输入材料' : 'Presentations'}:{' '}
        {envelope.presentations.filter((item) => item.decision === 'admitted').length} {isV2 ? '已纳入' : 'admitted'} /{' '}
        {envelope.presentations.filter((item) => item.decision === 'omitted').length} {isV2 ? '已省略' : 'omitted'}
      </p>
    </article>
  );
}

export function RequestGenerationSection({
  generations,
  gaps,
  loading,
  error,
  revealing,
  onReveal,
}: {
  generations: readonly RequestGenerationProjectionV1[] | null;
  gaps: readonly RequestGenerationGapV1[];
  loading: boolean;
  error: boolean;
  revealing: boolean;
  onReveal: () => void;
}) {
  const isV2 = useShellPresentation() === 'v2';
  const hasRevealable = generations?.some(({ envelope }) =>
    envelope.channels.some((channel) => channel.state === 'redacted' || channel.state === 'unknown'),
  );
  return (
    <section className="rounded-xl border border-cafe-subtle p-3" data-testid="request-generation-section">
      <div
        className={
          isV2 ? 'flex flex-wrap items-center justify-between gap-3' : 'flex items-center justify-between gap-3'
        }
      >
        <div>
          <h3 className="text-sm font-semibold text-cafe-primary">
            {isV2 ? '这一轮实际发给模型的输入' : 'Input generations'}
          </h3>
          <p className="mt-0.5 text-micro text-cafe-muted">
            {isV2 ? '每次实际提交的输入；默认只显示摘要。' : 'Clowder AI 实际组装并提交的每一代输入；默认只显示摘要。'}
          </p>
        </div>
        {hasRevealable && (
          <button
            type="button"
            onClick={onReveal}
            disabled={revealing}
            className="shrink-0 rounded-lg border border-cafe px-2.5 py-1.5 text-xs font-semibold text-cafe-secondary disabled:opacity-60"
          >
            {revealing ? '核验来源…' : '按来源权限展开'}
          </button>
        )}
      </div>
      {loading ? (
        <p className="mt-3 text-xs text-cafe-muted">{isV2 ? '读取模型输入…' : '读取 request envelope…'}</p>
      ) : error ? (
        <p className="mt-3 text-xs text-cafe-muted">
          {isV2 ? '模型输入当前不可用。' : 'Request envelope 当前不可用。'}
        </p>
      ) : (!generations || generations.length === 0) && gaps.length === 0 ? (
        <p className="mt-3 text-xs text-cafe-muted">
          {isV2 ? '这轮没有实际提交输入的记录。' : '这轮没有 canonical request-generation 证据。'}
        </p>
      ) : (
        <div className="mt-3 space-y-3">
          {gaps.map((gap) => (
            <article
              key={`${gap.fromOrdinal}-${gap.toOrdinal}`}
              className="rounded-xl border border-cafe-subtle bg-cafe-surface p-3"
              data-testid="request-generation-gap"
            >
              <h4 className="text-xs font-semibold text-cafe-primary">
                {isV2 ? '提交记录缺口：第 ' : 'Generation evidence gap #'}
                {gap.fromOrdinal}
                {gap.toOrdinal === gap.fromOrdinal ? '' : `–${gap.toOrdinal}`}
              </h4>
              <p className="mt-1 text-micro text-cafe-muted">
                {isV2 ? (
                  '可见会话中缺少这段提交记录；其余提交仍按各自记录展示。'
                ) : (
                  <>
                    可见 Session chain 中缺少这段 generation 证据；其余 generations
                    仍按各自证据展示，未把缺口猜成“没有发生”。
                  </>
                )}
              </p>
            </article>
          ))}
          {(generations ?? []).map((generation) => (
            <Generation key={generation.envelope.requestGenerationId} generation={generation} />
          ))}
        </div>
      )}
    </section>
  );
}
