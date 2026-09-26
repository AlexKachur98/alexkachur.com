// How a result renders, the same in the browser and in the example answer the build writes into
// the Ask box: what each cell becomes, how many rows show, the status line after a run, and the
// SQL with its keywords marked.
import { photoAlt } from '../generated/schema.json';
import { ROWS } from '../lib/result-rows.ts';

export type Cell = string | number | null | Uint8Array;

export interface Result {
  columns: string[];
  rows: Cell[][];
  truncated: boolean;
}

export const THUMB = 48;
const TRUNCATED_MESSAGE = `showing ${ROWS} of more`;
// The empty-result sentence is split: its first words go on the status line and the rest under
// the results, so the status line always fits on one line.
const EMPTY_STATUS = 'No rows';
const EMPTY_NOTE = 'The query ran; the data just does not have that.';

// What a cell renders as. Beyond plain text: a photo_url column whose value is a site image
// becomes a 48px thumbnail linking to the image, with the alt text from the pets collection and
// never from the shape of the query; a value that is a web address or an email address, in any
// column, becomes a link so a visitor can follow it straight from the results.
export type Rendered =
  | { kind: 'text'; text: string; empty: boolean }
  | { kind: 'image'; src: string; alt: string }
  | { kind: 'link'; href: string; text: string };

const alts: Record<string, string> = photoAlt;
const WEB_ADDRESS = /^https?:\/\/\S+$/;
const EMAIL_ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function renderCell(column: string, value: Cell): Rendered {
  if (column === 'photo_url' && typeof value === 'string' && value.startsWith('/images/')) {
    const file = value.slice(value.lastIndexOf('/') + 1);
    return { kind: 'image', src: value, alt: alts[value] ?? file.replace(/\.[^.]+$/, '') };
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if (WEB_ADDRESS.test(text)) return { kind: 'link', href: text, text };
    if (EMAIL_ADDRESS.test(text)) return { kind: 'link', href: `mailto:${text}`, text };
  }
  if (value === null) return { kind: 'text', text: 'NULL', empty: true };
  return { kind: 'text', text: String(value), empty: false };
}

export function visibleRows(result: Result): Cell[][] {
  return result.rows.slice(0, ROWS);
}

// The status line after a run: the row count, or the two copy strings for none and for more.
export function summary(result: Result): string {
  if (result.rows.length === 0) return EMPTY_STATUS;
  if (result.truncated) return TRUNCATED_MESSAGE;
  return result.rows.length === 1 ? '1 row' : `${result.rows.length} rows`;
}

export function paint(results: HTMLElement, result: Result): void {
  const table = document.createElement('table');
  const head = table.createTHead().insertRow();
  for (const column of result.columns) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = column;
    head.append(th);
  }
  const body = table.createTBody();
  for (const row of visibleRows(result)) {
    const tr = body.insertRow();
    row.forEach((value, index) => {
      const td = tr.insertCell();
      const cell = renderCell(result.columns[index] ?? '', value);
      if (cell.kind === 'image') {
        const link = document.createElement('a');
        link.href = cell.src;
        const img = document.createElement('img');
        img.src = cell.src;
        img.alt = cell.alt;
        img.width = THUMB;
        img.height = THUMB;
        img.loading = 'lazy';
        link.append(img);
        td.append(link);
      } else if (cell.kind === 'link') {
        const link = document.createElement('a');
        link.href = cell.href;
        link.textContent = cell.text;
        td.append(link);
      } else {
        td.textContent = cell.text;
        if (cell.empty) td.classList.add('null');
      }
    });
  }
  // One DOM operation, so assistive technology sees a single change; the CSS row reveal does
  // the rest. The container scrolls sideways for wide results, so it must take focus.
  if (result.rows.length === 0) {
    const note = document.createElement('p');
    note.className = 'console-empty';
    note.textContent = EMPTY_NOTE;
    results.replaceChildren(table, note);
  } else {
    results.replaceChildren(table);
  }
  // Each result starts at its first row and column, wherever the last one was scrolled to.
  results.scrollTo(0, 0);
  results.tabIndex = 0;
  // The Ask box's results start hidden: a region named by the question, which is empty until one
  // is asked.
  results.hidden = false;
}

