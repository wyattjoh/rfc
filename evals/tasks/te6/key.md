# te6 — protected resources metadata

1. Yes. `protected_resources` is an OPTIONAL authorization server metadata parameter, a JSON array of protected resource identifiers — **RFC 9728 §4**, L503–L510.
2. An authorization server MAY omit some supported resources even when using the parameter; when the set is not enumerable, it is absent — **RFC 9728 §4**, L511–L515.

Note: This is an authorization server metadata member, not the protected resource's own metadata document.
