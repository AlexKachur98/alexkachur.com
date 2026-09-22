import type { APIRoute } from 'astro';
import buildInfo from '../../generated/build-info.json';
import schema from '../../generated/schema.json';
import { json } from '../../lib/json.ts';
import { openApiDocument } from '../../lib/openapi.ts';

export const GET: APIRoute = ({ site }) => json(openApiDocument(schema, { site: new URL('/', site).origin, version: buildInfo.commit }));
