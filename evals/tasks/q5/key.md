# q5 — HTTP 103 Early Hints

1. Defined by **RFC 8297**, **§2** ("HTTP Status Code 103: Early Hints").
2. Category: **Experimental** (December 2017). An answer calling it Standards
   Track is wrong.
3. Client MUST NOT: interpret the 103 response header fields as if they applied
   to the informational response itself (e.g. as metadata about the 103
   response). Also acceptable as the MUST NOT: evaluation of those header fields
   MUST NOT affect how the final response is processed, aside from performance
   optimizations. Either of those two, quoted or paraphrased from §2, counts.

Score as wrong: claiming RFC 9110 defines 103 (it does not — 9110 defines the
1xx class generally, 103 is RFC 8297), or claiming a SHOULD NOT where the text
says MUST NOT.
