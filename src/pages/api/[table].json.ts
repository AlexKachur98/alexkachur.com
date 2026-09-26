import type { APIRoute, GetStaticPaths } from 'astro';
import type { TableName } from '../../content/schemas.ts';
import { tableEndpoints } from '../../lib/endpoints.ts';
import { json } from '../../lib/json.ts';
import { tableObjects } from '../../lib/query.ts';

export const getStaticPaths = (() => tableEndpoints.map((endpoint) => ({ params: { table: endpoint.rows } }))) satisfies GetStaticPaths;

export const GET: APIRoute = async ({ params }) => json(await tableObjects(params.table as TableName));
