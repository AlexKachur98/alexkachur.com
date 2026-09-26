// The one module every page loads before interaction, kept under 2 KB gzipped: the theme toggle,
// the console chunk's loader and the footer stats fetch.
import { showStats, whenIdle } from './readouts.ts';
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

// Loads the console chunk once and starts it. Focus or a press on a panel preloads it. Every
// listener stays here and hands its event to the chunk once it has loaded, so the first
// interaction works before any of the chunk has arrived.
type ConsoleModule = typeof import('./console.ts');
let loading: Promise<ConsoleModule> | undefined;

function ready(): Promise<ConsoleModule> {
  return (loading ??= import('./console.ts').then(
    (module) => {
      module.init();
      return module;
    },
    (error: unknown) => {
      // Kept only once it loads, so a later interaction can try the import again.
      loading = undefined;
      throw error;
    },
  ));
}

function preload(): void {
  void ready();
}

const editor = document.querySelector('[data-console-input]');
editor?.addEventListener('keydown', (event) => {
  const { key, ctrlKey, metaKey, repeat } = event as KeyboardEvent;
  if (key === 'Enter' && (ctrlKey || metaKey)) {
    event.preventDefault();
    if (!repeat) void ready().then((module) => module.run());
  }
});
// Typing decides whether the console shows Clear.
editor?.addEventListener('input', () => void ready().then((module) => module.typed()));

document.querySelector('[data-ask-form]')?.addEventListener('submit', (event) => {
  event.preventDefault();
  void ready().then((module) => module.ask());
});

// Typing decides whether the question field's clear control shows, and Escape clears the field as
// the control does.
const askInput = document.querySelector('[data-ask-input]');
askInput?.addEventListener('input', () => void ready().then((module) => module.askTyped()));
askInput?.addEventListener('keydown', (event) => {
  if ((event as KeyboardEvent).key === 'Escape') void ready().then((module) => module.askEscape(event as KeyboardEvent));
});
// A press on the control keeps focus in the field rather than moving it to the control.
document.querySelector('[data-ask-clear]')?.addEventListener('mousedown', (event) => event.preventDefault());

for (const panel of document.querySelectorAll('[data-console], [data-ask]')) {
  panel.addEventListener('focusin', preload);
}

for (const panel of document.querySelectorAll('[data-console], [data-examples], [data-ask]')) {
  panel.addEventListener('pointerdown', preload);
  panel.addEventListener('click', (event) => {
    const button = (event.target as Element).closest<HTMLElement>('[data-sql], [data-console-run], [data-console-clear], [data-ask-edit], [data-ask-clear], [data-ask-send]');
    if (button) void ready().then((module) => module.click(button));
  });
}

// The live values from /api/stats, fetched once the page is idle. A failed fetch or an unexpected
// body leaves the page as built.
const modelLine = document.querySelector<HTMLElement>('[data-model-line]');
const slots = { readouts: document.querySelector('[data-readouts]'), modelLine, modelSlot: modelLine?.querySelector('[data-model]') ?? null };
if (slots.readouts || slots.modelLine) {
  whenIdle(() => {
    fetch('/api/stats')
      .then((response) => (response.ok ? response.json() : null))
      .then((body: unknown) => showStats(body, slots))
      .catch(() => {
        // Offline or blocked: the baked text stands on its own.
      });
  });
}
