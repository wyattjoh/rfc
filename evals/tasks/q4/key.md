# q4 — Content-Length plus Transfer-Encoding

1. Rule: Transfer-Encoding overrides Content-Length; such a message might be
   request smuggling / response splitting and **ought to be handled as an
   error**; an intermediary that chooses to forward it MUST first remove the
   Content-Length field and process the Transfer-Encoding — **RFC 9112 §6.3**
   (Message Body Length), item 3.
2. Obsoletes **RFC 7230** (§3.3.3 carried the same rule).
3. Did the requirement change? **The override rule itself did not; the
   surrounding obligations were tightened.** Both accept as fully correct:
   - 7230: "A **sender** MUST remove the received Content-Length field prior to
     forwarding such a message downstream."
   - 9112: "An **intermediary that chooses to forward** the message MUST first
     remove the received Content-Length field **and process the
     Transfer-Encoding** prior to forwarding the message downstream."
   - 9112 §6.1 adds a rule absent from 7230: a server MAY reject such a request
     or process it per the Transfer-Encoding alone, but **MUST close the
     connection** after responding.

   Score "unchanged" as correct. Score "changed" as correct only if the answer
   names the sender→intermediary rewording or the new §6.1 close-connection
   duty. Score as wrong any claim that 9112 reversed the override direction or
   newly made the combination illegal.