// The SQL an answer shows, split so its keywords can take their colour. Only syntax words count:
// strings, quoted names, comments and numbers stay plain, and so does a word after a dot (a
// column) or one with letters outside ASCII, which SQLite reads as a name. Left out on purpose:
// KEY and DATE, which are columns here; COUNT and every other function, since a query often
// names a column after one (COUNT(*) AS count); type names; words more often a name than syntax
// (FIRST, LAST, FILTER, PLAN and the like); and EXPLAIN and every statement other than a query,
// which the server never sends back. Some listed words (ASC, DESC, LEFT and others) are also
// valid names in SQLite; they stay because a query almost always uses them as syntax, so an alias
// spelled like one takes the colour. END is the exception: the experience table has an end
// column, so END counts only when it closes a CASE.
const SQL_KEYWORDS = new Set([
  'SELECT', 'DISTINCT', 'ALL', 'FROM', 'WHERE', 'GROUP', 'BY', 'HAVING', 'ORDER', 'ASC', 'DESC', 'LIMIT', 'OFFSET', 'AS', 'WITH', 'RECURSIVE',
  'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS', 'NATURAL', 'ON', 'USING',
  'UNION', 'INTERSECT', 'EXCEPT', 'VALUES',
  'AND', 'OR', 'NOT', 'IN', 'IS', 'NULL', 'LIKE', 'GLOB', 'ESCAPE', 'BETWEEN', 'EXISTS', 'ISNULL', 'NOTNULL', 'COLLATE',
  'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'CAST',
  'OVER', 'PARTITION', 'WINDOW',
]);

// One token at a time from the start: a string with its doubled quotes, a quoted or bracketed
// name, a comment, a number, a word (SQLite allows any character from U+0080 up in a name), or
// any single character. An unterminated quote or comment runs to the end.
const SQL_TOKEN =
  /'(?:[^']|'')*'?|"(?:[^"]|"")*"?|`(?:[^`]|``)*`?|\[[^\]]*\]?|--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?|[A-Za-z_\u0080-\uFFFF][\w$\u0080-\uFFFF]*|[\s\S]/gy;
const ASCII_WORD = /^[A-Za-z]+$/;

export interface SqlToken {
  text: string;
  keyword: boolean;
}

// Plain runs are merged, so the tokens alternate and joining their text gives the SQL back.
export function sqlTokens(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  let plain = '';
  // CASE expressions still waiting for their END, and whether the last token finished a value.
  // END closes a CASE only right after a value; where a value is expected, as after ELSE or a
  // comma, the word is the end column.
  let open = 0;
  let afterValue = false;
  for (const match of sql.matchAll(SQL_TOKEN)) {
    const text = match[0];
    const word = text.toUpperCase();
    let keyword = ASCII_WORD.test(text) && sql[match.index - 1] !== '.' && SQL_KEYWORDS.has(word);
    if (keyword && word === 'CASE') open += 1;
    if (keyword && word === 'END') {
      if (open > 0 && afterValue) open -= 1;
      else keyword = false;
    }
    if (!/^\s$/.test(text) && !text.startsWith('--') && !text.startsWith('/*')) {
      afterValue = keyword ? word === 'NULL' || word === 'END' : text === ')' || text.charCodeAt(0) > 127 || /^(?:[\w'"`[]|\.\d)/.test(text);
    }
    if (keyword) {
      if (plain !== '') tokens.push({ text: plain, keyword: false });
      tokens.push({ text, keyword: true });
      plain = '';
    } else {
      plain += text;
    }
  }
  if (plain !== '') tokens.push({ text: plain, keyword: false });
  return tokens;
}

// The SQL comes from the model, so it is built as text nodes and spans, never parsed as HTML.
export function sqlNodes(sql: string): Node[] {
  return sqlTokens(sql).map(({ text, keyword }) => {
    if (!keyword) return document.createTextNode(text);
    const span = document.createElement('span');
    span.className = 'sql-keyword';
    span.textContent = text;
    return span;
  });
}
