# te2 — unacceptable exchange target

1. `invalid_target` is a SHOULD, not a MUST, when the authorization server is unwilling or unable to issue a token for a target service indicated by `resource` or `audience` — **RFC 8693 §2.2.2**, L500–L503.
2. Other error codes may also be used as appropriate — **RFC 8693 §2.2.2**, L505–L509.

Note: A response claiming `invalid_target` is mandatory for an unacceptable target is wrong. The question's “when must” wording was used in an actual tool call; the key deliberately corrects that premise.
