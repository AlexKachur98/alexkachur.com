// The console chunk, loaded by the bootstrap's ready() on the first interaction and never before.
// Nothing runs at module level, so evaluating it early on pointerdown is free. This module wires
// the two panels, the raw console and the Ask box, to one executor (executor.ts), which owns the
// worker, the 3-second timer and the row cap, and one renderer (results.ts). The Ask box posts the
// question to /api/ask and runs the SQL it gets back through the same path, by the rules in
// ask-box.ts.
import { FUNCTION_SECONDS } from '../lib/ask/config.ts';
import { askState, clearQuestion, createSender, escapeClears, holdsPage, markOverflow, onScreen, scrollToShow, sendMessage, showClear } from './ask-box.ts';
import type { AskState, ClearKey, Reply } from './ask-box.ts';
import { createExecutor, failure, fetchDatabase, guard, WORKER_URL } from './executor.ts';
import type { Executor } from './executor.ts';
import { paint, sqlNodes, summary } from './results.ts';
import type { Result } from './results.ts';

const WORKING_MESSAGE = 'working';
const CACHED_LABEL = 'cached';
const ASK_URL = '/api/ask';
const SEND_URL = '/api/questions';
// The function is stopped at its time limit, so an answer still missing five seconds later is not
// coming; giving up frees the box, chips included, and shows the examples.
const ASK_TIMEOUT_MS = (FUNCTION_SECONDS + 5) * 1000;
// A send that hangs gives up rather than holding its button for the rest of the visit.
const SEND_TIMEOUT_MS = 15_000;

// The parts the two panels share: the working attribute for the cursor, the status and error
// regions, and the results container. The suffix follows the status a run ends on; the Ask
// panel sets it to the cached label so the row count reads "2 rows, cached", while working and
// loading stay short.
interface Panel {
  root: HTMLElement;
  status: HTMLElement;
  error: HTMLElement;
  results: HTMLElement;
  inFlight: number;
  suffix: string;
}

interface ConsoleUi extends Panel {
  input: HTMLTextAreaElement;
  // Shown while the editor, the results or the error line hold something.
  clear: HTMLElement;
}

interface AskUi extends Panel {
  // The whole box: the form with its chips as well as the panel.
  box: HTMLElement;
  form: HTMLElement;
  input: HTMLInputElement;
  // The control that clears the question field, shown while the field holds text.
  clear: HTMLElement;
  question: HTMLElement;
  explanation: HTMLElement;
  sql: HTMLElement;
  edit: HTMLElement | null;
  fallback: HTMLElement;
  // The lines an example can show under its table, hidden until that example runs.
  more: HTMLElement[];
  // The offer to send a question the site could not answer, and the thanks that replaces it.
  sendBlock: HTMLElement;
  sent: HTMLElement;
  // The example answer a wide screen shows before the first question, if the page has one.
  example: HTMLElement | null;
  busy: boolean;
  // The words after the row count saying the results box scrolls, shown while it does.
  scrollCue: HTMLElement;
  // The answer's head line: the question, and the status line under it.
  head: HTMLElement;
  // Set while a question is in flight whose answer the page will scroll into sight.
  reveal: Reveal | undefined;
}

let executor: Executor | undefined;
let loaded = false;
let kb = '';
let consoleUi: ConsoleUi | undefined;
let askUi: AskUi | undefined;

function element<T extends HTMLElement>(root: ParentNode, selector: string): T {
  const found = root.querySelector<T>(selector);
  if (!found) throw new Error(`console: ${selector} is missing`);
  return found;
}

// Unchanged text is left alone: replacing a text node with the same words still fires a live
// region change, and the loading message can be written by the preload and by a click.
export function setStatus(panel: Panel, text: string, final = false): void {
  const suffix = final ? panel.suffix : '';
  const full = text && suffix ? `${text}, ${suffix}` : text || suffix;
  if (panel.status.textContent !== full) panel.status.textContent = full;
}

function setError(panel: Panel, text: string): void {
  panel.error.textContent = text;
}

function loadingMessage(): string {
  return `loading database, ${kb} KB`;
}

function working(panel: Panel, delta: number): void {
  panel.inFlight += delta;
  if (panel.inFlight > 0) panel.root.setAttribute('data-working', '');
  else panel.root.removeAttribute('data-working');
}

