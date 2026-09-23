# Evals

Measures how well Pi answers RFC research questions in two arms. The 15-task baseline remains the default; an opt-in token-exchange cohort reproduces questions actually sent to the older RFC MCP during Clerk's token-exchange work.

| Arm       | Code | Pi extensions                                                  |
| --------- | ---- | -------------------------------------------------------------- |
| `web`     | W    | pi-web-access (pinned in `package.json`)                       |
| `web-rfc` | WR   | pi-web-access plus this checkout's `packages/rfc-pi` extension |

Because `web-rfc` loads the extension and CLI from this checkout, a run measures whatever the working tree contains. Change a prompt, skill, retrieval policy, or output format, then run the suite and compare against the baseline.

## Vocabulary

Terms follow Anthropic's [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents):

- **Task**: one prompt plus its answer key, in `tasks/<id>/`.
- **Claim**: one numbered item in a task's `key.md`. Tasks get partial credit per claim.
- **Trial**: one attempt at a task by one arm, in a fresh Pi process with an empty working directory.
- **Transcript**: the Pi session JSONL for a trial.
- **Grader**: an isolated judge call per claim, plus human overrides.

## Running

```sh
bun run eval run                          # both arms, 15 baseline tasks, defaults from config.ts
bun run eval run --cohort token-exchange  # six recorded token-exchange queries
bun run eval run --tasks q1,q5 --trials 1 # quick smoke run
bun run eval run --resume latest          # continue an interrupted run with its recorded settings
bun run eval grade latest --regrade       # re-grade after editing a key or the judge
bun run eval report --open                # rebuild the dashboard of every run and open it
bun run eval answers latest q10 --calls   # read every trial's answer and tool calls
bun run eval promote <run>                # make a run the new baseline
```

Requirements: `bun install`, Pi auth for the configured provider (`openai-codex` by default), pi-web-access configuration in `~/.pi/agent/web-search.json`, and the rfc CLI's TypeSafe key (`rfc auth login`) for the `web-rfc` arm.

A full default run is 60 trials (15 tasks × 2 arms × 2 trials) plus about 190 judge calls. The committed baseline cost about $3.60 in agent calls, and judging it cost about $1.30. The six-task token-exchange cohort is 24 trials at the same defaults; it has no committed baseline yet. `--cohort` and `--tasks` are mutually exclusive, and resumed runs always use their recorded task list.

Each run writes to `results/<run-id>/` (git-ignored):

```
run.json                       harness, model, thinking, git sha, Pi and pi-web-access versions
<arm>/<task>/t<N>/session/     Pi session JSONL (the transcript)
<arm>/<task>/t<N>/trial.json   status, metrics, extracted answer
<arm>/<task>/t<N>/grade.json   per-claim verdicts and reasons
overrides.json                 optional human verdicts (see below)
summary.json, report.html      this run alone
```

`results/index.html` is the dashboard: every complete run plus the committed baseline, with a run selector labelled by harness, model, and thinking level (`?run=<id>` selects one, `?prompts=` filters tasks). Every `run`, `grade`, and `report` rebuilds it.

## Metrics

Measured from the transcript up to the answer, which is the first assistant text after the last tool result. pi-web-access can inject a "content ready" message after the agent answers; the extra turn it triggers is not counted.

- **Wall time**: seconds from the prompt to the answer.
- **Tool calls**: tool results before the answer.
- **Tool output**: UTF-8 KB of tool-result text placed in the agent's context.
- **Cost**: model cost reported by Pi, plus the TypeSafe input charge each `rfc_*` result reports.
- **Claims correct**: judge verdicts after overrides.

## Grading

`src/judge.ts` makes one headless Pi call per claim, with no tools. The call sees the prompt, the full `key.md`, the claim to grade, and the answer, and it must return `{"verdict": "correct" | "incorrect" | "unknown", "reason": "..."}`. A reply that doesn't parse is retried once, then recorded as `unknown`. `unknown` counts as not correct and shows as `?` in the report's table.

When the judge is wrong after you read the transcript, add an override to the run's `overrides.json`:

