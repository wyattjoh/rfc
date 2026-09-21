# Gate automatic answers on a reviewed calibration

**Status:** accepted

The engine may return `answered` only when a locally present calibration report proves a passing release gate _and_ a human has recorded an accepting release decision _and_ automatic answering is explicitly enabled. Any weaker artifact — rejected, pending, missing, stale, expired, or tampered — fails closed to `needs_review`. Changing the model pin requires recertification on the same terms. The alternative, treating a passing gate as sufficient on its own, would let a calibration that nobody read switch on the one behaviour a precision-first tool cannot take back.

## What a calibration measures

The committed `@wyattjoh/rfc-core` corpus covers known-RFC research across HTTP, TLS, OAuth and DNS, ordered multi-term topic research, candidate fan-out, empty discovery, currency changes, every answer status, and every citation verdict. Its deterministic retrieval cases drive current RFCs, update chains, cycle safety, relationship bounds, a saturated 32-candidate eight-source topic fan-out, source-cache misses and zero-network hits, `304` validator revalidation, changed-source replacement, corrupt-entry repair, and typed metadata and stale-source failures through the public `RfcClient` seam. A missing or failed retrieval observation closes the gate by itself.

Every expected semantic outcome is exact while `precision-v2` remains uncalibrated: no bounded alternative and no prior release outcome is carried forward as certified. `modern-normative-requirement` is the answered positive control. Deterministic tests inject the Datatracker, RFC Editor, DecisionModel, clock and credential boundaries, so none of this needs a credential, the OS credential manager, or the network.

## Running one

```sh
rfc auth status
bun run evaluate:live
```

The evaluator starts from the typed `jev-latest` alias, exercises the ordinary live discovery and read-through source-cache paths for every live case, then times three sequential iterations. Citation controls carry exact committed RFC text, so they need no prefetch bypass. It writes a sanitized report to `.scratch/rfc-evaluation-report.json`: the policy snapshot, resolved model identity, corpus and policy digests, an RFC-identifier-to-source-hash manifest, retrieval-case observations and traces, cache before/after and returned-source hashes, validator behaviour, semantic probabilities, confidence, usage, stage timings, outcome rates, positive-control status, and gate failures. It never records credentials, prompts, questions beyond the committed corpus, or provider reasoning. It exits zero for a passing gate and two for a complete report that fails review, so the same command produces the artifact for either decision.

## The decision on record

The 2026-09-21 report resolved `jev-latest` exclusively to the pinned `jev-1.13.0` and passed supported-claim precision at 100%, citation safety with zero unsafe acceptances, every deterministic retrieval case, every retrieval bound, and topic warm-cache p95 at 719 ms against a 3,000 ms target. Topic observations stayed within eight Datatracker calls, 29 upstream rows, 21 merged and semantic candidates, and two selected sources, giving 22 questions in the largest native bulk request.

It was **rejected**. Observed outcomes left their committed sets, the answered positive control returned `needs_review` in all three repetitions, and known-RFC warm-cache p95 was 3,534 ms against the strict 2,000 ms target. The release owner approved recording report digest `3ce4d88e7ee0450562679342fc3f9e4a27b545ca5a2b0d0dbb9f8955efe400f1` as rejected. That decision is committed in `packages/rfc-core/src/precision-v2-release-decision.ts`, and the compiled attestation matches its digest, release identity, review time, expiry, and three gate failures.

Thresholds were left unchanged. Moving an acceptance threshold to make a gate pass is how a precision-first tool stops being one, so a later activation needs a new passing report, explicit review, a compiled accepting attestation, and explicit runtime enablement.