// The rest of an empty result's sentence belongs to the "No rows" it follows. A run removes it
// when it starts, and again if it fails, since an earlier run ahead of it in the queue may have
// painted one while it waited.
function dropNote(panel: Panel): void {
  panel.results.querySelector('.console-empty')?.remove();
}

// The result when the query ran, undefined when it was refused or failed.
async function execute(panel: Panel, sql: string): Promise<Result | undefined> {
  if (!executor) return undefined;
  dropNote(panel);
  const problem = guard(sql);
  if (problem) {
    setStatus(panel, panel.inFlight > 0 ? WORKING_MESSAGE : '');
    setError(panel, problem);
    return undefined;
  }
  setError(panel, '');
  setStatus(panel, loaded ? WORKING_MESSAGE : loadingMessage());
  working(panel, 1);
  try {
    const result = await executor.run(sql);
    // A run can be the open that succeeds after the preload's open failed.
    loaded = true;
    // An earlier query in the queue may have failed since this one was submitted.
    setError(panel, '');
    paint(panel.results, result);
    setStatus(panel, summary(result), true);
    return result;
  } catch (error) {
    dropNote(panel);
    setStatus(panel, '', true);
    setError(panel, failure(error));
    return undefined;
  } finally {
    working(panel, -1);
  }
}

// Runs whatever the textarea holds. Blank input is ignored, like an empty line at a prompt.
export function run(): void {
  if (!consoleUi) return;
  const ui = consoleUi;
  const sql = ui.input.value.trim();
  if (sql !== '') void execute(ui, sql).then(() => syncClear(ui));
}

function query(sql: string): void {
  if (!consoleUi) return;
  consoleUi.input.value = sql;
  syncClear(consoleUi);
  run();
}

// Whether the raw console has anything to clear: text in the editor, a result under it, or a
// message on its error line.
export function clearable(text: string, results: Pick<Element, 'childElementCount'>, error: Pick<Node, 'textContent'>): boolean {
  return text !== '' || results.childElementCount > 0 || (error.textContent ?? '') !== '';
}

function syncClear(ui: ConsoleUi): void {
  ui.clear.hidden = !clearable(ui.input.value, ui.results, ui.error);
}

// Empties the editor and what the last run showed: the table and its note, the error line and, once
// the database has loaded, the row count; until then the status holds the loading message, which
// stays. A query still running is left alone, so its result never lands in an emptied panel. Focus
// goes to the editor before the button hides, so it is never left on a hidden control.
export function clearConsole(ui: ConsoleUi, databaseLoaded = loaded): void {
  if (ui.inFlight > 0) return;
  ui.input.value = '';
  ui.results.replaceChildren();
  ui.results.removeAttribute('tabindex');
  setError(ui, '');
  if (databaseLoaded) setStatus(ui, '');
  ui.input.focus({ preventScroll: true });
  ui.clear.hidden = true;
}

// Typing in the editor, which the bootstrap forwards.
export function typed(): void {
  if (consoleUi) syncClear(consoleUi);
}

// Where the answer opens under the form (below 1200px, at every width on the 404 page, and in a
// browser without subgrid), a phone often has it below the bottom of the screen, so a question would
// change nothing in sight. When the answer's head starts out of sight, the page moves for the
// visitor. If the answer is not in after a tenth of a second, about as long as a response can take
// and still feel immediate, it moves just far enough to show the question and its working line.
// Once the answer is in, it moves far enough to show all of it, or its top when it is taller than
// the screen, unless the visitor has scrolled since. That second move waits two frames, so the
// answer is laid out below the screen before the page scrolls to it: made in the same frame, Chrome
// counts it as a layout shift of everything under the answer. Focus stays where it was, and screen
// readers hear the status line as before; a control reached by keyboard also keeps its place on
// screen, so its focus ring stays in sight. The page jumps rather than glides, as a link to a
// section does.
const REVEAL_DELAY = 100;

interface Reveal {
  timer: ReturnType<typeof setTimeout>;
  // Where the page was when it last moved on its own; anywhere else means the visitor scrolled.
  at: number;
}

