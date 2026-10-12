/**
 * The tool rows of the new shell's Workspace home (home-northstar §1.8 w1, §1.12 narrow 1), in the design's three groups.
 *
 * Every row that opens something hands the host the SAME `WorkspaceLauncherDestination` object the classic launcher hands to
 * `F307WorkspaceHomePage.selectDestination` (worktree admission, pending destination, surface adapters) — taken from
 * `canonicalLauncherDestination`, not re-typed — so there is one place that decides what a destination becomes, down to the
 * title and context of the surface it opens. A row only chooses its own words, icon, order and group.
 *
 * Preservation matrix — what the classic launcher offered and where it is now in the new shell:
 *   files / changes / git / terminal / browser ........ rows below (代码)
 *   status (状态与会话) / trajectory / theater (回放) .... rows below (活动)
 *   recall (记忆) / 陪伴 (语音与会议) / capability-evolution rows below (其他)
 *   tasks / artifacts ................................. header 任务 / 作品 (HeaderCounts → setWorkspaceMode)
 *   approval / needs-me ............................... mailbox 待办 rows (打开审批列表 / 打开待处理列表)
 *   schedule / team / community / eval ................ 设置与管理 first-level entries (settings-ia.ts → workspace-mode / team workspace)
 *   product-schedule (classic 「Schedule」, now 「全部工作」) / capability-evolution ... footer links (HOME_TRANSITIONAL_DESTINATIONS):
 *   neither final home is connected yet — settings-ia's 能力进化 only opens THIS home, and the 待办 has no 「全部工作」 —
 *   so removing them would strand both.
 */
import type { ShellGlyphName } from '@/components/shell/ShellIcons';
import {
  canonicalLauncherDestination,
  type WorkspaceLauncherDestination,
} from '@/components/workspace/WorkspaceLauncher';
import { type HomeCopy, homeCopy } from './workspace-home.shell-copy';

export type HomeGroupId = 'code' | 'activity' | 'other';

export type HomeRowIcon = ShellGlyphName | 'memory';

/** A row's words live in the dictionary (`rows.<copyKey>`), in both languages; the row itself only says which. */
export type HomeRowCopyKey = keyof HomeCopy['rows'];

interface HomeRowBase {
  readonly id: string;
  readonly group: HomeGroupId;
  readonly icon: HomeRowIcon;
  readonly copyKey: HomeRowCopyKey;
  /** Words that find the row but are not shown, in either language. */
  readonly searchTerms: string;
}

export interface HomeDestinationRow extends HomeRowBase {
  readonly kind: 'destination';
  readonly destination: WorkspaceLauncherDestination;
}

/** 语音与会议: the page for it (§1.14) is not approved yet, so the row opens the existing controls in place. */
export interface HomeVoiceRow extends HomeRowBase {
  readonly kind: 'voice';
}

export type HomeRow = HomeDestinationRow | HomeVoiceRow;

function destinationRow(
  group: HomeGroupId,
  icon: HomeRowIcon,
  kind: WorkspaceLauncherDestination['kind'],
  id: HomeRowCopyKey,
  extraSearchTerms = '',
): HomeDestinationRow {
  const destination = canonicalLauncherDestination(kind, id);
  return {
    kind: 'destination',
    id: `${kind}:${id}`,
    group,
    icon,
    copyKey: id,
    searchTerms: `${destination.searchTerms} ${extraSearchTerms}`.trim(),
    destination,
  };
}

export const HOME_ROWS: readonly HomeRow[] = [
  destinationRow('code', 'folder', 'surface', 'files'),
  // The page lists the worktree's modified files (git status), not a per-conversation set: say what it shows.
  destinationRow('code', 'filePen', 'surface', 'changes', '修改'),
  destinationRow('code', 'gitPr', 'surface', 'git'),
  destinationRow('code', 'hash', 'surface', 'terminal'),
  destinationRow('code', 'globe', 'surface', 'browser'),
  destinationRow('activity', 'activity', 'host', 'status', '成员'),
  destinationRow('activity', 'history', 'mode', 'trajectory'),
  destinationRow('activity', 'play', 'action', 'theater'),
  destinationRow('other', 'memory', 'mode', 'recall'),
  {
    kind: 'voice',
    id: 'voice',
    group: 'other',
    icon: 'headphones',
    copyKey: 'voice',
    searchTerms: '陪伴 语音陪伴 会议伴随 朗读 录音 转写 voice companion meeting transcript',
  },
];

/**
 * Two entries that are not tools of this page but have no connected home yet, so the page's footer opens them (north-star
 * §1.8, 10-03). Same canonical destination objects as the classic launcher's cards, so choosing one does what the card did.
 *  - 全部工作 (mode `product-schedule`, the classic card 「Schedule」): its final home is the 待办's 「全部工作」, which is not
 *    mounted; the only other way in is the 待处理 page's empty-state button, which is not rendered while that page has items.
 *  - 能力进化 (workspace destination): its final home is the first-level 设置与管理 entry, but that entry only opens THIS page
 *    until F307 adds its narrow open request (F307 owns it; F322 changes the call site afterwards).
 * Remove each link in the same change that connects its final home.
 */
export const HOME_TRANSITIONAL_DESTINATIONS = {
  allWork: canonicalLauncherDestination('mode', 'product-schedule'),
  capabilityEvolution: canonicalLauncherDestination('workspace', 'capability-evolution'),
} as const;

/**
 * A query finds a row by either language's name or description, whichever language the page is showing: someone who types
 * 终端 on an English page, or "terminal" on a Chinese one, still lands on the row.
 */
export function rowMatchesQuery(row: HomeRow, normalizedQuery: string): boolean {
  if (!normalizedQuery) return true;
  const zh = homeCopy.zh.rows[row.copyKey];
  const en = homeCopy.en.rows[row.copyKey];
  return `${zh.label} ${zh.description} ${en.label} ${en.description} ${row.searchTerms}`
    .toLocaleLowerCase()
    .includes(normalizedQuery);
}

export function destinationTestId(destination: WorkspaceLauncherDestination): string {
  return destination.kind === 'surface'
    ? `workspace-launcher-dev-${destination.id}`
    : `workspace-launcher-${destination.id}`;
}
