// The OpenAPI 3.1 document served as /api/openapi.json, built at build time from schema.json
// (one component per table, every column with its type and description) and the endpoint list,
// so the API loads into any client that reads OpenAPI. Paths are the exact ones the files are
// served at, .json suffix included.
import { QUESTION_LENGTH } from './ask/handler.ts';
import { SEND, SEND_DESCRIPTION } from './ask/send.ts';
import { RATE_LIMIT } from './ask/storage.ts';
import { endpoints } from './endpoints.ts';
import type { Endpoint } from './endpoints.ts';
import { OPENAPI_VERSION } from './openapi-version.ts';

// What each endpoint is, for the /api page and this document alike, so the two cannot drift. Third
// person, Alex named, the API caller addressed as "you" where it must be.
export const PROJECT_DESCRIPTION = 'The projects row with this slug, plus the names of its technologies. Its screenshots are the project_images rows with its id, at /api/project_images.json.';
export const SCHEMA_DESCRIPTION =
  'The tables and columns of the database, the SQL that created them, the keys of the facts table with what each means, the pages and headings of the sections table, and a hash covering all of those. The SQL and those three lists are the schema the Ask box sends to the model.';
export const RESUME_DESCRIPTION = "Alex's resume in the JSON Resume format, built from the same database as everything else.";
export const ASK_DESCRIPTION =
  "Send a question and get back SQL that answers it from this site's database, checked against the real database first, or a short refusal when the data can't answer it. It never runs the SQL; you do.";
export const STATS_DESCRIPTION = 'The numbers behind the footer: questions answered this month, model calls this month and the monthly cap, the model the Ask box runs on, and the commit and time of the build.';

export interface SchemaColumn {
  name: string;
  type: string;
  nullable: boolean;
  unique: boolean;
  values?: (string | number)[];
  description: string;
}

export interface SchemaTable {
  name: string;
  description: string;
  primaryKey: string[];
  columns: SchemaColumn[];
}

export interface SchemaDocument {
  hash: string;
  ddl: string;
  tables: SchemaTable[];
  factKeys: string[];
  facts: { key: string; description: string }[];
  sectionPages: string[];
  sectionHeadings: string[];
  photoAlt: Record<string, string>;
}

export interface OpenApiOptions {
  // Origin of the deployed site, the one server in the document.
  site: string;
  // The commit the site was built from, as the document version.
  version: string;
}

type JsonSchema = Record<string, unknown>;

const ref = (name: string): JsonSchema => ({ $ref: `#/components/schemas/${name}` });

function columnSchema(column: SchemaColumn): JsonSchema {
  const type = column.type === 'INTEGER' ? 'integer' : 'string';
  return {
    type: column.nullable ? [type, 'null'] : type,
    ...(column.values ? { enum: column.nullable ? [...column.values, null] : [...column.values] } : {}),
    description: column.description,
  };
}

function rowSchema(table: SchemaTable): JsonSchema {
  return {
    type: 'object',
    description: table.description,
    properties: Object.fromEntries(table.columns.map((column) => [column.name, columnSchema(column)])),
    required: table.columns.map((column) => column.name),
  };
}

function jsonResponse(description: string, schema: JsonSchema): JsonSchema {
  return { description, content: { 'application/json': { schema } } };
}

function errorBody(code: string): JsonSchema {
  return { type: 'object', properties: { error: { const: code } }, required: ['error'] };
}

const stringList: JsonSchema = { type: 'array', items: { type: 'string' } };