// The visual viewport never starts above the line scrollY gives, so the larger of the two is its top.
// On an iPhone with the keyboard up, pageTop can still give the top from before a scroll the page
// has just made itself, while scrollY and every box already have the new one.
function place(element: Element): { top: number; bottom: number } {
  const root = document.documentElement.getBoundingClientRect().top;
  const top = Math.max(window.visualViewport?.pageTop ?? 0, window.scrollY);
  return onScreen(element.getBoundingClientRect(), root, top);
}

// The visual viewport less the element's scroll margin, measured the same way.
function sight(element: HTMLElement): { top: number; bottom: number } {
  const style = getComputedStyle(element);
  const height = window.visualViewport?.height ?? window.innerHeight;
  return { top: parseFloat(style.scrollMarginTop), bottom: height - parseFloat(style.scrollMarginBottom) };
}

function distance(element: HTMLElement): number {
  return scrollToShow(place(element), sight(element));
}

function bring(ui: AskUi, element: HTMLElement): void {
  const focused = document.activeElement;
  const kept = focused instanceof HTMLElement && holdsPage(ui.form, focused, matchMedia('(pointer: fine)').matches);
  window.scrollBy(0, scrollToShow(place(element), sight(element), kept ? place(focused).top : undefined));
}

function watch(ui: AskUi): void {
  if (distance(ui.head) === 0) return;
  const reveal: Reveal = {
    at: window.scrollY,
    timer: setTimeout(() => {
      if (window.scrollY !== reveal.at) return;
      bring(ui, ui.head);
      reveal.at = window.scrollY;
    }, REVEAL_DELAY),
  };
  ui.reveal = reveal;
}

function settle(ui: AskUi): void {
  const reveal = ui.reveal;
  ui.reveal = undefined;
  if (!reveal) return;
  clearTimeout(reveal.timer);
  if (window.scrollY !== reveal.at) return;
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      if (!ui.busy) bring(ui, ui.root);
    }),
  );
}

// Clears the Ask panel for a new question and opens it, the question on its header line. The
// panel is always in the markup so its two live regions exist before they are written to; it
// takes up space only once it has something to show. The example answer goes for good, so the
// visitor's answer takes its place rather than appearing under it. Its height stays behind as the
// pane's smallest height, which the stylesheet uses only beside the form, so an answer shorter than
// the example moves nothing on the page and a longer one moves it only by the difference. The
// height goes on the panel's style object, which the content security policy allows, unlike a
// style attribute in the markup.
function begin(ui: AskUi, question: string): void {
  if (ui.example) {
    ui.root.style.setProperty('--example-height', `${ui.example.getBoundingClientRect().height}px`);
    ui.example.remove();
    ui.example = null;
  }
  ui.root.setAttribute('data-open', '');
  ui.question.textContent = question;
  ui.suffix = '';
  ui.explanation.textContent = '';
  ui.sql.textContent = '';
  setError(ui, '');
  ui.results.replaceChildren();
  ui.results.removeAttribute('tabindex');
  ui.scrollCue.hidden = true;
  if (ui.edit) ui.edit.hidden = true;
  ui.fallback.hidden = true;
  for (const line of ui.more) line.hidden = true;
  sender.reset();
  ui.sendBlock.hidden = true;
  ui.sent.hidden = true;
  setStatus(ui, WORKING_MESSAGE);
  watch(ui);
}

async function answer(ui: AskUi, sql: string): Promise<Result | undefined> {
  ui.sql.replaceChildren(...sqlNodes(sql));
  if (ui.edit) ui.edit.hidden = false;
  const result = await execute(ui, sql);
  markOverflow(ui.results, ui.scrollCue, capped(ui.results));
  return result;
}

// Whether the stylesheet caps this results box, which it does only beside the form.
const capped = (box: HTMLElement): boolean => getComputedStyle(box).maxHeight !== 'none';

// A typed question the site could not answer, a refusal or a query with no rows, can be sent to
// Alex; the offer only shows the button, and nothing leaves the page until it is clicked.
async function show(ui: AskUi, state: AskState, question: string): Promise<void> {
  if (state.kind === 'failed') {
    setStatus(ui, '');
    setError(ui, state.message);
    ui.fallback.hidden = !state.fallback;
    return;
  }
  ui.explanation.textContent = state.explanation;
  ui.suffix = state.cached ? CACHED_LABEL : '';
  let unanswered = true;
  if (state.kind === 'refusal') setStatus(ui, '', true);
  else unanswered = (await answer(ui, state.sql))?.rows.length === 0;
  if (unanswered && state.token) {
    sender.offer(question, state.token);
    ui.sendBlock.hidden = false;
  }
}

