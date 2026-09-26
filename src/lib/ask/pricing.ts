// The default model's list prices in USD per million tokens, read on PRICE_CHECKED, for the cost
// figures on /how-this-site-works and the eval's cost line.
export const PRICE = { input: 1, output: 5 } as const;
export const PRICE_CHECKED = '2026-09-25';
// The smallest prompt the model's cache keeps. /how-this-site-works says the prompt is under it,
// so build-db fails once it is not.
export const CACHE_MINIMUM_TOKENS = 4096;