// The shapes that are not table rows: the project detail, the schema document, and what the
// on-demand endpoints take and return.
const shapes: Record<string, JsonSchema> = {
  project_detail: {
    description: 'A projects row with the names of its technologies',
    allOf: [
      ref('projects'),
      {
        type: 'object',
        properties: { technologies: { ...stringList, description: 'Names from the technologies table' } },
        required: ['technologies'],
      },
    ],
  },
  database_schema: {
    type: 'object',
    description: SCHEMA_DESCRIPTION,
    properties: {
      hash: { type: 'string', description: 'SHA-256 of the DDL, the table list, the fact keys with their descriptions, and the pages and headings of the sections table' },
      ddl: { type: 'string', description: 'The CREATE TABLE statements, with a comment per column' },
      tables: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            description: { type: 'string' },
            primaryKey: stringList,
            columns: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  type: { type: 'string', enum: ['INTEGER', 'TEXT'] },
                  nullable: { type: 'boolean' },
                  unique: { type: 'boolean' },
                  values: { type: 'array', items: { type: ['string', 'integer'] }, description: 'The allowed values, when the column has a CHECK' },
                  description: { type: 'string' },
                },
                required: ['name', 'type', 'nullable', 'unique', 'description'],
              },
            },
          },
          required: ['name', 'description', 'primaryKey', 'columns'],
        },
      },
      factKeys: { ...stringList, description: 'The keys of the facts table' },
      sectionPages: {
        type: 'array',
        description: 'The pages the sections table holds, each once, sorted',
        items: { type: 'string' },
      },
      sectionHeadings: {
        type: 'array',
        description: 'The headings the sections table holds, in page order',
        items: { type: 'string' },
      },
      facts: {
        type: 'array',
        description: 'The keys of the facts table, each with what it means',
        items: {
          type: 'object',
          properties: { key: { type: 'string' }, description: { type: 'string' } },
          required: ['key', 'description'],
        },
      },
      photoAlt: { type: 'object', additionalProperties: { type: 'string' }, description: 'Alt text by photo path, for the pets photos' },
    },
    required: ['hash', 'ddl', 'tables', 'factKeys', 'facts', 'sectionPages', 'sectionHeadings', 'photoAlt'],
  },
  ask_request: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        minLength: QUESTION_LENGTH.min,
        maxLength: QUESTION_LENGTH.max,
        description: `A question about the data, in plain words, ${QUESTION_LENGTH.min} to ${QUESTION_LENGTH.max} characters after trimming`,
      },
    },
    required: ['question'],
  },
  ask_answer: {
    type: 'object',
    properties: {
      sql: {
        type: 'string',
        description: 'A single SELECT or WITH statement prepared against the database, or empty when the question cannot be answered from it',
      },
      explanation: { type: 'string', description: 'One sentence on what the SQL does, or on why there is none' },
      cached: { type: 'boolean', description: 'True when the answer came from the cache rather than the model' },
      token: {
        type: 'string',
        description: `Lets the visitor send this question to Alex through /api/questions within ${SEND.windowSeconds / 60} minutes`,
      },
    },
    required: ['sql', 'explanation', 'cached', 'token'],
  },
  send_request: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        minLength: QUESTION_LENGTH.min,
        maxLength: QUESTION_LENGTH.max,
        description: 'The question exactly as it was asked, with no control or text-direction characters',
      },
      token: { type: 'string', description: 'The token /api/ask returned with that question' },
    },
    required: ['question', 'token'],
  },
  send_answer: {
    type: 'object',
    properties: { sent: { const: true, description: 'The same whether the question is new or was sent before' } },
    required: ['sent'],
  },
  unavailable: {
    type: 'object',
    properties: {
      reason: {
        type: 'string',
        enum: ['budget', 'config', 'upstream'],
        description: 'budget when the monthly cap is reached, config when the service is not set up, upstream when the model or the store did not answer',
      },
    },
    required: ['reason'],
  },
  stats: {
    type: 'object',
    properties: {
      questionsThisMonth: { type: 'integer', description: 'Questions answered this UTC calendar month, cached answers and refusals included' },
      modelCallsThisMonth: { type: 'integer', description: 'Model calls attempted this month, retries and failures included; this is what the cap counts' },
      cap: { type: 'integer', description: 'Model calls allowed per month; 0 means asking is switched off' },
      model: { type: 'string', description: 'The model id in use' },
      commit: { type: 'string', description: 'The commit the site was built from' },
      builtAt: { type: 'string', format: 'date-time', description: 'When the site was built' },
    },
    required: ['questionsThisMonth', 'modelCallsThisMonth', 'cap', 'model', 'commit', 'builtAt'],
  },
};