async function postJson(url: string, body: unknown, timeoutMs: number): Promise<Reply | null> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: response.status, body: await response.json().catch(() => undefined) };
  } catch {
    return null;
  }
}

const sender = createSender((body) => postJson(SEND_URL, body, SEND_TIMEOUT_MS));

// The send button's click, the one way a question is sent. On success the thanks takes the
// button's place and the focus; a refusal hides the button and hands focus back to the input.
async function sendAsked(): Promise<void> {
  const outcome = await sender.send();
  if (!outcome || !askUi) return;
  const ui = askUi;
  if (outcome === 'sent') {
    setError(ui, '');
    ui.sendBlock.hidden = true;
    ui.sent.hidden = false;
    ui.sent.focus({ preventScroll: true });
    return;
  }
  setError(ui, sendMessage(outcome));
  if (outcome === 'refused') {
    ui.sendBlock.hidden = true;
    ui.input.focus({ preventScroll: true });
  }
}

// One question at a time: a submit or a chip while one is in flight does nothing. The cursor
// blinks from the request to the last row painted.
async function occupy(ui: AskUi, question: string, work: () => Promise<void>): Promise<boolean> {
  if (ui.busy) return false;
  ui.busy = true;
  begin(ui, question);
  working(ui, 1);
  try {
    await work();
  } finally {
    working(ui, -1);
    // A question that ended without a run and without a failure would keep the word.
    if (ui.status.textContent?.startsWith(WORKING_MESSAGE)) setStatus(ui, '');
    settle(ui);
    ui.busy = false;
  }
  return true;
}

// Submits the input: the question goes to /api/ask while the worker and the database, started
// by the focus that preceded typing, finish loading. Blank input is ignored.
export function ask(): void {
  if (!askUi || !executor) return;
  const ui = askUi;
  const question = ui.input.value.trim();
  if (question === '') return;
  void occupy(ui, question, async () => {
    // A load that failed earlier is retried alongside the request; the run reports it if it
    // fails again, and nothing is reported when there is no SQL to run.
    executor?.ready().catch(() => undefined);
    await show(ui, askState(await postJson(ASK_URL, { question }, ASK_TIMEOUT_MS), consoleUi !== undefined, ui.fallback.querySelectorAll('li').length), question);
  });
}

// A chip, or one of the fallback examples: reviewed SQL run locally, no request made. An example
// with a line of its own shows it under the table once the query has run. The fallback list
// hides as the run starts, taking the activated button with it, so focus is put back afterwards:
// on the results when a table was painted, else on the input.
function askQuery(ui: AskUi, sql: string, label: string, fromList: boolean, more: string | undefined): void {
  void occupy(ui, label, async () => {
    const result = await answer(ui, sql);
    const line = more === undefined ? undefined : ui.more.find((candidate) => candidate.dataset['askMore'] === more);
    if (result && line) line.hidden = false;
  }).then((started) => {
    if (!started || !fromList) return;
    const target = ui.results.hasAttribute('tabindex') ? ui.results : ui.input;
    target.focus({ preventScroll: true });
  });
}

// Typing in the question field, which the bootstrap forwards.
export function askTyped(): void {
  if (askUi) showClear(askUi.input, askUi.clear);
}

// A keydown of Escape in the question field, which the bootstrap forwards.
export function askEscape(event: ClearKey): void {
  if (askUi && escapeClears(event, askUi.input.value)) clearQuestion(askUi.input, askUi.clear);
}

// Moves the SQL into the raw console for editing and brings the console into view: the answer's,
// or the example's, which its button carries.
function edit(sql: string | undefined): void {
  if (!askUi || !consoleUi) return;
  consoleUi.input.value = sql ?? askUi.sql.textContent ?? '';
  syncClear(consoleUi);
  consoleUi.root.scrollIntoView();
  consoleUi.input.focus({ preventScroll: true });
}

