# q15 — Unknown vs disallowed method (RFC 9110, >250 sections)

1. Unrecognized / not implemented method: origin server **SHOULD respond 501
   (Not Implemented)** — **RFC 9110 §9.1** (L3799–3801); §15.6.2 (L7869) also
   accepted.
2. Recognized and implemented but not allowed: **SHOULD respond 405 (Method Not
   Allowed)** — **§9.1** (L3801–3803); §15.5.6 (L7601) also accepted.
3. A 405 response **MUST include an Allow** header field — **§15.5.6**
   (L7605–7607) or §10.2.1 (L4724).
