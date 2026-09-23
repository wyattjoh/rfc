# q1 — OAuth 2.0 token exchange (RFC 8693)

1. `grant_type` MUST be `urn:ietf:params:oauth:grant-type:token-exchange` — **RFC 8693 §2.1** (Request).
2. `issued_token_type` is a REQUIRED identifier (as described in §3) for the
   representation / token type of the issued security token — **RFC 8693 §2.2.1**
   (Successful Response).

Note: §2.2.1 also observes that `token_type: "Bearer"` with
`issued_token_type` of `access_token` are distinct things; an answer that
conflates `issued_token_type` with `token_type` is wrong.
