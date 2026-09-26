# 2. One content source

Date: 2026-09-21

## Status

Accepted

## Context

The same facts show up on the home page, in the case studies, in the JSON API, in the plain-text resume and in the Ask box's answers. A date typed in two places can be changed in one and missed in the other, and a visitor who queries the database should never get a different answer from the page they are reading.

## Decision

What the site says about me and my work is written once, in src/content. Interface text, like labels, messages and the footer line, stays in the code that uses it.

build-db parses every YAML and Markdown file there itself, against the zod schemas in src/content/schemas.ts, and fails the build on a row with no id or a reference to nothing ([9eddbc1]). Astro's loaders would drop the first and only log the second. Astro reads the projects, technologies and pages collections through the same schemas.

Page prose moved into Markdown that the page and the sections table render with the same processor ([79abf52], [d57b019]). The plain-text resume and /api/resume.json are generated from the database ([b16520f]). A test fails if one of six guarded facts, such as my email or the role line, is typed anywhere else in src.

The PDF resume is the one thing I still make by hand, in Word. A test reads its text and checks it against the database, and its failure message says to export it again.

## Consequences

Projects, technologies and pages are parsed twice, by Astro and by build-db. The shared schemas, and a test that checks each built page shows exactly the text its rows hold, keep the two in step.

Page Markdown can only use what the sections table can hold as text: h2 headings, paragraphs, lists, links, and bold, italic or code inside them. Anything else fails the build.

Headings and fact descriptions are part of the prompt, so changing one makes every cached answer miss ([6](0006-answer-cache-key.md)) and means recording the eval again ([7](0007-recorded-model-replies-in-ci.md)). A change to any claim the PDF repeats means exporting it again.

[9eddbc1]: https://github.com/AlexKachur98/alexkachur.com/commit/9eddbc1
[79abf52]: https://github.com/AlexKachur98/alexkachur.com/commit/79abf52
[d57b019]: https://github.com/AlexKachur98/alexkachur.com/commit/d57b019
[b16520f]: https://github.com/AlexKachur98/alexkachur.com/commit/b16520f
