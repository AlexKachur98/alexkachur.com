// Splits rendered markdown into its h2 sections, so a page can place each one in the site's
// section layout and insert its own blocks between them (Screenshots goes before Credits; the
// SplitRoof flow diagram sits inside What I built). The heading ids come from
// the processor's heading-ids plugin. A title is the heading's text, decoded, since Section
// escapes it again when it writes the h2.
import { inlineText } from './page-text.ts';

export interface Section {
  id: string;
  title: string;
  body: string;
}

const heading = /<h2(?:\s[^>]*?)?\sid="([^"]*)"[^>]*>([\s\S]*?)<\/h2>/g;

// A page whose text is one section with no heading of its own (About, Now, the 404 lead) passes
// that section's title as lead; anywhere else, text before the first h2 is an error.
export function splitSections(html: string, options: { lead?: string | undefined } = {}): Section[] {
  const matches = [...html.matchAll(heading)];
  const first = matches[0];
  const lead = html.slice(0, first?.index ?? html.length).trim();
  const sections: Section[] = [];
  if (lead !== '') {
    if (options.lead === undefined) throw new Error(`content before the first h2 would be dropped: ${lead.slice(0, 60)}`);
    sections.push({ id: '', title: options.lead, body: lead });
  }
  for (const [index, match] of matches.entries()) {
    const start = match.index + match[0].length;
    const end = matches[index + 1]?.index ?? html.length;
    sections.push({ id: match[1]!, title: inlineText(match[2]!), body: html.slice(start, end).trim() });
  }
  return sections;
}
