// Pretty-printed JSON for the prerendered /api/*.json files, so curl output reads well.
export function json(data: unknown): Response {
  return new Response(`${JSON.stringify(data, null, 2)}\n`, {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
