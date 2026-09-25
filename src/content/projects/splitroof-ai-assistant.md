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
# The project has no interface to show yet, so its row on the home page shows the flow drawing.
row_image:
  diagram: splitroof-flow
  alt: "How the SplitRoof assistant answers: a question goes to Claude Haiku 4.5, which can only call three read-only tools on the household's data and then words the answer."
screenshots:
  - src: ../../assets/work/splitroof-ai-assistant/splitroof-1.png
    alt: A terminal in VS Code after npm test in splitroof-assistant-spike, with tools.test.js and assistant.test.js passing, 17 tests in total
    caption: "The spike's test run: {splitroof_tool_tests} tests on the three tools before the model was wired in, then {splitroof_model_tests} against the live model."
  - src: ../../assets/work/splitroof-ai-assistant/splitroof-2.png
    alt: VS Code with src/assistant.js open on the system prompt, which tells the model that every number must come from a tool result
    caption: "The system prompt: every number must come from a tool result, so the model words the answer but never does the math."
---

## The problem

People who share a home keep asking the same questions: who paid for what, who owes whom, what did we spend on groceries this month. The app already has the answers in its data. Typing them into a chat should just work, without the model making up numbers.

## What I built

A read-only assistant. The model, Claude Haiku 4.5 through the Anthropic API, gets a small set of typed tool functions (getBalance, getCategorySpend and getBudgetStatus) and can only call those. The functions run the queries and return exact figures. The model turns the result into a sentence. It cannot write to the database and it never adds anything up on its own.

## Decisions

- **Tools before model.** I built and tested the three functions with 12 Jest tests before the model was wired in, so the behaviour is verified without an LLM in the loop. Five more tests then run the assistant against the live model.
- **Read-only by design.** The assistant has no write path at all, so a bad prompt can at worst produce a wrong sentence, never a wrong balance.
- **One narrow job.** This comes from an earlier school project, a Family Feud game where an LLM judged answers ("storm" scored for "rain"). It worked best when the model had one clear, testable task, and that is how I scope AI features now.

## What went wrong or what I would change

Nothing has gone wrong yet, because what exists is the spike I built before the team started. I will write this section after the team's first iteration ships.

## Outcome

In progress. Demo in December 2026. <!-- TODO: add what the team shipped and anything measurable, such as questions answered correctly in testing and response time, after the demo. -->

## Credits

Group project, team of 8. I own the AI assistant end to end, and I also keep the project documentation and the schedule. The spike is all mine: I built it before the team started, because I like being ahead.
