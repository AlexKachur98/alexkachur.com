// The six example queries (query 5 selects born instead of age, which the pets table does not
// store). One source for the console buttons, the two Ask chips and the worked examples in the
// ask prompt.
export interface Example {
  label: string;
  sql: string;
}

export const examples: readonly Example[] = [
  {
    label: 'What has Alex built for paying clients?',
    sql: 'SELECT name, client_name, year_start, live_url FROM projects WHERE paid = 1;',
  },
  {
    label: 'Which projects use an LLM, and what is its job?',
    sql: 'SELECT name, llm_job FROM projects WHERE uses_llm = 1;',
  },
  {
    label: 'Which technologies show up in more than one project?',
    sql: 'SELECT t.name, COUNT(*) AS projects FROM technologies t JOIN project_technologies pt ON pt.technology_id = t.id GROUP BY t.name HAVING COUNT(*) > 1 ORDER BY projects DESC;',
  },
  {
    label: 'What is Alex studying this semester?',
    sql: "SELECT code, name FROM courses WHERE term = 'Fall 2026';",
  },
  {
    label: 'Who lives with Alex?',
    sql: 'SELECT name, breed, born, personality, photo_url FROM pets;',
  },
  {
    label: 'When is Alex available, and where?',
    sql: "SELECT key, value FROM facts WHERE key IN ('location', 'status', 'available_from');",
  },
];

// The two Ask chips carry examples 1 and 2 statically and run with no API call.
export const chips: readonly Example[] = examples.slice(0, 2);

// The answer beside the Ask box on a wide screen before anyone asks, run at build time: a
// question the chips do not already ask. The limit ends the list where a tie in the ranking ends,
// so no row is there only because its name sorts first; the build test checks that it still does.
export const answerExample: Example = {
  label: 'Which technologies does Alex use most?',
  sql: 'SELECT t.name, COUNT(*) AS projects FROM technologies t JOIN project_technologies pt ON pt.technology_id = t.id GROUP BY t.name ORDER BY projects DESC, t.name LIMIT 4;',
};
