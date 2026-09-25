---
title: How this site works
---

This site is a small full-stack system. All my content compiles into a SQLite database when the site builds, and you can query it three ways: ask a question in plain English and a model writes the SQL, write SQL yourself in the console, or use the public JSON API. This page explains how each part works, what it costs, and what broke along the way.

## Architecture

If you run curl on my home page over https, you get my resume as plain text instead of the page. A lot of developers live in the terminal, so I wanted the site to answer them there too. wget, HTTPie and PowerShell get it as well.

## Build-time database

All my content starts as Markdown and YAML, plus a few values read from the code itself, like what the site stores and for how long. When the site builds, scripts/build-db.ts reads it and writes one SQLite database with {table_count} tables, plus a readable SQL dump you can open below. The same build renders the JSON endpoints and writes my plain-text resume, both from that database. If a row is missing its id or points at something that does not exist, the build fails instead of quietly dropping it. A test builds the database twice from the same content and checks the two are identical byte for byte. Same content, same database, so the fingerprint in the address only changes when the file's bytes do.

## The ask pipeline

Here is what happens when you ask a question. First the question gets checked, and one under {question_min} or over {question_max} characters, after trimming, stops there. Then there is a kill switch I can flip without touching the code: one setting and a redeploy. Then a rate limit of {rate_limit} questions a minute per address, counted under a scrambled form of your address, and sending a question to me counts against the same limit. Next is the cache: if the same question was asked recently, you get that answer and no model is called, even in a month when the budget is used up. If not, the monthly cap gets checked, and a model call is reserved before it is made, so retries and failures count too. Only then does the question go to the model, together with the schema, a one-line description of each fact, the pages and headings of the page sections, and a few worked examples. Apart from those labels, the CHECK lists in the schema and the examples, it never sees what is in the database, or any results. The SQL it sends back gets validated, and if SQLite rejects it with time left for a second call, the model gets one retry with the error. The SQL that passes comes back to your browser, and sql.js runs it there, on the same database you can download. If the site cannot answer, you can choose to send me the question, and only then is it kept, for {sent_question_kept}.

The model behind /api/ask is one environment variable, and Anthropic publishes each model's earliest retirement date, so a swap is a change of that variable and a re-recorded eval.

## What the validator rejects and why

I do not trust the SQL the model writes, and I do not try to guess whether it is safe with a long list of rules. The first pass is simple: the SQL must be one SELECT or WITH statement with no comments, and a word that never belongs in a read-only query, like INSERT, DROP or PRAGMA, gets it rejected right away. Then the real check. The SQL is prepared against the actual database, which means SQLite parses and compiles it without running it. Bad syntax, tables that do not exist and columns that do not exist all fail right there. That is what I mean when I say the validator is the database: SQLite already knows exactly what is valid, so I let it decide. And your browser runs it on its own copy of the database, with SQLite's query_only flag set before every statement, so nothing that runs there can change it.

## Cost and the cap

Every question that reaches the model costs a little money, and a public text box is an easy thing to abuse. So the site has a hard monthly cap of {monthly_cap} model calls. When it is reached, the Ask box tells you this month's budget is used up, and everything else keeps working: the examples, the console and the whole database still run in your browser, because they never needed the model. Cached answers do not count against the cap.

One question sends the model about {prompt_tokens} tokens: the schema, the fact keys with their descriptions, the section pages and headings, the worked examples, the question and the shape of the answer. That is the largest first call in the recorded eval. The answer is capped at {max_output_tokens} tokens. At Anthropic's published price for Claude Haiku 4.5, {price_input} per million input tokens and {price_output} per million output tokens as of {price_checked}, a month at the cap costs at most about {cap_month_cost}, with every answer at its full length. A retry sends the failed answer back with the error, so a month with many retries costs a little more.

The prompt is not cached. Anthropic's prompt cache needs at least {cache_minimum_tokens} tokens on Claude Haiku 4.5, checked the same day, and this prompt is under that, so a cache marker would do nothing. It would not pay anyway: a cached prompt lasts five minutes unless another question refreshes it, a cache write costs a quarter more than the prompt it saves, and this site sees far fewer than one question every five minutes.

<!-- TODO: add the typical month's real cost once a full month's bill exists. -->

## Caching

Answers are cached in Redis for {answer_cache}, refusals for {refusal_cache}. The key is built from the prompt version, a fingerprint of the database schema and a hash of your question after it is normalized, so the moment a schema change or a bump of the prompt version goes live, old answers stop matching. The cache stores the SQL and its one-line explanation, never the question itself or who asked, though the SQL and the explanation can repeat words from the question. The full list of what the site keeps is on [the API page](/api#what-is-stored). The numbers in the footer come from /api/stats. The CDN keeps its answer for {stats_cache_seconds} seconds and may serve it for {stats_stale_seconds} more while it fetches a fresh one, so the footer can be up to that far behind. That is fine for a counter.

## Performance

Nothing heavy loads until you ask for it. sql.js and the database only download once you click or tab into the Ask box or the console, so the first visit stays fast, even on a phone. The cost is that the database may still be loading when the model answers, so your first question can take a moment longer, which is why the Ask box shows its status the second you click.

Fast is a claim, so here are the numbers. {lighthouse_tool} on {lighthouse_date}, mobile preset, median of five runs in headless Chrome, on the live site: the home page scores {home_performance} for performance, {home_accessibility} for accessibility, {home_best_practices} for best practices and {home_seo} for SEO, with a layout shift of {home_cls}. This page scores {works_performance}, {works_accessibility}, {works_best_practices} and {works_seo} in the same order, with a layout shift of {works_cls}. The Uraz Hoops case study, the third page measured, scores {case_study_performance}, {case_study_accessibility}, {case_study_best_practices} and {case_study_seo}.

## What broke

My eval replays {eval_questions} recorded questions on every push. One of them, "What is Alex studying and where?", had been failing since the first recording, and CI stayed green the whole time, because the replay only failed when a recording went stale, not when an answer was wrong. A test that cannot fail is not testing anything. When I dug in, there were two causes. My school only existed inside a sentence, so no query could return it, and the model read "where" as the city, because my own worked example taught it that. My first fix accepted the model's reading: I changed the expectation to the city and a course, added a school fact and a separate question that asks for the school outright, and changed the replay so a wrong answer now fails CI. [About 37 hours later](https://github.com/AlexKachur98/alexkachur.com/compare/483763f...660f339) I reversed the first part. Someone asking where I study wants the school, so the test had been right and the prompt wrong. I gave every fact a one-line description the model sees, added a worked example for questions about studying, and put the school back in the expectation. If I started again, I would write the eval expectations and the data model together.

The database file was cached by browsers for a long time, but its address never changed. So after a deploy, a returning visitor could keep querying the old database without knowing it. I caught it before it hit anyone. Now the address carries a fingerprint of the file's contents: new data gets a new address and the browser fetches it, and unchanged data stays cached. The readable dump's link was the exception: it went out at the fixed address for [about nine hours](https://github.com/AlexKachur98/alexkachur.com/compare/ff8e177...80b3ab9) on 2026-09-22, on the vercel.app deployment, four hours before the domain was connected.

## What I left out on purpose

My first portfolio was over the top with animations and decorations. I thought the wow factor was what mattered. After researching what employers and senior developers actually look for, I realized it is all about function: showing what I can build. So this one has nothing that animates on its own, no glow and no decoration that does not do a job.
