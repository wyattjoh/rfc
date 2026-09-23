# q2 — Retry-After and 429

1. Current definition: **RFC 9110 §10.2.3**.
2. Obsoletes **RFC 7231** for that definition (7231 defined it in §7.1.3).
   RFC 9110's `Obsoletes:` line is 2818, 7230, 7231, 7232, 7233, 7235.
3. Two value formats: `Retry-After = HTTP-date / delay-seconds` (RFC 9110 §10.2.3).
4. 429 Too Many Requests: **RFC 6585 §4**. RFC 6585 is _not_ obsoleted by 9110,
   and 9110 does not define 429 at all (the string "429" does not appear in it).
