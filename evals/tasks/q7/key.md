# q7 — TLS 1.3 currency + appendix (RFC 9846)

1. Current TLS 1.3 definition: **RFC 9846** (July 2026, Standards Track).
   rfc9846.json `obsoleted_by` is empty. An answer naming RFC 8446 as current is
   wrong.
2. It obsoletes **RFC 8446** (L7: `Obsoletes: 5077, 5246, 6961, 7627, 8422, 8446`;
   rfc8446.json `obsoleted_by: ["RFC9846"]`).
3. MUST implement **TLS_AES_128_GCM_SHA256** — **RFC 9846 §9.1** (L4535–4543).
4. Code point **{0x13,0x01}** — **RFC 9846 Appendix B.4** (L5988, table L6018).

Claims 3–4 cited to RFC 8446 (§9.1 L5688, B.4 L7437, identical content) count
only if the answer also identifies RFC 9846 as current; otherwise wrong
(silent substitution of the obsoleted RFC).
