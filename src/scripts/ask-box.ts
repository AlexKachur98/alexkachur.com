// The Ask box's rules, apart from the page so they can be tested without one.

const UNUSABLE_MESSAGE = 'I could not turn that into a safe query. Try rephrasing, or write the SQL yourself.';
// Each sentence that points at the raw console has a shorter form for the 404 page, which has no
// console.
const RATE_LIMITED_MESSAGE = {
  console: 'Too many questions from your connection. Try again in a minute, or type SQL directly below.',
  alone: 'Too many questions from your connection. Try again in a minute.',
};
const BUDGET_MESSAGE = {
  console: (count: string) => `The AI budget for this month is used up. The raw console still works, and here are ${count} questions with their SQL.`,
  alone: (count: string) => `The AI budget for this month is used up. Here are ${count} questions with their SQL.`,
};
const UPSTREAM_MESSAGE = {
  console: (count: string) => `The AI service is not responding right now. The raw console still works, and here are ${count} questions with their SQL.`,
  alone: (count: string) => `The AI service is not responding right now. Here are ${count} questions with their SQL.`,
};
// Asking again mends a failed send, since a new answer brings a new token.
const DAILY_CAP_MESSAGE = 'The site has taken all the questions it can for today. Try again tomorrow.';
const SEND_FAILED_MESSAGE = 'The question could not be sent. Ask it again to try once more.';
const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];

export function countWord(n: number): string {
  return NUMBER_WORDS[n] ?? String(n);
}

// What /api/ask answered, or null when no reply arrived at all (the network, not the service).
export interface Reply {
  status: number;
  body: unknown;
}

// What the panel shows for a reply. A failure lists the examples when the AI is out of reach. An
// answer or a refusal carries the reply's send token, if it had one.
export type AskState =
  | { kind: 'answer'; sql: string; explanation: string; cached: boolean; token?: string }
  | { kind: 'refusal'; explanation: string; cached: boolean; token?: string }
  | { kind: 'failed'; message: string; fallback: boolean };

function field(body: unknown, name: string): unknown {
  return body !== null && typeof body === 'object' ? (body as Record<string, unknown>)[name] : undefined;
}

// withConsole says whether the page also has the raw console the sentences point at; listed is
// how many examples the fallback list holds.
export function askState(reply: Reply | null, withConsole: boolean, listed: number): AskState {
  const wording = withConsole ? 'console' : 'alone';
  const count = countWord(listed);
  const upstream: AskState = { kind: 'failed', message: UPSTREAM_MESSAGE[wording](count), fallback: true };
  if (!reply) return upstream;
  const { status, body } = reply;
  if (status === 200) {
    const sql = field(body, 'sql');
    const explanation = field(body, 'explanation');
    if (typeof sql !== 'string' || typeof explanation !== 'string') return upstream;
    const cached = field(body, 'cached') === true;
    const token = field(body, 'token');
    const extra = typeof token === 'string' && token !== '' ? { token } : {};
    if (sql.trim() === '') return { kind: 'refusal', explanation, cached, ...extra };
    return { kind: 'answer', sql, explanation, cached, ...extra };
  }
  // A 400 (a question under three characters) shares the unusable sentence.
  if (status === 400 || status === 422) return { kind: 'failed', message: UNUSABLE_MESSAGE, fallback: false };
  if (status === 429) return { kind: 'failed', message: RATE_LIMITED_MESSAGE[wording], fallback: false };
  if (status === 503 && field(body, 'reason') === 'budget') {
    return { kind: 'failed', message: BUDGET_MESSAGE[wording](count), fallback: true };
  }
  // Anything else, a fault in the site's own settings included, reads as the service not responding.
  return upstream;
}

export type SendOutcome = 'sent' | 'rate_limited' | 'daily_cap' | 'refused' | 'failed';