```json
{ "web-rfc/q10/t1/2": { "verdict": "correct", "note": "RFC 7515 §5.2 is an accepted alternate" } }
```

Then run `bun run eval report <run>`. If the key itself was missing an acceptable alternate, fix `key.md` instead and mark the addition _(Added during grading)_.

Calibration: the baseline was graded by hand. Over those 60 transcripts the judge matched the hand totals after two rules were added: require only what the question asked for, and accept any citation for currency or obsoletion claims. A third rule accepts a direct parent or subsection of an accepted section (§2.2 for §2.2.1).

## Recorded token-exchange queries

These prompts adapt the `question` plus named `rfc` fields of real MCP research calls into standalone user-facing prompts. They are **agent-issued tool questions**, not verbatim end-user messages. Session IDs below are from the redacted `claude-sessions` index for `clerk_go`; `te4` is recorded in the workspace's `lean/RFC_EVIDENCE.md` (E10). The historical status is provenance, **not** a grading oracle: all keyed facts and line references come from saved canonical RFC Editor text. The user's direct question about `subjectToken.OauthApplicationID` in session `c311b386-b04f-4a5f-a5b0-a20f1753156e` was not made an eval task because answering whether Clerk's implementation diverges requires the Go source, which an empty-directory RFC trial does not have.

| Task  | Historical source                                               | Historical status | Test focus                           |
| ----- | --------------------------------------------------------------- | ----------------- | ------------------------------------ |
| `te1` | `f9d89f8d-6b99-421c-8ccd-fa497b44dfcd`, 2026-09-21              | `needs_review`    | required `issued_token_type`         |
| `te2` | `a2719354e60971b83`, 2026-09-21                                 | `needs_review`    | `invalid_target` is SHOULD, not MUST |
| `te3` | `0d8bb205-49fe-45f9-9002-8b81a98a69ed`, 2026-09-21              | `needs_review`    | URI syntax for `resource`            |
| `te4` | `token-exchange-workspace/lean/RFC_EVIDENCE.md` E10, 2026-09-23 | `needs_review`    | nested `act` access control          |
| `te5` | `5785f14f-ccd5-42d1-b74b-bc89de9f6eb6`, 2026-09-21              | `needs_review`    | required JWT access token claims     |
| `te6` | `0d8bb205-49fe-45f9-9002-8b81a98a69ed`, 2026-09-21              | `needs_review`    | optional `protected_resources`       |

The old combined token-error query in session `f9d89f8d-6b99-421c-8ccd-fa497b44dfcd` returned `needs_split`, while the individual questions did not. The cohort keeps the real wording of `te2` (including its misleading “must”) to test whether an answer corrects the premise. Other questions are restricted to facts an RFC-only trial can answer. An empty `factors` list indicates a straightforward named-RFC lookup; it still gets the report's minimum difficulty level.

## Adding a task

1. Create `tasks/<id>/` with `prompt.md`, `key.md`, and `task.json` (`title`, `label`, `factors`). Baseline ids are `qN`; recorded token-exchange ids are `teN`. Update the cohort selector if introducing another cohort.
2. Read every fact in `key.md` from the canonical `https://www.rfc-editor.org/rfc/rfcNNNN.txt`, never from memory. Save the text and its `.json` metadata in `rfc-text/`, and cite line numbers as `L123`.
3. Write each claim as a top-level `N.` item. Continuation lines are indented. A non-indented paragraph after the claims is a note that applies to every claim.
4. `factors` are retrieval-difficulty ids, weighted in `report/template.html` (`FACTOR`): `rfcs2`, `rfcs3`, `currency`, `compare`, `noNumber`, `large`, `appendix`, `alias`.
5. Update the cohort assertions and claim counts in `test/tasks.test.ts`. For a recorded-query cohort, document the source and distinguish a tool-issued question from a user's own words.

## Baseline

`baseline/summary.json` holds the 15-task bench run of 2026-09-22 (web at 47/47 and 47/47, web-rfc at 45/47 and 46/47, all hand-graded). Those trials were driven through interactive Pi 0.80.3, before the headless runner existed. Use `promote` to replace the baseline with a headless run once one has been reviewed.
