# 1. SQLite in the browser

Date: 2026-09-21

## Status

Accepted

## Context

My content was already Markdown and YAML, and it only changes when I deploy. I wanted a visitor to be able to query it and to see the SQL behind every answer, so they could edit it and run it again. Running a visitor's SQL on the server would put a statement I cannot interrupt inside a function with a 30-second limit.

## Decision

The build compiles the content into one SQLite file with sql.js running in Node ([9eddbc1]). There is no native module to build on Vercel, and the browser runs the same library.

In the browser, sql.js runs in a Web Worker of my own. It loads the first time someone clicks or tabs into the console ([7c87504], [b8ec715]) or the Ask box ([bba109d]), never with the page. The worker sets SQLite's query_only flag before every statement and stops stepping at a row limit. The stock sql.js worker has no prepare step and no row limit, so I do not ship it.

The server still needs the database to check the model's SQL ([3](0003-sql-validation-by-prepare.md)). public/ is not part of the function bundle, and Vercel's file tracer cannot follow the path sql.js builds to its wasm at run time, so the build also writes both files into generated modules as base64.

## Consequences

Queries run on the visitor's machine and cost nothing on the server. Anyone can download the database or its SQL dump and check the site against it.

Every content change is a rebuild and a redeploy, and the first question on a visit can wait for the wasm and the database to arrive. sql.js cannot interrupt a statement in the browser either, so the page gives each one three seconds and then replaces the worker. The function bundle carries a second copy of the database and the wasm, in base64, a third larger than the files.

[9eddbc1]: https://github.com/AlexKachur98/alexkachur.com/commit/9eddbc1
[7c87504]: https://github.com/AlexKachur98/alexkachur.com/commit/7c87504
[b8ec715]: https://github.com/AlexKachur98/alexkachur.com/commit/b8ec715
[bba109d]: https://github.com/AlexKachur98/alexkachur.com/commit/bba109d
