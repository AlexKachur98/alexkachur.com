// Splits rendered markdown into its h2 sections, so a page can place each one in the site's
// section layout and insert its own blocks between them (Screenshots goes before Credits; the
// SplitRoof flow diagram sits inside What I built). The heading ids come from
// the processor's heading-ids plugin.
export interface Section {
  id: string;
  title: string;
  body: string;
}

const heading = /<h2(?:\s[^>]*?)?\sid="([^"]*)"[^>]*>([\s\S]*?)<\/h2>/g;

export function splitSections(html: string): Section[] {
  const matches = [...html.matchAll(heading)];
  const first = matches[0];
  const lead = html.slice(0, first?.index ?? html.length).trim();
  if (lead !== '') throw new Error(`content before the first h2 would be dropped: ${lead.slice(0, 60)}`);
  return matches.map((match, index) => {
    const start = match.index + match[0].length;
    const end = matches[index + 1]?.index ?? html.length;
    return { id: match[1]!, title: match[2]!, body: html.slice(start, end).trim() };
  });
}
