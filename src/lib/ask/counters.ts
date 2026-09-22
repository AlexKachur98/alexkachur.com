// The two monthly counters that /api/ask increments and /api/stats reads, keyed by deployment
// environment and by the UTC calendar month so a preview never touches production's numbers.

export function monthOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 7);
}

export function counterKeys(env: string, month: string): { asked: string; model: string } {
  return { asked: `ask:${env}:asked:${month}`, model: `ask:${env}:model:${month}` };
}
