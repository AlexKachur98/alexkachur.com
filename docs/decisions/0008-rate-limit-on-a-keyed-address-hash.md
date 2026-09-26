# 8. Rate limit on a keyed address hash

Date: 2026-09-24

## Status

Accepted

## Context

/api/ask has limited each address to 10 questions a minute, in a sliding window, since the endpoint landed ([8c7c818]). That first version keyed Redis with the address itself and left @upstash/ratelimit's in-memory cache on, so an address sat in Redis for about two minutes, and one over the limit could also stay in a function's memory. I did not want to store anyone's address, even for two minutes.

## Decision

The limiter's key is an HMAC-SHA-256 of the address, keyed with ASK_RATE_LIMIT_SECRET ([cf2b17f]). A plain hash is not enough, because every IPv4 address can be hashed in turn and matched back. The in-memory cache and the library's analytics are off, so that key is all the site writes to Redis about an address. Without the secret, /api/ask and /api/questions answer 503 before they touch Redis. The limiter also waits for a slow Redis now ([032ab9c]), where the library's default lets a request through after five seconds.

## Consequences

Every check, allowed or not, is a round trip to Redis, and a slow Redis holds the request instead of the check being skipped. Rotating the secret resets everyone's window and voids every send token already issued, since those are derived from it. Unsetting it closes both endpoints. Visitors who share one public address, behind an office network or a carrier's NAT, share one limit.

[8c7c818]: https://github.com/AlexKachur98/alexkachur.com/commit/8c7c818
[cf2b17f]: https://github.com/AlexKachur98/alexkachur.com/commit/cf2b17f
[032ab9c]: https://github.com/AlexKachur98/alexkachur.com/commit/032ab9c
