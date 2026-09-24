// Numbers in a resume bullet are never typed: a bullet names one as {key}, and the build fills it
// in from the thing it counts, so a count can never go stale while the bullet stays the same.
// The keys and where each value comes from live in scripts/build-db.ts.
const numberWords = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];

export function fillNumbers(text: string, values: Readonly<Record<string, string>>, where: string): string {
  if (/\d/.test(text.replace(/\{[a-z_]+\}/g, ''))) throw new Error(`${where}: a number is typed; write it as {key}`);
  const filled = text.replace(/\{([a-z_]+)\}/g, (whole, key: string) => {
    const value = values[key];
    if (value === undefined) throw new Error(`${where}: ${whole} is not a number the build knows`);
    return value;
  });
  if (/[{}]/.test(filled)) throw new Error(`${where}: a brace is left after the numbers were filled in`);
  return filled;
}

// The one count a sentence of Alex's prose gives, as digits or as a word up to twelve. A sentence
// that no longer gives exactly one fails the build, so the number is never guessed.
export function countIn(text: string, pattern: RegExp, where: string): number {
  const matches = [...text.matchAll(pattern)];
  if (matches.length !== 1) throw new Error(`${where}: expected one match of ${pattern}, found ${matches.length}`);
  const found = matches[0]![1]!;
  if (/^\d+$/.test(found)) return Number(found);
  const index = numberWords.indexOf(found.toLowerCase());
  if (index === -1) throw new Error(`${where}: ${found} is not a number`);
  return index;
}
