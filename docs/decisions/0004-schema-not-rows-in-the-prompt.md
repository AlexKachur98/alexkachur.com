# 4. Schema, not rows, in the prompt

Date: 2026-09-22

## Status

Accepted

## Context

Sending the model the rows as well as the schema would make every call bigger, and an answer could then come from the model's reading of the data instead of from a query the visitor can read and run.

## Decision

The system prompt carries the schema with its column descriptions and CHECK lists, the rules and worked examples ([3c6bac1]). The model never sees query results either: the server prepares the SQL but never runs it, so it has none to send.

A few labels had to go in because the schema cannot show them. The facts table is keys and values, so the keys are listed ([bceeb7d]), each with a one-line description since [660f339]. The pages and headings of the page text went in after live runs caught the model guessing them ([073ce48], [b9ca030]).

The model also writes the one-line explanation shown above each answer. That text is checked for length, line breaks and links, and rendered as plain text.

## Consequences

The model cannot know an exact name or slug it has not been shown, so a rule tells it to use = only with values the prompt shows and LIKE for everything else. Every label added is sent, and paid for, on every call. The explanation is the one piece of model text a visitor reads that no engine has checked.

[3c6bac1]: https://github.com/AlexKachur98/alexkachur.com/commit/3c6bac1
[bceeb7d]: https://github.com/AlexKachur98/alexkachur.com/commit/bceeb7d
[660f339]: https://github.com/AlexKachur98/alexkachur.com/commit/660f339
[073ce48]: https://github.com/AlexKachur98/alexkachur.com/commit/073ce48
[b9ca030]: https://github.com/AlexKachur98/alexkachur.com/commit/b9ca030
