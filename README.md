# alexkachur.com

[![ci](https://github.com/AlexKachur98/alexkachur.com/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/AlexKachur98/alexkachur.com/actions/workflows/ci.yml)

The code behind my portfolio, [alexkachur.com](https://alexkachur.com). It is a small full-stack system: all my content compiles into a SQLite database when the site builds, and you can ask that database questions in plain English.

![The alexkachur.com home page in the dark theme. Under my name and role, the Ask box holds the question "Which projects use an LLM, and what does it do?". Beside it is the answer: the model's one-line explanation, the SQL it wrote, and two rows, the SplitRoof AI assistant and the portfolio site, each with the job its model does.](docs/home-page.png)

## Ways in

Type a question into the Ask box on the home page. A model turns it into SQL and the server checks that SQL against the real database, then your browser runs it. The SQL is shown with every answer, and the console further down the page lets you edit it or write your own.

The same records are public JSON. [/api](https://alexkachur.com/api) lists the endpoints, and [/api/openapi.json](https://alexkachur.com/api/openapi.json) describes them in OpenAPI 3.1.

From a terminal, this prints my resume as plain text:

```sh
curl https://alexkachur.com
```

## How it works

The full write-up, with what it costs and what broke, is at [/how-this-site-works](https://alexkachur.com/how-this-site-works). In the code, [src/lib/ask/handler.ts](src/lib/ask/handler.ts) is the whole path from a question to checked SQL, with the checks in the order they run.

Two limits I know about. A statement that prepares can still be slow: a recursive query that never ends runs until the page stops it after three seconds. And the rate limit is per address, so people behind one office or carrier address share it.

## Running it locally

You need Node 24, the version in .nvmrc.

```sh
npm ci
npm run dev
```

With no keys at all, everything but a typed question works, the console and the example questions included. A typed question gets a short note and the examples instead of an answer. To ask for real, copy .env.example to .env and set ANTHROPIC_API_KEY and ASK_RATE_LIMIT_SECRET. Without a Redis pair, nothing is capped or cached locally, so every question you type is a paid call on your key. Sending a question to me, and `npm run questions`, need an Upstash or KV Redis pair. .env.example describes every variable. The curl rewrite only runs on Vercel; locally the same text is at /resume.txt.

```sh
npm test
npm run check
npm run eval
```

`npm test` builds the site first, then runs the Vitest suite. `npm run check` runs astro check. `npm run eval` needs that build but no key: it replays the model's recorded answers to a fixed list of questions through the real handler. It fails if an answer misses its expectations, if the handler's result differs from the recording, or if the model, the prompt version or the schema has changed since recording. `npm run eval:record` asks the model again, so it needs ANTHROPIC_API_KEY. `npm run test:e2e` runs the browser tests against the same build; install Chromium for them once with `npx playwright install chromium`.

## Decisions

[docs/decisions](docs/decisions) holds short records of the choices behind the database and the Ask box, written after the fact from the commits they name and dated by the first of them. [SQL validation by prepare](docs/decisions/0003-sql-validation-by-prepare.md) is the one to start with.

## Security and license

If you find a security problem, [SECURITY.md](SECURITY.md) says how to reach me.

The code is MIT licensed; see [LICENSE](LICENSE). The content is not licensed for reuse: the writing in src/content (apart from schemas.ts, which is code), the photos and screenshots in src/assets and public/images, the resume PDF in public, and the JSON files in src/data. The client screenshots show the clients' own work and brands; the rest is mine.