// The bootstrap owns every listener and forwards a click on an example, a chip, Run, the console's
// Clear, Edit this query, the question field's clear control or the send button here, whether it
// landed before this module was loaded or after. Both clear controls are checked before the Ask
// box's own branch and the final run, either of which would take them for something else.
// Edit this query is checked before the chips: a click on the example's button can arrive after a
// question has already taken the example off the page, and it still means edit, not run.
export function click(button: HTMLElement): void {
  const sql = button.dataset['sql'];
  if (button.hasAttribute('data-ask-send')) {
    void sendAsked();
    return;
  }
  if (button.hasAttribute('data-ask-edit')) {
    edit(sql);
    return;
  }
  if (button.hasAttribute('data-ask-clear')) {
    if (askUi) clearQuestion(askUi.input, askUi.clear);
    return;
  }
  if (button.hasAttribute('data-console-clear')) {
    if (consoleUi) clearConsole(consoleUi);
    return;
  }
  if (askUi?.box.contains(button)) {
    if (sql !== undefined) {
      askQuery(askUi, sql, button.textContent?.trim() ?? '', askUi.fallback.contains(button), button.dataset['more']);
    }
    return;
  }
  if (sql !== undefined) query(sql);
  else run();
}

function panelOf(root: HTMLElement, prefix: string): Panel {
  return {
    root,
    status: element(root, `[data-${prefix}-status]`),
    error: element(root, `[data-${prefix}-error]`),
    results: element(root, `[data-${prefix}-results]`),
    inFlight: 0,
    suffix: '',
  };
}

// Called once by the bootstrap's ready(): starts the worker and the database fetch, showing the
// byte size in the console while they load. A page has the console, the Ask box or both; the
// database URL and size are on whichever is there.
export function init(): void {
  if (executor) return;
  const source = element<HTMLElement>(document.body, '[data-db-url]');
  kb = source.dataset['kb'] ?? '';
  executor = createExecutor({
    spawn: () => new Worker(WORKER_URL),
    load: () => fetchDatabase(source.dataset['dbUrl']),
  });
  const consoleRoot = document.querySelector<HTMLElement>('[data-console]');
  if (consoleRoot) {
    consoleUi = { ...panelOf(consoleRoot, 'console'), input: element(consoleRoot, '[data-console-input]'), clear: element(consoleRoot, '[data-console-clear]') };
    setStatus(consoleUi, loadingMessage());
    // Text typed, or restored by the browser, before this module ran shows Clear too.
    syncClear(consoleUi);
  }
  const askRoot = document.querySelector<HTMLElement>('[data-ask]');
  if (askRoot) {
    askUi = {
      ...panelOf(element(askRoot, '[data-ask-panel]'), 'ask'),
      box: askRoot,
      form: element(askRoot, '[data-ask-form]'),
      input: element(askRoot, '[data-ask-input]'),
      clear: element(askRoot, '[data-ask-clear]'),
      question: element(askRoot, '[data-ask-question]'),
      explanation: element(askRoot, '[data-ask-explanation]'),
      sql: element(askRoot, '[data-ask-sql]'),
      // The answer's own button, not the example's, which sits deeper in the panel.
      edit: askRoot.querySelector<HTMLElement>('[data-ask-panel] > [data-ask-edit]'),
      fallback: element(askRoot, '[data-ask-fallback]'),
      more: [...askRoot.querySelectorAll<HTMLElement>('[data-ask-more]')],
      sendBlock: element(askRoot, '[data-ask-send-block]'),
      sent: element(askRoot, '[data-ask-sent]'),
      example: askRoot.querySelector<HTMLElement>('[data-ask-example]'),
      busy: false,
      scrollCue: element(askRoot, '[data-ask-scroll-cue]'),
      head: element(askRoot, '[data-ask-head]'),
      reveal: undefined,
    };
    // Text typed, or restored by the browser, before this module ran shows the control too.
    showClear(askUi.input, askUi.clear);
    // A resize can cap or uncap the box, which changes whether it overflows without a new answer.
    const ui = askUi;
    new ResizeObserver(() => markOverflow(ui.results, ui.scrollCue, capped(ui.results))).observe(ui.results);
  }
  executor.ready().then(
    () => {
      loaded = true;
      if (consoleUi) setStatus(consoleUi, consoleUi.inFlight > 0 ? WORKING_MESSAGE : '');
    },
    (error: unknown) => {
      if (!consoleUi) return;
      setStatus(consoleUi, '');
      setError(consoleUi, failure(error));
      syncClear(consoleUi);
    },
  );
}
