import { describe, expect, it } from 'vitest';
import { normaliseQuestion } from '../src/lib/ask/normalise.ts';

describe('normaliseQuestion', () => {
  it('folds compatibility characters with NFKC', () => {
    // a fullwidth A and the fi ligature
    expect(normaliseQuestion('Ａlex')).toBe('alex');
    expect(normaliseQuestion('ﬁle')).toBe('file');
  });

  it('lowercases', () => {
    expect(normaliseQuestion('What Has Alex Built')).toBe('what has alex built');
  });

  it('trims and collapses whitespace, tabs and newlines included', () => {
    expect(normaliseQuestion('  what  ')).toBe('what');
    expect(normaliseQuestion('what\tdoes\n\nalex   build')).toBe('what does alex build');
    expect(normaliseQuestion('\n\twhat \r\n does alex build \t')).toBe('what does alex build');
  });

  it('strips only trailing question marks, periods and exclamation marks', () => {
    expect(normaliseQuestion('what?!')).toBe('what');
    expect(normaliseQuestion('what...')).toBe('what');
    expect(normaliseQuestion('what ? ')).toBe('what');
    expect(normaliseQuestion('?what')).toBe('?what');
    expect(normaliseQuestion('what,')).toBe('what,');
  });

  it('keeps punctuation inside the question', () => {
    expect(normaliseQuestion('Does Alex use Node.js?')).toBe('does alex use node.js');
    expect(normaliseQuestion('Does Alex know C#?')).toBe('does alex know c#');
    expect(normaliseQuestion("Who's there?")).toBe("who's there");
    expect(normaliseQuestion('What is Alex... studying?')).toBe('what is alex... studying');
  });

  it('gives two spellings of one question the same key', () => {
    expect(normaliseQuestion('What does Alex use?')).toBe(normaliseQuestion('what does alex use'));
    expect(normaliseQuestion('  What does\tAlex use?!  ')).toBe(normaliseQuestion('What does Alex use.'));
    expect(normaliseQuestion('Node.js?')).not.toBe(normaliseQuestion('Node js?'));
  });
});
