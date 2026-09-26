// The site's address, for Astro's site setting and for the build script, which writes the
// plain-text resume before Astro runs. Vercel sets VERCEL_PROJECT_PRODUCTION_URL to the .vercel.app
// host until the custom domain connects, then to the domain.
export function siteOrigin(): string {
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  return host ? `https://${host}` : 'https://alexkachur.com';
}
