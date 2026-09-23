# q14 — ALPN for HTTP/2 and HTTP/3 (RFC 9113, RFC 9114)

1. **`h2`** — **RFC 9113 §3.1** (L338–352; 0x68 0x32); §3.2 (L364) also accepted.
   Citing RFC 7540 as the defining RFC is wrong.
2. **`h3`** — **RFC 9114 §3.1** (L361–362); §3.2 (L422) also accepted. _(Added during
   grading)_ §11.1 (L2237–2247, ALPN registration: "The \"h3\" string identifies
   HTTP/3", 0x68 0x33) is also accepted.
3. RFC 9113 obsoletes **RFC 7540** (L7: `Obsoletes: 7540, 8740`; naming 8740
   too is fine, naming only 8740 is wrong).
