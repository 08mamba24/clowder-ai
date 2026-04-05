import { getConnectorDefinition } from '@cat-cafe/shared';
import { describe, expect, it } from 'vitest';

describe('connector dark mode themes', () => {
  it('multi-mention-result includes dark: variants for all slots', () => {
    const def = getConnectorDefinition('multi-mention-result');
    expect(def).toBeDefined();
    const theme = def!.tailwindTheme!;

    expect(theme.avatar).toContain('dark:bg-emerald-500/15');
    expect(theme.avatar).toContain('dark:ring-emerald-400/30');
    expect(theme.label).toContain('dark:text-emerald-200');
    expect(theme.labelLink).toContain('dark:text-emerald-200');
    expect(theme.labelLink).toContain('dark:hover:text-emerald-100');
    expect(theme.bubble).toContain('dark:border-emerald-700/60');
    expect(theme.bubble).toContain('dark:bg-emerald-950/35');
    expect(theme.bubble).toContain('dark:text-emerald-100');
  });
});
