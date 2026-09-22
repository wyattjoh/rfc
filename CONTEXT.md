# RFC Evidence Engine

The RFC Evidence Engine finds the published IETF RFCs that answer a caller's questions and returns the exact paragraphs that do, so the caller can reason over authoritative text and compose its own answer.

## Research language

**Question**:
One fact the caller needs, answered independently against the shared candidate pool. The caller decides how to split a request into questions; the engine never judges or splits them.
_Avoid_: Atomic question, compound question

**RFC discovery**:
The bounded identification of published RFCs matching caller-supplied search terms from current authoritative metadata.
_Avoid_: Index, registry

**RFC source cache**:
The local collection of exact source text retained only for RFCs that have been individually requested.
_Avoid_: Corpus mirror

**RFC currency**:
The bounded, deterministic traversal from a named RFC through update and obsoletion relationships to its current successors.
_Avoid_: Replacement, latest-document substitution

**Candidate pool**:
The bounded set of RFCs one research request considers: the named RFCs, their current successors, and RFC discovery hits.
_Avoid_: Search results, corpus

**Role**:
How an RFC entered the candidate pool: `requested` when the caller named it, `current` when it is the current successor of a named RFC, or `discovered` when topic search found it.
_Avoid_: Context, source alias

**Relevance**:
The ranking stage's probability that an RFC defines or normatively specifies what a question asks, rather than only covering a related topic. It is absent when the pool held a single RFC and ranking was skipped.
_Avoid_: Confidence, score

**Hit**:
One RFC judged relevant to a question, returned with its role, relevance, verdict, and passages.
_Avoid_: Match, result

**Passage**:
An exact paragraph of canonical RFC text, never including page furniture, returned with its section, verdict, and UTF-8 byte range in the hashed source.
_Avoid_: Chunk, snippet, generated quote

**Verdict**:
How a passage or hit bears on a question: `supports`, `partial`, `says_nothing`, or `contradicts`.
_Avoid_: Status, answer relation

**Citation verdict**:
The result of checking a claim against an exact RFC quotation: verified, unsupported, contradicted, or fabricated.
_Avoid_: Citation confidence

**Retrieval policy**:
The named, versioned set of working limits and floors that bound ranking, section selection, and paragraph selection.
_Avoid_: Per-request threshold, calibration
