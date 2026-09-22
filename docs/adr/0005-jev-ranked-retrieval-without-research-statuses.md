# Jev-ranked retrieval without research statuses

**Status:** accepted

Supersedes [ADR 0004](./0004-gate-automatic-answers-on-a-reviewed-calibration.md).

The RFC tool does one job: retrieval and relevance judgment. It finds the RFCs that answer each caller question and returns the exact paragraphs that do; the calling model does the reasoning, writes the answer, and decides how to split a request into questions. The engine no longer assigns research statuses, gates automatic answers on a calibration, or judges whether a question is atomic.

## Context

A bench against ordinary web search showed the tool barely beat it, and most of its cost was self-inflicted. The atomicity gate returned `needs_split` for ordinary questions, forcing extra round trips. Lexical shortlisting over 4,000-character source blocks often missed the section that actually defined the term. Results ran to 5–15 KB, mostly quotations the caller did not need. The five research statuses (`answered`, `partial`, `unsupported`, `needs_review`, `needs_split`) made callers hedge correct answers and re-research valid results to chase a better status. Rewording the instructions only moved these problems around; the contract itself caused them.

## Decision

One tool, `rfc_research`, takes `questions` (one to four) plus `rfcs` and/or `searchTerms` (one to four each). Named RFCs, their current successors from RFC currency traversal, and Datatracker topic hits form one candidate pool of at most 32 RFCs. Retrieval runs three Jev stages:

1. **Rank.** One request ranks the pool for every question: a Choice over the candidates plus `none`, and a per-pair Noul contrasting "defines or normatively specifies" with "only on a related topic". Each question keeps at most two RFCs with a Noul of at least 0.3, plus the requested or current partner of a kept RFC when that partner also clears the floor, so a successor never silently replaces the RFC the caller named. The stage is skipped when the pool holds a single RFC.
2. **Sections.** One request per kept RFC picks sections: a Choice over its table of contents with 120-character previews, keeping sections until 0.8 of the probability mass is covered, at most three. An RFC with more than 250 sections uses a two-level choice: the top three chapters, whose previews list their subsection titles, then those chapters' subsections.
3. **Paragraphs.** One request per kept RFC picks paragraphs within the chosen sections: a Choice, an `exists` Noul, and a per-paragraph verdict Choice over `supports`, `partial`, `says_nothing`, and `contradicts`. Paragraphs are kept until 0.8 of the mass, at most three. An `exists` below 0.35 drops that RFC for that question.

Passages are exact paragraph slices of the canonical RFC Editor text with UTF-8 byte offsets and never include page furniture. The result lists, per question, `found`, the `searched` RFCs, and ranked hits carrying `role` (`requested`, `current`, or `discovered`), `relevance`, `verdict`, and passages; an optional `currency` report covers each named RFC with its `requested` identifier, `current` successors, relationship `paths`, and a `complete` flag. Every public envelope moves to schema version 3; authentication and credential envelopes stay at version 2. Optional full-text topic search is unchanged, and default discovery remains Datatracker only. Citation verification is unchanged apart from the schema version.

The atomicity gate, lexical shortlist, research statuses, `precision-v2` calibration and automatic-answer activation, and the live evaluation runner are removed.

## Consequences

- A typical request is one call and returns a few exact paragraphs instead of a large evidence bundle, so callers spend fewer calls and far less context.
- The caller owns reasoning. The tool reports what the RFC text says and how each passage bears on the question; it never declares a question answered.
- The 0.3, 0.8, 0.35, and per-stage limits are uncalibrated working values, not certified thresholds. No automatic answer gate exists to protect against a poorly chosen one.
- Recall now depends on Jev's section and paragraph choices rather than on lexical overlap. A section Jev does not pick is never read.
- Without a status to downgrade, an unresolved successor or a traversal cut off by its bound is reported only as `currency[].complete: false`. The caller must notice it and qualify any claim that an RFC is current.
- An RFC with more than 250 sections needs two sequential section requests, adding latency for the largest documents.
- Currency no longer gates a status. A bounded or unresolved traversal is reported only through `currency[].complete` and the retrieval trace, so callers must read it before treating the listed successors as exhaustive.
