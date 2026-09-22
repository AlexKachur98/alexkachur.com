// The public endpoints, one list for the /api docs page and the OpenAPI document so neither can
// name a path the other lacks. Paths are exact: the prerendered ones end in .json because they
// are written as files, and a client fetches them by that name.
import type { TableName } from '../content/schemas.ts';

export interface Endpoint {
  method: 'GET' | 'POST';
  path: string;
  // The table whose rows the response is, for the endpoints that return a whole table.
  rows?: TableName;
}

export const endpoints: readonly Endpoint[] = [
  { method: 'GET', path: '/api/projects.json', rows: 'projects' },
  { method: 'GET', path: '/api/projects/{slug}.json' },
  { method: 'GET', path: '/api/technologies.json', rows: 'technologies' },
  { method: 'GET', path: '/api/timeline.json', rows: 'timeline' },
  { method: 'GET', path: '/api/pets.json', rows: 'pets' },
  { method: 'GET', path: '/api/schema.json' },
  { method: 'POST', path: '/api/ask' },
  { method: 'GET', path: '/api/stats' },
];
