// A resume bullet, a caption or a page names a count as {key}, and the build fills it in from the
// thing it counts. The keys and where each value comes from are in scripts/build-db.ts.
const numberWords = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];

// A whole number with a comma between each group of three digits, as the pages print numbers.
export function group(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// Every {key} replaced by its value; an unknown key or a leftover brace fails the build.
export function fillPlaceholders(text: string, values: Readonly<Record<string, string>>, where: string): string {
  const filled = text.replace(/\{([a-z_]+)\}/g, (whole, key: string) => {
    const value = values[key];
    if (value === undefined) throw new Error(`${where}: ${whole} is not a number the build knows`);
    return value;
  });
  if (/[{}]/.test(filled)) throw new Error(`${where}: a brace is left after the numbers were filled in`);
  return filled;
}

// A resume bullet holds no digit of its own: every number in it is a placeholder.
export function fillNumbers(text: string, values: Readonly<Record<string, string>>, where: string): string {
  if (/\d/.test(text.replace(/\{[a-z_]+\}/g, ''))) throw new Error(`${where}: a number is typed; write it as {key}`);
  return fillPlaceholders(text, values, where);
}

// The one count a sentence gives, as digits or as a word up to twelve; a sentence that no longer
// gives exactly one fails the build.
export function countIn(text: string, pattern: RegExp, where: string): number {
  const matches = [...text.matchAll(pattern)];
  if (matches.length !== 1) throw new Error(`${where}: expected one match of ${pattern}, found ${matches.length}`);
  const found = matches[0]![1]!;
  if (/^\d+$/.test(found)) return Number(found);
  const index = numberWords.indexOf(found.toLowerCase());
  if (index === -1) throw new Error(`${where}: ${found} is not a number`);
  return index;
}
