# q3 — Encrypted DNS

1. DNS over TLS default port: **853/TCP** — **RFC 7858 §3.1** (Session Initiation).
2. DNS over HTTPS: **no fixed default URI Template**. The DoH client is
   _configured_ with a URI Template [RFC6570], out of band — **RFC 8484 §3**
   (Selection of DoH Server). An answer asserting a default template such as
   `/dns-query{?dns}` as normative is wrong; that string appears only in §4.1.1
   examples.
3. EDNS(0) "Padding" option: **RFC 7830 §3**, OPTION-CODE **12**.
4. Padding-length recommendations: **RFC 8467 §4.1** (Recommended Strategy:
   Block-Length Padding) — clients SHOULD pad queries to a multiple of **128**
   octets, servers to a multiple of **468** octets.
