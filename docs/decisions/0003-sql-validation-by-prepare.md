# 3. SQL validation by prepare

Date: 2026-09-22

## Status

Accepted

## Context

The Ask box sends a visitor's question to a model, and the SQL it writes back runs in the visitor's browser. I do not trust that SQL, so the first question was what a bad statement could do there. It only ever runs on the visitor's own copy of the database, the worker sets query_only before every statement ([1](0001-sqlite-in-the-browser.md)), and the page renders every cell as text, apart from a photo_url that points at one of the site's own images. The worst a statement can do is run for three seconds or return the wrong rows.

So the server's job is narrower than keeping the data safe. It has to tell whether the SQL is valid for this schema, without me keeping a second copy of the schema's rules by hand.

## Decision

A short lexical pass runs first ([3c6bac1]): one SELECT or WITH statement, no comments, and none of the words that never belong in a read-only query, such as INSERT or PRAGMA. It turns the obvious cases away early. Read-only rests on query_only, not on this list.

Then the server prepares the statement against the real database with sql.js. SQLite parses and compiles it without running it, so bad syntax, unknown tables and unknown columns fail there, under the same rules the browser applies. The server never steps the statement, because sql.js cannot interrupt one, and it adds nothing to it, not even a LIMIT; the browser caps the rows.

If SQLite rejects the statement and enough time is left before the function's limit, the model gets one retry with SQLite's error message.

## Consequences

There is no list of tables or columns to maintain; prepare reads them from the database.

Preparing says nothing about cost. A recursive CTE that never ends passes. A plain SELECT from it stops at the row limit, but a COUNT over it reads every row, so it runs until the page replaces the worker after three seconds.

A retry is a second paid call ([5](0005-reserved-calls-under-a-monthly-cap.md)). The word list also refuses some harmless SQL, like the text 'sqlite_master' inside a string literal, because telling that apart from the table would take a parser.

[3c6bac1]: https://github.com/AlexKachur98/alexkachur.com/commit/3c6bac1
