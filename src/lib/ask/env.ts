import { getSecret } from 'astro:env/server';

// The variable getter for the on-demand endpoints. Vercel puts every variable in process.env;
// astro dev keeps .env in its own loader, which getSecret reads. Nothing is read from
// import.meta.env, which would be inlined at build.
export const env = (name: string): string | undefined => process.env[name] ?? (import.meta.env.DEV ? getSecret(name) : undefined);
