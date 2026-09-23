# te5 — required JWT access token claims

1. `iss`, `exp`, `aud`, and `sub` are REQUIRED — **RFC 9068 §2.2**, L182–L194.
2. `client_id`, `iat`, and `jti` are also REQUIRED — **RFC 9068 §2.2**, L206–L211.

Note: Do not present `scope` as unconditionally REQUIRED; §2.2.3 makes it a SHOULD when an authorization request includes a scope parameter (L269–L272).
