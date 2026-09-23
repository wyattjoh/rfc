# te4 — nested actor access control

1. The consumer MUST consider only the token's top-level claims and the party identified as the current actor by the `act` claim for access control — **RFC 8693 §4.1**, L722–L724.
2. Prior actors in nested `act` claims are informational only and must not be considered in access control decisions — **RFC 8693 §4.1**, L724–L726.
