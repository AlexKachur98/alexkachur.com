---
order: 4
name: Portfolio site
kind: personal
summary: A portfolio that compiles to a SQLite database, answers questions by writing SQL, exposes a public API, and caps its own AI spending.
card: A portfolio that compiles to a database, answers questions by writing SQL, and caps its own AI bill. 2026.
role: everything
year_start: 2026
year_end: null
client_name: null
live_url: https://alexkachur.com
repo_url: https://github.com/AlexKachur98/alexkachur.com
has_live_demo: 1
uses_llm: 1
llm_job: turns a visitor's question into one validated SQL statement that runs in their browser.
paid: 0
highlights:
  - "Built a portfolio that compiles into a SQLite database at deploy time. Visitors ask questions in plain English; Claude writes the SQL, the server checks it against the real database, and the visitor's browser runs it."
  - "Capped AI spending with a monthly limit, an answer cache and a rate limiter; CI replays a {eval_questions}-question evaluation on every push."
  - "Public JSON API with an OpenAPI {openapi_version} document."
technologies: [astro, typescript, css, sql, sql-js, sqlite, vercel, anthropic-api, upstash-redis, vitest]
# TODO: add screenshots of this site after the build.
screenshots: []
---

## The problem

Every portfolio says "full-stack with AI". I wanted one where you can check.

## What I built

<!-- TODO: write this after the build. Cover the build-time database, the Ask pipeline and its validation rules, the public API, the curl response, the cost cap and cache, and the readouts in the footer. -->

## Decisions

<!-- TODO: write this after the build. At least: SQL generated on the server but run in the browser; engine validation, preparing the SQL against the real database, instead of trusting the model; a monthly cap with a graceful fallback. -->

## What went wrong or what I would change

<!-- TODO: write this after the build. -->

## Outcome

<!-- TODO: add the Lighthouse scores and the monthly AI cost. -->
