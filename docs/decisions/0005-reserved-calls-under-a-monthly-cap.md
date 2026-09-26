# 5. Reserved calls under a monthly cap

Date: 2026-09-22

## Status

Accepted

## Context

Every question that misses the cache is a paid model call, and a public text box is easy to abuse. The limit on a month's spending had to hold when several requests arrive at once.

## Decision

Before each model call, the handler increments a monthly counter of model calls in Redis and makes the call only if the new count is within the cap, 2,000 by default ([8c7c818]). There is no gap between reading the count and raising it, and the counter holds every call made, retries and failures included. A reservation the cap refuses is taken back ([f38cab1]), so /api/stats reports calls made, not calls tried.

The counter and its expiry are written in one transaction, so a counter is never left without one ([551286c], with the storage table). The SDK's own retry is off ([2ed0925]) because it made calls the counter never saw.

Cached answers never reach this counter and are served even in a used-up month. A cap of 0 turns asking off completely, cached answers included.

## Consequences

The cap bounds the number of calls in a month, and /how-this-site-works turns that into dollars with the published prices. With the SDK retry off, a short API outage reaches the visitor as a 503 instead of being retried. The cap is an environment variable, so changing it, or turning asking off, needs a redeploy.

[8c7c818]: https://github.com/AlexKachur98/alexkachur.com/commit/8c7c818
[f38cab1]: https://github.com/AlexKachur98/alexkachur.com/commit/f38cab1
[551286c]: https://github.com/AlexKachur98/alexkachur.com/commit/551286c
[2ed0925]: https://github.com/AlexKachur98/alexkachur.com/commit/2ed0925
