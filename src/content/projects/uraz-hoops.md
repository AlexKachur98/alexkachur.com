---
order: 3
name: Uraz Hoops
kind: client
summary: A five-page marketing site for a basketball training business, built to be handed off to an owner who is not a developer.
card: A five-page site for a basketball training business, handed off so the owner updates it himself. Client work, 2026. Live at urazhoops.com.
role: design, build, handoff
year_start: 2026
year_end: 2026
client_name: Uraz Hoops
live_url: https://urazhoops.com
repo_url: null
has_live_demo: 1
uses_llm: 0
llm_job: null
paid: 1
featured: 0
technologies: [next-js, react, tailwind-css, framer-motion, resend, vercel]
screenshots:
  - src: ../../assets/work/uraz-hoops/uraz-hoops-1.jpg
    alt: The Uraz Hoops home page, with the headline Real coaching. Real reps. Real improvement. next to a photo of a coach and a young player on an outdoor court
    # TODO-ALEX: caption
  - src: ../../assets/work/uraz-hoops/uraz-hoops-2.jpg
    alt: The pricing section, two columns for outdoor and indoor training listing one-on-one, small group and big group rates
    # TODO-ALEX: caption
  - src: ../../assets/work/uraz-hoops/uraz-hoops-3.jpg
    alt: The reviews section, four five-star reviews from players and parents in white cards
    # TODO-ALEX: caption
  - src: ../../assets/work/uraz-hoops/uraz-hoops-4.jpg
    alt: The booking section, phone and email contacts on the left and a Send Booking Request form on the right
    # TODO-ALEX: caption
---

## The problem

A basketball trainer needed a site that explains his programs, takes enquiries, and looks like something a parent would trust with a booking, and he needed to keep updating it himself afterwards.

## What I built

Five pages. <!-- TODO-ALEX: confirm the page names --> A contact form that sends email through an API route with Resend. Content kept in simple files so text and prices can change without touching components. <!-- TODO-ALEX: confirm this is how it is structured --> A handoff document that walks the owner through every change he is likely to make.

## Decisions

- Next.js and Vercel for a site that is mostly static, because the contact form needs one server route and the owner benefits from preview deployments when he edits.
- Framer Motion kept to a few entrance transitions so the site stays fast on phones. <!-- TODO-ALEX: confirm where you used it -->
- A handoff document instead of a CMS. The owner had a small number of things to change, and a document he can follow beats a system he has to learn.

## What went wrong or what I would change

The first draft of the handoff document had wrong pricing in it because I trusted an old reference file. Now every number I hand to a client gets checked against the live source.

## Outcome

Live at urazhoops.com. <!-- TODO-ALEX: add numbers if the owner replies (visits, enquiries, whether he has updated it himself) -->

## Credits

Built alone for the client.
