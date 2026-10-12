import { expect, it } from 'vitest';
import { createArtifactWorkPresentationState, isWorkspaceFullWindowSurface } from '../artifact-work-presentation';
import { createFileSurface } from '../real-surface-adapters';
import { createInitialWorkbenchState } from '../workbench-initial-state';
import { projectWorkspaceWorkHost } from '../workspace-work-host-projection';

it.each([
  'cover.png',
  'clip.mp4',
  'notes.md',
  'notes.txt',
  'notes.docx',
])('v2 %s uses the existing artwork split and fullscreen controller', (path) => {
  const file = createFileSurface({ worktreeId: 'wt-a', path });
  expect(isWorkspaceFullWindowSurface(file, 'v2')).toBe(true);
  const projected = projectWorkspaceWorkHost(
    {
      threadId: 'thread-a',
      viewMode: 'single',
      isDesktop: true,
      statusPanelOpen: true,
      rightPanelMode: 'workspace',
      shellPresentation: 'v2',
    },
    createInitialWorkbenchState([file]),
    createArtifactWorkPresentationState(),
  );
  expect(projected.hostEligible).toBe(true);
  expect(projected.splitPreferenceActive).toBe(true);
  expect(isWorkspaceFullWindowSurface(file, 'classic')).toBe(false);
});

it('code files and malformed file identities keep the ordinary viewer geometry', () => {
  const code = createFileSurface({ worktreeId: 'wt-a', path: 'source.ts' });
  expect(isWorkspaceFullWindowSurface(code, 'v2')).toBe(false);
  const invalid = {
    ...createFileSurface({ worktreeId: 'wt-a', path: 'cover.png' }),
    ownerStateRef: { owner: 'other-owner', key: 'wt-a' },
  };
  expect(isWorkspaceFullWindowSurface(invalid, 'v2')).toBe(false);
});