function operation(endpoint: Endpoint, tables: Map<string, SchemaTable>): JsonSchema {
  switch (endpoint.path) {
    case '/api/projects/{slug}.json':
      return {
        operationId: 'getProject',
        description: PROJECT_DESCRIPTION,
        parameters: [
          { name: 'slug', in: 'path', required: true, description: "The project's slug, its short name in URLs", schema: { type: 'string' } },
        ],
        responses: {
          '200': jsonResponse('The project and its technologies', ref('project_detail')),
          '404': { description: 'No project has this slug' },
        },
      };
    case '/api/schema.json':
      return { operationId: 'getSchema', description: SCHEMA_DESCRIPTION, responses: { '200': jsonResponse('The database schema', ref('database_schema')) } };
    case '/api/resume.json':
      return {
        operationId: 'getResume',
        description: RESUME_DESCRIPTION,
        responses: { '200': jsonResponse('A JSON Resume document, schema 1.x from jsonresume.org', { type: 'object' }) },
      };
    case '/api/ask':
      return {
        operationId: 'ask',
        description: `${ASK_DESCRIPTION} Rate limits: ${RATE_LIMIT.requests} questions a minute per address and a monthly cap; when the cap is reached the endpoint returns 503 with reason "budget".`,
        requestBody: { required: true, content: { 'application/json': { schema: ref('ask_request') } } },
        responses: {
          '200': jsonResponse('SQL for the question, or an explanation of why there is none', ref('ask_answer')),
          '400': jsonResponse(`The body has no question of ${QUESTION_LENGTH.min} to ${QUESTION_LENGTH.max} characters`, errorBody('invalid_question')),
          '422': jsonResponse('The model gave nothing that prepares as a safe query', errorBody('unusable_output')),
          '429': jsonResponse(`More than ${RATE_LIMIT.requests} questions in a minute from one address`, errorBody('rate_limited')),
          '500': jsonResponse('An unexpected failure', errorBody('internal')),
          '503': jsonResponse('Not answering: the monthly cap is reached, the service is not set up, or the model did not respond', ref('unavailable')),
        },
      };
    case '/api/questions':
      return {
        operationId: 'sendQuestion',
        description: SEND_DESCRIPTION,
        requestBody: { required: true, content: { 'application/json': { schema: ref('send_request') } } },
        responses: {
          '200': jsonResponse('The question is kept for Alex', ref('send_answer')),
          '400': jsonResponse(`The body has no question of ${QUESTION_LENGTH.min} to ${QUESTION_LENGTH.max} characters, or it holds control or text-direction characters`, errorBody('invalid_question')),
          '403': jsonResponse(`The token is missing, not for this question, or older than ${SEND.windowSeconds / 60} minutes`, errorBody('invalid_token')),
          '429': jsonResponse('Over the rate limit, or the day has taken all the questions it can', {
            type: 'object',
            properties: { error: { enum: ['rate_limited', 'daily_cap'] } },
            required: ['error'],
          }),
          '500': jsonResponse('An unexpected failure', errorBody('internal')),
          '503': jsonResponse('Not answering: asking is switched off, the service is not set up, or the store did not respond', ref('unavailable')),
        },
      };
    case '/api/stats':
      return {
        operationId: 'getStats',
        description: STATS_DESCRIPTION,
        responses: {
          '200': jsonResponse('The counters for the current month and the build', ref('stats')),
          '503': jsonResponse('The counters could not be read', ref('unavailable')),
        },
      };
    default: {
      const table = endpoint.rows && tables.get(endpoint.rows);
      if (!endpoint.rows || !table) throw new Error(`${endpoint.path}: no operation in the OpenAPI document`);
      return {
        operationId: `list${endpoint.rows.split('_').map((word) => `${word[0]!.toUpperCase()}${word.slice(1)}`).join('')}`,
        summary: table.description,
        responses: { '200': jsonResponse(`Every row of the ${endpoint.rows} table`, { type: 'array', items: ref(endpoint.rows) }) },
      };
    }
  }
}

export function openApiDocument(schema: SchemaDocument, { site, version }: OpenApiOptions) {
  const tables = new Map(schema.tables.map((table) => [table.name, table]));
  const paths: Record<string, JsonSchema> = {};
  for (const endpoint of endpoints) {
    paths[endpoint.path] = { ...paths[endpoint.path], [endpoint.method.toLowerCase()]: operation(endpoint, tables) };
  }
  return {
    openapi: OPENAPI_VERSION,
    info: {
      title: 'alexkachur.com API',
      version,
      description: 'These endpoints return the same records the pages are built from.',
    },
    servers: [{ url: site }],
    paths,
    components: { schemas: { ...Object.fromEntries(schema.tables.map((table) => [table.name, rowSchema(table)])), ...shapes } },
  };
}
