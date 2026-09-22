// The one deferred module every page loads before interaction (SPEC 5.8), kept under 2 KB
// gzipped. It holds the theme toggle now; ready() and the trigger listeners arrive with the
// console module.
import { nextTheme, type Theme } from './theme.ts';

const root = document.documentElement;
const darkScheme = matchMedia('(prefers-color-scheme: dark)');

function system(): Theme {
  return darkScheme.matches ? 'dark' : 'light';
}

function current(): Theme {
  const stored = root.getAttribute('data-theme');
  return stored === 'light' || stored === 'dark' ? stored : system();
}

document.querySelector('[data-theme-toggle]')?.addEventListener('click', () => {
  const next = nextTheme(current(), system());
  if (next) root.setAttribute('data-theme', next);
  else root.removeAttribute('data-theme');
  try {
    if (next) localStorage.setItem('theme', next);
    else localStorage.removeItem('theme');
  } catch {
    // Storage can be blocked; the attribute still switches the theme for this page view.
  }
});
