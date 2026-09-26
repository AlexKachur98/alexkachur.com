# 7. Recorded model replies in CI

Date: 2026-09-22

## Status

Accepted

## Context

One changed sentence in the prompt can change the answer to a question it was never written for. I wanted that caught on every push. Calling the model from CI would cost money on every run and put an API key in CI, and it would not give the same answer twice.

## Decision

scripts/eval.ts runs a fixed list of questions through the real handler, with the model's replies read from scripts/eval/fixtures.json instead of the API ([ba3dcd3]). A recording is tied to the model, the prompt version and the schema hash. The replay fails when any of them has changed, or when the handler's result differs from the one recorded. `npm run eval:record` calls the model and writes a new recording.

A replay also fails when an answer misses its question's expectations, such as a row count or text the rows must contain. That check came later ([fdddebf]), after a wrong answer had been passing since the first recording.

## Consequences

CI checks the handler, the validator and the database on every push without calling the model. It does not test the model: a replay proves that the answers I recorded still pass. The What broke section of /how-this-site-works tells how that gap let a wrong answer through.

Every change to the prompt or the schema means recording again, one call per question plus any retries.

[ba3dcd3]: https://github.com/AlexKachur98/alexkachur.com/commit/ba3dcd3
[fdddebf]: https://github.com/AlexKachur98/alexkachur.com/commit/fdddebf
