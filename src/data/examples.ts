// The example queries (the pets query selects born instead of age, which the pets table does not
// store). One source for the console buttons, the Ask chips, the fallback list and the worked
// examples in the ask prompt.
export interface Example {
  label: string;
  sql: string;
  // The sentence the ask prompt shows with this example as a worked answer; an example without
  // one is left out of the prompt.
  explanation?: string;
  // One line shown under the example's table when it runs in the Ask panel: a link, then the rest
  // of the sentence.
  more?: { href: string; link: string; rest: string };
}

// The storage example has a name of its own because the /api page shows its query above the
// table it reads.
const storage: Example = {
  label: 'What does this site store about me?',
  sql: 'SELECT item, kept_for, purpose FROM storage;',
  explanation: 'Lists what this site stores, how long it keeps each thing and why.',
  more: {
    href: '/api#what-is-stored',
    link: 'Full details on the API page',
    rest: ', including what Anthropic and Vercel keep.',
  },
};

export const examples: readonly Example[] = [
  {
    label: 'What has Alex built for paying clients?',
    sql: 'SELECT name, client_name, year_start, live_url FROM projects WHERE paid = 1;',
    explanation: 'Lists the projects Alex was paid for, with the client, the start year and the live URL.',
  },
  {
    label: 'Which projects use an LLM, and what is its job?',
    sql: 'SELECT name, llm_job FROM projects WHERE uses_llm = 1;',
    explanation: 'Lists the projects where a language model does real work, with what it does in each.',
  },
  {
    label: 'What did Alex do before development?',
    sql: 'SELECT title, organization, start, end, summary FROM experience WHERE end IS NOT NULL ORDER BY start;',
    explanation: "Lists Alex's past jobs, the ones that have ended, with dates and a summary of each.",
  },
  storage,
  {
    label: 'Which technologies show up in more than one project?',
    sql: 'SELECT t.name, COUNT(*) AS projects FROM technologies t JOIN project_technologies pt ON pt.technology_id = t.id GROUP BY t.name HAVING COUNT(*) > 1 ORDER BY projects DESC;',
    explanation: 'Counts the projects each technology appears in and keeps the ones used more than once.',
  },
  {
    label: 'What is Alex studying this semester?',
    sql: "SELECT code, name FROM courses WHERE term = 'Fall 2026';",
    explanation: 'Lists the course codes and names for the Fall 2026 term.',
  },
  {
    label: 'Who lives with Alex?',
    sql: 'SELECT name, breed, born, personality, photo_url FROM pets;',
  },
  {
    label: 'When is Alex available, and where?',
    sql: "SELECT key, value FROM facts WHERE key IN ('location', 'status', 'available_from');",
    explanation: 'Reads where Alex is, what he is doing now and when he is available from the facts table.',
  },
];

// The Ask chips carry the first four examples statically and run them with no API call, so they
// work when the monthly cap is reached or the model is down.
export const chips: readonly Example[] = examples.slice(0, 4);

// The query behind the storage chip, which the /api page also shows above its table.
export const storageQuery = storage.sql;

// The answer beside the Ask box on a wide screen before anyone asks, run at build time: a
// question the chips do not already ask. One row per skill area of the core skills, the areas and
// the names inside each in alphabetical order, so the rows never depend on insertion order.
export const answerExample: Example = {
  label: "What are Alex's core skills?",
  sql: "SELECT skill_area, GROUP_CONCAT(name, ', ' ORDER BY name) AS skills FROM technologies WHERE core = 1 GROUP BY skill_area ORDER BY lower(skill_area);",
};
