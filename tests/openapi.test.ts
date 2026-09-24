import { describe, expect, it } from 'vitest';
import type { AskConfig } from '../src/lib/ask/config.ts';
import { skippedStore } from '../src/lib/ask/redis.ts';
import { handleStats } from '../src/lib/ask/stats.ts';
import { tables } from '../src/content/schemas.ts';
import { endpoints } from '../src/lib/endpoints.ts';
import { openApiDocument } from '../src/lib/openapi.ts';
import schema from '../src/generated/schema.json';

const site = 'https://alexkachur.com';
const document = openApiDocument(schema, { site, version: 'abc1234' });

type Operation = {
  operationId: string;
  parameters?: unknown[];
  responses: Record<string, { description: string; content?: Record<string, { schema: unknown }> }>;
};
const paths = document.paths as Record<string, Record<string, Operation>>;
const schemas = document.components.schemas as Record<string, Record<string, unknown>>;

const operations = Object.entries(paths).flatMap(([path, methods]) =>
  Object.entries(methods).map(([method, operation]) => ({ path, method, operation })),
);

function refs(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((item) => refs(item, found));
  else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key === '$ref' && typeof item === 'string') found.push(item);
      else refs(item, found);
    }
  }
  return found;
}

describe('the OpenAPI document', () => {
  it('is a 3.1 document with the site as its one server and the build as its version', () => {
    expect(document.openapi).toBe('3.1.0');
    expect(document.info.version).toBe('abc1234');
    expect(document.info.title).toBeTruthy();
    expect(document.servers).toEqual([{ url: site }]);
    expect(JSON.parse(JSON.stringify(document))).toEqual(document);
  });

  it('names every endpoint by its exact path and method, .json suffix included', () => {
    expect(Object.keys(paths).sort()).toEqual([...endpoints.map((endpoint) => endpoint.path)].sort());
    expect(Object.keys(paths).sort()).toEqual([
      '/api/ask',
      '/api/pets.json',
      '/api/projects.json',
      '/api/projects/{slug}.json',
      '/api/schema.json',
      '/api/stats',
      '/api/technologies.json',
      '/api/timeline.json',
    ]);
    for (const endpoint of endpoints) {
      expect(Object.keys(paths[endpoint.path]!), endpoint.path).toEqual([endpoint.method.toLowerCase()]);
    }
    expect(operations.map(({ operation }) => operation.operationId).sort()).toEqual(
      ['ask', 'getProject', 'getSchema', 'getStats', 'listPets', 'listProjects', 'listTechnologies', 'listTimeline'].sort(),
    );
  });

  it('carries a component for every row schema with every column typed and described', () => {
    expect(schema.tables.map((table) => table.name)).toEqual(Object.keys(tables));
    for (const table of schema.tables) {
      const component = schemas[table.name] as { type: string; description: string; properties: Record<string, Record<string, unknown>>; required: string[] };
      expect(component, table.name).toBeDefined();
      expect(component.type).toBe('object');
      expect(component.description).toBe(table.description);
      expect(Object.keys(component.properties)).toEqual(table.columns.map((column) => column.name));
      expect(component.required).toEqual(table.columns.map((column) => column.name));
      for (const column of table.columns) {
        const property = component.properties[column.name]!;
        const base = column.type === 'INTEGER' ? 'integer' : 'string';
        expect(property['type'], `${table.name}.${column.name}`).toEqual(column.nullable ? [base, 'null'] : base);
        expect(property['description']).toBe(column.description);
        const values = (column as { values?: (string | number)[] }).values;
        if (values) expect(property['enum']).toEqual(column.nullable ? [...values, null] : values);
        else expect(property).not.toHaveProperty('enum');
      }
    }
  });

  it('answers each row endpoint with an array of its table rows', () => {
    for (const endpoint of endpoints.filter((entry) => entry.rows)) {
      const response = paths[endpoint.path]!['get']!.responses['200']!;
      expect(response.content?.['application/json']?.schema, endpoint.path).toEqual({
        type: 'array',
        items: { $ref: `#/components/schemas/${endpoint.rows}` },
      });
    }
    const detail = paths['/api/projects/{slug}.json']!['get']!;
    expect(detail.parameters).toEqual([expect.objectContaining({ name: 'slug', in: 'path', required: true })]);
    expect(detail.responses['200']!.content?.['application/json']?.schema).toEqual({ $ref: '#/components/schemas/project_detail' });
    expect(schemas['project_detail']!['allOf']).toEqual([
      { $ref: '#/components/schemas/projects' },
      expect.objectContaining({ required: ['technologies'] }),
    ]);
  });

  it('points every $ref at a component that exists', () => {
    const found = refs(document);
    expect(found.length).toBeGreaterThan(8);
    for (const target of found) {
      const name = target.replace('#/components/schemas/', '');
      expect(target, target).toBe(`#/components/schemas/${name}`);
      expect(schemas[name], target).toBeDefined();
    }
  });

  it('gives every response the description the format requires', () => {
    for (const { path, method, operation } of operations) {
      expect(Object.keys(operation.responses).length, `${method} ${path}`).toBeGreaterThan(0);
      for (const [status, response] of Object.entries(operation.responses)) {
        expect(status).toMatch(/^[1-5]\d\d$/);
        expect(typeof response.description, `${method} ${path} ${status}`).toBe('string');
        expect(response.description.length).toBeGreaterThan(0);
      }
    }
  });

  it('documents the ask request limits from the handler and every status it answers', () => {
    const ask = paths['/api/ask']!['post']!;
    expect(Object.keys(ask.responses).sort()).toEqual(['200', '400', '422', '429', '500', '503']);
    const request = schemas['ask_request'] as { properties: { question: { minLength: number; maxLength: number } }; required: string[] };
    expect(request.properties.question.minLength).toBe(3);
    expect(request.properties.question.maxLength).toBe(200);
    expect(request.required).toEqual(['question']);
    const answer = schemas['ask_answer'] as { required: string[] };
    expect(answer.required).toEqual(['sql', 'explanation', 'cached']);
    const unavailable = schemas['unavailable'] as { properties: { reason: { enum: string[] } } };
    expect(unavailable.properties.reason.enum).toEqual(['budget', 'config', 'upstream']);
  });

  it('describes the stats body with exactly the fields the endpoint returns', async () => {
    const config: AskConfig = { env: 'test', model: 'm', maxTokens: 512, cap: 2000, apiKey: undefined, limitSecret: undefined, redis: null };
    const response = await handleStats({ config, store: skippedStore(), build: { commit: 'abc1234', builtAt: '2026-10-02T08:00:00.000Z' } });
    const body = (await response.json()) as Record<string, unknown>;
    const stats = schemas['stats'] as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(stats.properties).sort()).toEqual(Object.keys(body).sort());
    expect(stats.required.sort()).toEqual(Object.keys(body).sort());
    expect(paths['/api/stats']!['get']!.responses['200']!.content?.['application/json']?.schema).toEqual({ $ref: '#/components/schemas/stats' });
  });

  it('describes /api/schema.json with exactly the fields the build writes', () => {
    const shape = schemas['database_schema'] as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(shape.properties).sort()).toEqual(Object.keys(schema).sort());
    expect([...shape.required].sort()).toEqual(Object.keys(schema).sort());
  });
});
