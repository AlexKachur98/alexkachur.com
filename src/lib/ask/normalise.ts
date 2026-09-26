// The form of a question its keys hash. Only closing punctuation is removed, so "Node.js" and "C#"
// stay distinct questions.
export function normaliseQuestion(question: string): string {
  return question
    .normalize('NFKC')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[?.!\s]+$/, '');
}
