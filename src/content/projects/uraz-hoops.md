---
order: 3
name: Uraz Hoops
kind: client
summary: A one-page marketing site for a basketball training business, built to be handed off to an owner who is not a developer.
card: A one-page site for a basketball training business, handed off so the owner can update it himself. Client work, 2026. Live at urazhoops.com.
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
technologies: [html, css, javascript, formsubmit, vercel]
screenshots:
  - src: ../../assets/work/uraz-hoops/uraz-hoops-1.jpg
    alt: The Uraz Hoops home page, with the headline Real coaching. Real reps. Real improvement. next to a photo of a coach and a young player on an outdoor court
    caption: The home page leads with the promise and a coaching photo, so a parent knows what this is at a glance.
  - src: ../../assets/work/uraz-hoops/uraz-hoops-2.jpg
    alt: The pricing section, two columns for outdoor and indoor training listing one-on-one, small group and big group rates
    caption: Prices in one place, outdoor and indoor side by side, and the handoff guide shows the owner how to change them.
  - src: ../../assets/work/uraz-hoops/uraz-hoops-3.jpg
    alt: The reviews section, four five-star reviews from players and parents in white cards
    caption: Reviews from players and parents, because parents book on trust.
  - src: ../../assets/work/uraz-hoops/uraz-hoops-4.jpg
    alt: The booking section, phone and email contacts on the left and a Send Booking Request form on the right
    caption: Booking requests go straight to the owner's email through FormSubmit, with the phone number and email beside the form for parents who would rather call.
---

## The problem

A basketball trainer needed a site that explains his programs, takes enquiries, and looks like something a parent would trust with a booking, and he needed to keep updating it himself afterwards.

## What I built

One page with seven sections: About, Services, Training, Pricing, Reviews, FAQ and Book Training. A booking form that emails the owner through FormSubmit, with no server behind it. A handoff document that walks the owner through every change he is likely to make.

## Decisions

- **Plain HTML, CSS and JavaScript on Vercel**, in the owner's own account. The booking form posts to FormSubmit from the browser, so the site needs no server. <!-- TODO: say why I chose plain files over a framework for this site. TODO: confirm the owner's Vercel plan. Vercel's fair use guidelines, read 2026-09-25, say "Hobby teams are restricted to non-commercial personal use only. All commercial usage of the platform requires either a Pro or Enterprise plan." Once he is confirmed on Pro, say so here. -->
- **Motion in plain CSS with a few lines of JavaScript**: sections fade in as they come into view, a strip of training types scrolls under the hero, and the ball in the hero floats, so no animation library ships and the site stays fast on phones.
- **A handoff document instead of a CMS.** The owner had a small number of things to change, and a document he can follow beats a system he has to learn.

## What went wrong or what I would change

The first draft of the handoff document had wrong pricing in it because I trusted an old reference file. Now every number I hand to a client gets checked against the live source.

## Outcome

Live at urazhoops.com. Whether the site works for the owner would show in visits and enquiries, which are his numbers, and I do not have them yet. <!-- TODO: add visits and enquiries if the owner shares them. -->

## Credits

Built alone for the client.
