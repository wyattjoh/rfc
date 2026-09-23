---
name: run-evals
description: Run, grade, and report this repo's RFC research evals, which compare Pi with web access alone (W) against web access plus this checkout's rfc extension (WR). Also adds eval tasks, records grading overrides, promotes a run to baseline, and updates default eval settings. Triggers on "/run-evals", "run the evals", "run the bench", "benchmark this change", "compare against baseline", "add an eval task", "regrade", or "change the eval defaults".
argument-hint: "[run | add-task | override | promote | defaults]"
---

# Run evals

The suite lives in `evals/`. Read `evals/README.md` for vocabulary, layout, metrics, and grading rules before doing anything else. Defaults live in `evals/config.ts`.

Everything runs through `bun run eval <command>` from the repo root. Runs are slow (a full default run takes about 15 minutes) and cost real money, so ask before starting one.

## Run and compare (default flow)

1. Read `evals/config.ts` and check `git status`. The `web-rfc` arm loads `packages/` from the working tree, so uncommitted changes there are measured too, and only then does the run id get a `-dirty` suffix. Changes outside `packages/` (including `evals/` itself) don't mark a run dirty.
2. Ask with AskUserQuestion, one call with up to four questions, the recommended option first:
   - **Scope**: the 15-task baseline (recommended), the recorded token-exchange cohort (`--cohort token-exchange`), a subset (list them), or a quick smoke (`--tasks q1,q5 --trials 1`).
   - **Trials**: the configured default, or 3+ to separate time or cost differences from noise.
   - **Arms**: both (recommended), or `web-rfc` only when the web arm is unchanged and the baseline covers it.
   - **Model**: the configured model and thinking level, or an override.
3. State the estimate before starting: trials = tasks × arms × trials. The baseline averaged about $0.06 and 30 s of agent time per trial, plus about $0.007 per judged claim. Wall time is roughly trials × 30 s ÷ concurrency.
4. Run `bun run eval run [flags]` in the background and wait for the completion notification. Don't poll. If it dies partway, continue with `--resume <run-id>`; the run keeps the model, thinking, tasks, arms, and trials recorded in its `run.json`.
5. When it finishes, open the dashboard at this run with `bun run eval report <run> --open`. Its run selector lists every complete run and the baseline by harness, model, and thinking level. Summarize against `evals/baseline/summary.json`: claims correct, wall time, tool calls, cost, and tool output per arm. Also list every task whose claims changed.
6. For every claim the judge marked incorrect or unknown, read that trial with `bun run eval answers <run> <task> --calls` before reporting it as a regression. Judges make mistakes. If a verdict is wrong, offer an override (below) and don't blame the agent.
7. Offer next steps: more trials for noisy deltas, overrides, or promoting the run to baseline.

## Other flows

- **Dashboard**: `bun run eval report --open` rebuilds `evals/results/index.html` over every complete run. Runs still running or grading are left out.
- **Regrade** after editing a `key.md` or `src/judge.ts`: `bun run eval grade <run> --regrade`.
- **Override a verdict**: after reading the transcript, add `"<arm>/<task>/t<N>/<claim>": { "verdict": "correct", "note": "<why>" }` to `evals/results/<run>/overrides.json`, then run `bun run eval report <run>`. If the key was missing an acceptable alternate, fix `key.md` instead (mark it _(Added during grading)_) and regrade.
- **Add a task**: follow "Adding a task" in `evals/README.md`. Baseline `qN` tasks run by default; recorded `teN` tasks run with `--cohort token-exchange`. Every fact must come from the canonical rfc-editor.org text saved in `evals/rfc-text/`, never from memory or the rfc tool under test. Ask the user to confirm the claims before committing them.
- **Promote**: `bun run eval promote <run>` replaces `evals/baseline/summary.json`. Confirm first, and only promote a run whose incorrect verdicts have all been reviewed.

## Updating defaults

When the user states a lasting preference ("always use 3 trials", "judge with a different model", "raise concurrency"), edit the matching field in `evals/config.ts` and keep its doc comment accurate. For a one-off change, use a CLI flag instead. If a changed default affects the numbers in `evals/README.md` or this skill (cost, timing), update them too.

## Gotchas

- Pi resolves pi-web-access's dependencies from its real path under `node_modules/.bun`. `src/arms.ts` handles this, so don't pass the symlinked path.
- Each trial's `stderr.txt` shows why it failed (auth, extension load, provider errors).
- Never commit `evals/results/`. Commit `baseline/summary.json` only by promoting.
