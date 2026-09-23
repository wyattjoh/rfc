# q11 — IPv6 Hop-by-Hop, requested vs current (RFC 2460 → RFC 8200)

1. RFC 2460 **§4** (L343–346): the Hop-by-Hop Options header carries information
   that **must be examined and processed by every node** along the delivery
   path, including source and destination. _(Added during grading)_ §4.3
   (L580–583, "must be examined by every node") is also accepted.
2. Obsoleted by **RFC 8200** (L10; Internet Standard).
3. **Changed**: RFC 8200 **§4** (L429–441) — HBH "may be examined or processed";
   NOTE: nodes are now expected to examine/process it **only if explicitly
   configured to do so**. "Unchanged" is wrong. _(Added during grading)_ §4.3
   (L692–695, "may be examined and processed by every node") and Appendix B
   (L2150, "Changed requirement for the Hop-by-Hop Options header to a
   \"may\"") are also accepted.
4. Minimum link MTU **1280 octets, unchanged** — RFC 2460 §5 (L1322) and
   RFC 8200 §5 (L1385).
