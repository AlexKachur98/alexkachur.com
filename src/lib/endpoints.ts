// The public endpoints, one list for the /api docs page and the OpenAPI document so neither can
// name a path the other lacks. Paths are exact: the prerendered ones end in .json because they
// are written as files, and a client fetches them by that name.
import { tables } from '../content/schemas.ts';
import type { TableName } from '../content/schemas.ts';

export interface Endpoint {
  method: 'GET' | 'POST';
  path: string;
  // The table whose rows the response is, for the endpoints that return a whole table.
  rows?: TableName;
}

// Every table's rows at /api/{table}.json, projects first, but project_technologies, whose links
// each project's own endpoint already carries as technology names.
export const tableEndpoints: readonly (Endpoint & { rows: TableName })[] = (Object.keys(tables) as TableName[])
  .filter((table) => table !== 'project_technologies')
  .sort((a, b) => Number(b === 'projects') - Number(a === 'projects'))
  .map((table) => ({ method: 'GET', path: `/api/${table}.json`, rows: table }));

export const endpoints: readonly Endpoint[] = [
  tableEndpoints[0]!,
  { method: 'GET', path: '/api/projects/{slug}.json' },
  ...tableEndpoints.slice(1),
  { method: 'GET', path: '/api/schema.json' },
  { method: 'GET', path: '/api/resume.json' },
  { method: 'POST', path: '/api/ask' },
  { method: 'POST', path: '/api/questions' },
  { method: 'GET', path: '/api/stats' },
];
