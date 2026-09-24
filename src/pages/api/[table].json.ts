import type { APIRoute, GetStaticPaths } from 'astro';
import { tableEndpoints } from '../../lib/endpoints.ts';
import { json } from '../../lib/json.ts';
import { select } from '../../lib/query.ts';

export const getStaticPaths = (() => tableEndpoints.map((endpoint) => ({ params: { table: endpoint.rows } }))) satisfies GetStaticPaths;

// Every row of the table, as a query of the built database returns it: the columns in their DDL
// order and the rows in the order they were written.
export const GET: APIRoute = async ({ params }) => {
  const { columns, rows } = await select(`SELECT * FROM ${params.table} ORDER BY rowid`);
  return json(rows.map((row) => Object.fromEntries(columns.map((name, index) => [name, row[index]]))));
};
