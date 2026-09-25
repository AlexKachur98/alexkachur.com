// Anthropic's published numbers for the default model, read by hand on the day given, so the cost
// figures on /how-this-site-works and the eval's cost line come from one place. Change all three
// together when the price page changes.
export const PRICE = { input: 1, output: 5 } as const;
export const PRICE_CHECKED = '2026-09-25';
// The smallest prompt the model's cache will keep; the site's prompt is under it on purpose.
export const CACHE_MINIMUM_TOKENS = 4096;
