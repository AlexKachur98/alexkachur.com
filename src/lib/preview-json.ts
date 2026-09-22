// Truncated example responses for the /api docs page (SPEC 3.4), built from the same rows the
// endpoints serve: arrays keep their first items and long strings their first characters,
// with "..." standing in for the rest.
const MARK = '...';

export interface PreviewOptions {
  items?: number;
  chars?: number;
}

export function previewJson(value: unknown, { items = 2, chars = 72 }: PreviewOptions = {}, indent = ''): string {
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const shown = value.slice(0, items).map((item) => `${inner}${previewJson(item, { items, chars }, inner)}`);
    if (value.length > items) shown.push(`${inner}${MARK}`);
    return `[\n${shown.join(',\n')}\n${indent}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return '{}';
    const shown = entries.map(([key, item]) => `${inner}${JSON.stringify(key)}: ${previewJson(item, { items, chars }, inner)}`);
    return `{\n${shown.join(',\n')}\n${indent}}`;
  }
  if (typeof value === 'string' && value.length > chars) return JSON.stringify(`${value.slice(0, chars)}${MARK}`);
  return JSON.stringify(value);
}
