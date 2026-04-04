'use client';

import type { ReactNode } from 'react';
import { useEffect } from 'react';

interface WorkspaceFocusShellProps {
  children: ReactNode;
  onExit: () => void;
}

/**
 * Shared shell for "focus mode" panes inside workspace.
 * Keeps exit controls and keyboard escape handling consistent across tabs.
 */
export function WorkspaceFocusShell({ children, onExit }: WorkspaceFocusShellProps) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onExit();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onExit]);

  return (
    <div className="relative flex-1 min-h-0">
      <div className="absolute top-2 right-2 z-20">
        <button
          type="button"
          onClick={onExit}
          className="px-2.5 py-1 rounded-md text-[11px] font-medium bg-cafe-surface/80 backdrop-blur-sm text-cafe-black border border-cocreator-light shadow-sm hover:bg-cafe-surface transition-colors"
        >
          退出专注
        </button>
      </div>
      {children}
    </div>
  );
}
