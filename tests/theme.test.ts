import { describe, expect, it } from 'vitest';
import { nextTheme } from '../src/scripts/theme.ts';

describe('nextTheme', () => {
  it('stores the other theme when it differs from the system preference', () => {
    expect(nextTheme('light', 'light')).toBe('dark');
    expect(nextTheme('dark', 'dark')).toBe('light');
  });

  it('goes back to following the system when the target is what the system prefers', () => {
    expect(nextTheme('dark', 'light')).toBeNull();
    expect(nextTheme('light', 'dark')).toBeNull();
  });
});
