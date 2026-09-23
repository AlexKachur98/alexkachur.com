---
order: 2
name: Think Smarter Insurance review funnel
kind: client
summary: A single-file review page for an Ontario insurance brokerage that routes happy customers to Google and unhappy ones to the owner, with a compliance toggle built in.
card: A one-file review page for an Ontario brokerage, with a compliance toggle I argued for. Client work, 2026.
role: design, build, compliance research, delivery
year_start: 2026
year_end: 2026
client_name: Think Smarter Insurance
live_url: https://think-smarter-review.pages.dev
repo_url: null
has_live_demo: 1
uses_llm: 0
llm_job: null
paid: 0
technologies: [html, css, javascript, cloudflare-pages, web3forms]
screenshots:
  - src: ../../assets/work/think-smarter-review-funnel/think-smarter-1.jpg
    alt: The review page, a navy card with the Think Smarter Insurance logo, the question How did we do? and five empty stars, above a From our clients section
    # TODO: write the caption.
  - src: ../../assets/work/think-smarter-review-funnel/think-smarter-2.jpg
    alt: The private feedback form, Tell us what went wrong, with fields for what happened, name and email, and a Send privately button
    # TODO: write the caption.
---

## The problem

The brokerage was using a generic review funnel from their marketing platform. It did not match their brand and the owner could not change anything herself. She wanted a page that asked customers for a rating, sent the good ones to Google, and sent the rest to her privately.

## What I built

One HTML file with no build step, so it can be hosted anywhere and changed by anyone who can edit text. The landing step is a star selector. Four and five stars go to the Google review link. One to three stars open a private feedback form that emails the owner through Web3Forms. Below that, a wall of curated reviews shown with initials only. There is a hidden owner admin panel at a hash route for the settings she needs. I restyled it to her real brand after noticing my first version used the wrong colours: navy #002854, her logo, Raleway and Fira Sans, all self-hosted.

## Decisions

- Cloudflare Pages instead of Vercel, because Vercel's free tier does not allow commercial use and this is a business.
- Web3Forms instead of a mailto link, because mailto is unreliable inside social-media browsers and the form gives 250 free submissions a month.
- A compliance toggle. While researching, I found that routing customers by star rating ("review gating") is against Google's policy and is named as a concern under the Competition Act and RIBO Guidance 006 for Ontario brokers. I documented the risk for the client and built a switch so the page can run an ask-everyone flow without a developer.

## What went wrong or what I would change

My first design used a green and gold theme I liked. It did not match the client's site at all, and I caught it late. Now I collect the brand assets before I design anything.

## Outcome

The demo is live at think-smarter-review.pages.dev. Go-live on the client's domain is waiting on her next steps. <!-- TODO: update this when she confirms. -->

## Credits

Built alone for the client.
