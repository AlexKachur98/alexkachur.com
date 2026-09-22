// The form of a question that the cache key hashes: NFKC, lowercase, one space between words,
// and only trailing question marks, periods and exclamation marks removed, so "Node.js" and
// "C#" keep their characters and stay distinct questions.
export function normaliseQuestion(question: string): string {
  return question
    .normalize('NFKC')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[?.!\s]+$/, '');
}