// offer() only holds the question and its token; send() posts them. reset() withdraws the offer and
// drops a reply that arrives after it, so a slow send never writes into the next answer. One send
// at a time for each offer; one still pending for an earlier question does not block the next.
export function createSender(post: (body: { question: string; token: string }) => Promise<Reply | null>) {
  let offered: { question: string; token: string; generation: number } | null = null;
  let generation = 0;
  // The offer whose send is in flight, if any.
  let inFlight: number | null = null;
  return {
    offer(question: string, token: string): void {
      generation += 1;
      offered = { question, token, generation };
    },
    reset(): void {
      generation += 1;
      offered = null;
    },
    async send(): Promise<SendOutcome | null> {
      if (!offered || inFlight === offered.generation) return null;
      const mine = offered;
      inFlight = mine.generation;
      try {
        const reply = await post({ question: mine.question, token: mine.token });
        if (mine.generation !== generation) return null;
        if (reply?.status === 200) {
          offered = null;
          return 'sent';
        }
        if (reply?.status === 429) return field(reply.body, 'error') === 'daily_cap' ? 'daily_cap' : 'rate_limited';
        // A refused token or question stays refused, so the offer ends; any other failure can be
        // tried again.
        if (reply?.status === 403 || reply?.status === 400) {
          offered = null;
          return 'refused';
        }
        return 'failed';
      } finally {
        if (inFlight === mine.generation) inFlight = null;
      }
    },
  };
}

export function sendMessage(outcome: Exclude<SendOutcome, 'sent'>): string {
  if (outcome === 'rate_limited') return RATE_LIMITED_MESSAGE.alone;
  if (outcome === 'daily_cap') return DAILY_CAP_MESSAGE;
  return SEND_FAILED_MESSAGE;
}

// The question field's clear control. Clearing touches only the field and the control, so the
// answer stays until the next question.
export interface QuestionField {
  value: string;
  focus(options?: FocusOptions): void;
}

// The parts of a keydown that decide whether Escape clears.
export interface ClearKey {
  key: string;
  isComposing: boolean;
  keyCode: number;
}

export function showClear(field: Pick<QuestionField, 'value'>, control: Pick<HTMLElement, 'hidden'>): void {
  control.hidden = field.value === '';
}

// Focus goes back to the field before the control hides, so it is never left on a hidden control.
export function clearQuestion(field: QuestionField, control: Pick<HTMLElement, 'hidden'>): void {
  field.value = '';
  field.focus({ preventScroll: true });
  control.hidden = true;
}

// A keydown that belongs to an input method's composition carries this keyCode, even the one
// that ends it, when isComposing is already false.
const COMPOSING_KEY_CODE = 229;

export function escapeClears(event: ClearKey, value: string): boolean {
  return event.key === 'Escape' && !event.isComposing && event.keyCode !== COMPOSING_KEY_CODE && value !== '';
}

// How far to scroll so a box sits between two lines: all of it when it fits, its top when it does
// not, nothing when it is already there. Given the top of a control that must stay in sight, a move
// down stops before that top passes the upper line.
export function scrollToShow(box: { top: number; bottom: number }, sight: { top: number; bottom: number }, keep?: number): number {
  let by = 0;
  if (box.top < sight.top || box.bottom - box.top > sight.bottom - sight.top) by = box.top - sight.top;
  else if (box.bottom > sight.bottom) by = box.bottom - sight.bottom;
  return keep === undefined || by <= 0 ? by : Math.min(by, Math.max(0, keep - sight.top));
}

// A box's place in the visual viewport, from the root element's top and the viewport's pageTop.
// With the keyboard up or the page zoomed, browsers disagree on which viewport a box is measured
// from; against the root element its place on the page comes out the same either way.
export function onScreen(box: { top: number; bottom: number }, root: number, page: number): { top: number; bottom: number } {
  return { top: box.top - root - page, bottom: box.bottom - root - page };
}

// A control in the form reached by keyboard keeps its place on screen. A text box matches
// :focus-visible however it was focused, so it holds the page only where the main pointer is a
// mouse or trackpad; on a phone the page moves past it to show the answer.
export function holdsPage(form: Pick<Element, 'contains'>, focused: Element, finePointer: boolean): boolean {
  return form.contains(focused) && focused.matches(':focus-visible') && (focused.tagName === 'BUTTON' || finePointer);
}

// A capped box that holds more than it shows says so, since a scrollbar is not always drawn and a
// cut row can look whole. The words stay while it overflows, even scrolled to the end, so the
// status line never changes during a scroll. A pixel of difference is rounding.
export function markOverflow(
  results: Pick<HTMLElement, 'scrollHeight' | 'clientHeight' | 'scrollWidth' | 'clientWidth'>,
  cue: Pick<HTMLElement, 'hidden'>,
  capped: boolean,
): void {
  cue.hidden = !capped || (results.scrollHeight - results.clientHeight <= 1 && results.scrollWidth - results.clientWidth <= 1);
}
