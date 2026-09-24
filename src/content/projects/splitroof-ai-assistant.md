---
order: 1
name: SplitRoof AI assistant
kind: team
summary: An assistant inside a shared-household expense app that answers questions from the household's real data and never does the math itself.
card: A read-only assistant that answers "who owes what this month" from a household's own data. Group project, 2026, I own the AI end to end.
role: AI integration, documentation, schedule
team: group project, COMP 231 Software Development Project, Fall 2026
year_start: 2026
year_end: null
client_name: null
live_url: null
repo_url: https://github.com/AlexKachur98/splitroof-assistant-spike
# TODO: add the main repo link if the team agrees.
has_live_demo: 0
uses_llm: 1
llm_job: answers questions about a household's shared expenses by calling typed tools; never does the arithmetic itself.
paid: 0
highlights:
  - 'Own the assistant for a shared-household expense app: a read-only agent that answers "who owes what this month" from the household''s own data through three typed tools (getBalance, getCategorySpend, getBudgetStatus). The model never does the arithmetic itself.'
  - "Built the spike first: three tool functions with {splitroof_tool_tests} passing Jest tests before wiring in the model, then {splitroof_model_tests} tests against the live model. Also maintain the project documentation and keep the team on schedule."
technologies: [react, node-js, express, firebase, anthropic-api, jest]
screenshots:
  - src: ../../assets/work/splitroof-ai-assistant/splitroof-1.png
    alt: A terminal in VS Code after npm test in splitroof-assistant-spike, with tools.test.js and assistant.test.js passing, 17 tests in total
    # TODO: write the caption.
  - src: ../../assets/work/splitroof-ai-assistant/splitroof-2.png
    alt: VS Code with src/assistant.js open on the system prompt, which tells the model that every number must come from a tool result
    # TODO: write the caption.
---

## The problem

People who share a home keep asking the same questions: who paid for what, who owes whom, what did we spend on groceries this month. The app already has the answers in its data. Typing them into a chat should just work, without the model making up numbers.

## What I built

A read-only assistant. The model, Claude Haiku 4.5 through the Anthropic API, gets a small set of typed tool functions (getBalance, getCategorySpend and getBudgetStatus) and can only call those. The functions run the queries and return exact figures. The model turns the result into a sentence. It cannot write to the database and it never adds anything up on its own.

## Decisions

- Tools before model. I built and tested the three functions with 12 Jest tests before the model was wired in, so the behaviour is verified without an LLM in the loop. Five more tests then run the assistant against the live model.
- Read-only by design. The assistant has no write path at all, so a bad prompt can at worst produce a wrong sentence, never a wrong balance.
- One narrow job. This comes from an earlier school project, a Family Feud game where an LLM judged answers ("storm" scored for "rain"). It worked best when the model had one clear, testable task, and that is how I scope AI features now.

## What went wrong or what I would change

<!-- TODO: fill this in after the first iteration ships. -->

## Outcome

In progress. <!-- TODO: add the demo date, what the team shipped, and anything measurable, such as questions answered correctly in testing and response time. -->

## Credits

Group project. <!-- TODO: add the team size and names, if they agree. --> I own the AI integration, keep the project documentation, and keep us on schedule.
