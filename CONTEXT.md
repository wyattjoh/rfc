# RFC Evidence Engine

The RFC Evidence Engine turns questions about published IETF RFCs into bounded, traceable evidence that a caller can safely compose into an answer.

## Research language

**Atomic question**:
A single independently answerable question whose evidence can be judged without deciding how to split it further.
_Avoid_: Compound question, broad prompt

**Catalog**:
The local collection of published RFC metadata used to discover documents and understand update or obsoletion relationships.
_Avoid_: Index, registry

**RFC currency**:
The bounded, deterministic traversal from a requested RFC through update and obsoletion relationships to applicable current RFC contexts.
_Avoid_: Replacement, latest-document substitution

**RFC context**:
The requested or applicable current published RFC whose exact source text is researched independently for one evidence bundle.
_Avoid_: Source alias, version

**Document candidate**:
A published RFC that remains plausible evidence for an atomic question after catalog discovery.
_Avoid_: Search result, source

**Source block**:
A bounded range of authoritative RFC text that preserves enough adjacent context for evidence judgment.
_Avoid_: Chunk, snippet

**Passage candidate**:
A source block shortlisted for semantic evaluation because deterministic retrieval found vocabulary related to the atomic question.
_Avoid_: Match, hit

**Evidence passage**:
An exact quotation from an authoritative source block that is returned as evidence, together with its provenance.
_Avoid_: Generated quote, summary

**Evidence bundle**:
The versioned research result containing the status, accepted evidence passages, provenance, and bounded diagnostics for one atomic question.
_Avoid_: Answer, report

**Answer relation**:
The relationship between an evidence passage and its atomic question: direct answer, partial answer, background, contradiction, or irrelevance.
_Avoid_: Relevance score

**Citation verdict**:
The result of checking a claim against an exact RFC quotation: verified, unsupported, contradicted, or fabricated.
_Avoid_: Citation confidence

**Research status**:
The fail-closed outcome assigned to an evidence bundle: answered, partial, unsupported, needs review, or needs split.
_Avoid_: Success state

**Policy preset**:
A named, versioned set of acceptance and uncertainty rules used to turn evidence judgments into a research status.
_Avoid_: Per-request threshold
