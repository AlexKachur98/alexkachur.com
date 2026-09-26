# 6. Answer cache key

Date: 2026-09-22

## Status

Accepted

## Context

People ask the same things in slightly different words, and a cached answer costs nothing. But the cache holds SQL, and SQL written under an older prompt or for an older schema can be wrong against the current database.

## Decision

The key is the deployment environment, the prompt version, the first eight characters of a hash of the schema the prompt shows, and a SHA-256 of the normalized question ([8c7c818]). The environment keeps a preview from reading production's cache. Normalizing applies Unicode NFKC, folds case and spacing, drops a closing ? . or !, and strips nothing inside the question, so one about C# never gets the answer cached for one about C.

The value is the SQL and its explanation, never rows, so a change to the data needs no invalidation. Answers are kept for 30 days and refusals for one.

## Consequences

A schema change or a new prompt version makes every old answer miss, and the first questions after that deploy are paid for again. I bump the version by hand. A test pins a hash of the prompt text beside it, but the validator is outside that hash, so a change there still depends on me remembering.

The model's name is not in the key, so after a switch the old model's answers are served until they expire. They passed the validator against the same schema, so they still run. A paraphrase is a new question and a new call.

[8c7c818]: https://github.com/AlexKachur98/alexkachur.com/commit/8c7c818
