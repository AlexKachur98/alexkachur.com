// The one deferred module every page loads before interaction, kept under 2 KB
// gzipped. It holds the theme toggle, ready(), the memoised import of the console chunk, and
// the footer stats fetch.
import { modelName, readoutText } from './readouts.ts';
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

// ready(): one promise that loads the console chunk and starts it. Focus inside the console or
// the Ask box and pointerdown on any of the panels preload it; a click on Run, an example, a
// chip or Edit this query, a submitted question and Ctrl or Cmd+Enter in the textarea are
// handed to the chunk once it is there, so the first one works before any of it has loaded.
// The chunk attaches no listeners of its own.
type ConsoleModule = typeof import('./console.ts');
let loading: Promise<ConsoleModule> | undefined;

function ready(): Promise<ConsoleModule> {
  return (loading ??= import('./console.ts').then((module) => {
    module.init();
    return module;
  }));
}

function preload(): void {
  void ready();
}

document.querySelector('[data-console-input]')?.addEventListener('keydown', (event) => {
  const { key, ctrlKey, metaKey, repeat } = event as KeyboardEvent;
  if (key === 'Enter' && (ctrlKey || metaKey)) {
    event.preventDefault();
    if (!repeat) void ready().then((module) => module.run());
  }
});

document.querySelector('[data-ask-form]')?.addEventListener('submit', (event) => {
  event.preventDefault();
  void ready().then((module) => module.ask());
});

for (const panel of document.querySelectorAll('[data-console], [data-ask]')) {
  panel.addEventListener('focusin', preload);
}

for (const panel of document.querySelectorAll('[data-console], [data-examples], [data-ask]')) {
  panel.addEventListener('pointerdown', preload);
  panel.addEventListener('click', (event) => {
    const button = (event.target as Element).closest<HTMLElement>('[data-sql], [data-console-run], [data-ask-edit]');
    if (button) void ready().then((module) => module.click(button));
  });
}

// The live values from /api/stats: the footer's two readouts, appended to the baked line, and
// on the page that has it the model sentence, hidden until its name arrives. Fetched once the
// page is idle (after 200 ms where requestIdleCallback does not exist, as in Safari). A failed
// fetch or an unexpected body leaves the page as built.
const readouts = document.querySelector('[data-readouts]');
const modelLine = document.querySelector<HTMLElement>('[data-model-line]');
const modelSlot = modelLine?.querySelector('[data-model]');
if (readouts || modelLine) {
  const load = (): void => {
    fetch('/api/stats')
      .then((response) => (response.ok ? response.json() : null))
      .then((body: unknown) => {
        const text = readoutText(body);
        if (readouts && text) readouts.append(` · ${text}`);
        const model = modelName(body);
        if (modelLine && modelSlot && model) {
          modelSlot.textContent = model;
          modelLine.hidden = false;
        }
      })
      .catch(() => {
        // Offline or blocked: the baked text stands on its own.
      });
  };
  if ('requestIdleCallback' in window) requestIdleCallback(load);
  else setTimeout(load, 200);
}
