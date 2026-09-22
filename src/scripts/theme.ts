// The three-state rule behind the two-state toggle: a click switches to the other
// theme; when that is what the system already prefers, the site goes back to following the
// system (null) instead of storing a choice.
export type Theme = 'light' | 'dark';

export function nextTheme(current: Theme, system: Theme): Theme | null {
  const target: Theme = current === 'dark' ? 'light' : 'dark';
  return target === system ? null : target;
}
