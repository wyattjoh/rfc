# Query RFC metadata live

**Status:** accepted

The engine queries the public IETF Datatracker API for only the RFC metadata and successor relationships needed by the current request instead of materializing full-corpus metadata locally. Topic discovery uses bounded, ordered caller-supplied search terms, and its hits join named RFCs and their current successors in one bounded candidate pool that TypeSafe ranks per question, while known-RFC currency traversal remains bounded and cycle-safe; metadata, search results, and relationships are never persisted. Canonical RFC Editor text may be retained in a per-RFC HTTP cache with validators and integrity metadata, but bulk prefetch and corpus-wide refresh operations are prohibited.

This supersedes the full-corpus metadata portion of [ADR-0001](./0001-rfc-evidence-engine-boundaries.md). The public protocol moves to version 2, removes corpus-management and bulk-source surfaces, and fails closed when live metadata or stale source text cannot be retrieved or revalidated. [ADR 0005](./0005-jev-ranked-retrieval-without-research-statuses.md) later moved the public protocol to version 3.
