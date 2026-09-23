# q10 — JWT exp + Unsecured JWS (RFC 7519, RFC 7518)

1. `exp` identifies the expiration time on or after which the JWT MUST NOT be
   accepted; value MUST be a number containing a **NumericDate** —
   **RFC 7519 §4.1.4** (L497–513).
2. `alg: none` is an **Unsecured JWS**; implementations MUST NOT accept it as
   valid unless the application specifies it is acceptable for that object
   (MUST NOT accept by default); signature must be the empty octet sequence —
   **RFC 7518 §3.6** (L593–607). Either the "not by default / application must
   allow it" rule or the empty-signature verification counts, but the name
   "Unsecured JWS" is required. _(Added during grading)_ RFC 7515 defines the
   term (§2, L311–313; example in Appendix A.5, L2665) and §5.2 (L940–943) says
   a JWS whose algorithm is not acceptable to the application SHOULD be
   considered invalid; citing those instead of RFC 7518 §3.6 is accepted.
