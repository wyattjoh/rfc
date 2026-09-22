import { Effect } from "effect";
import type * as Decision from "effect/unstable/ai/Decision";
import * as DecisionModel from "effect/unstable/ai/DecisionModel";
import type { Verdict } from "../src/index";

/**
 * Per-decision answers for the routing DecisionModel stub, keyed by the
 * question text and the RFC, heading, or paragraph under judgment.
 */
export type Route = {
  readonly relevance?: (question: string, identifier: string) => number;
  readonly section?: (question: string, heading: string) => number;
  readonly paragraph?: (question: string, text: string) => number;
  readonly exists?: (question: string) => number;
  readonly verdict?: (question: string, text: string) => Verdict;
};

/**
 * One DecisionModel request observed by the routing stub.
 */
export type RecordedCall = {
  readonly decisions: Readonly<Record<string, Decision.Any>>;
  readonly input: {
    readonly questions: Readonly<Record<string, string>>;
    readonly candidates?: Readonly<Record<string, { readonly identifier: string }>>;
    readonly toc?: Readonly<Record<string, { readonly heading: string; readonly preview: string }>>;
    readonly paragraphs?: Readonly<
      Record<string, { readonly section: string; readonly text: string }>
    >;
  };
};

const distribution = (
  labels: ReadonlyArray<string>,
  weight: (label: string) => number,
): { readonly label: string; readonly probabilities: Record<string, number> } => {
  const weights = labels.map((label) => (label === "none" ? 0 : Math.max(0, weight(label))));
  const total = weights.reduce((sum, value) => sum + value, 0);
  const probabilities = Object.fromEntries(
    labels.map((label, index) => [
      label,
      total === 0 ? (label === "none" ? 1 : 0) : (weights[index] ?? 0) / total,
    ]),
  );
  const label = labels.reduce((best, candidate) =>
    (probabilities[candidate] ?? 0) > (probabilities[best] ?? 0) ? candidate : best,
  );
  return { label, probabilities };
};

const decisionKeyPattern =
  /^(rank|relevant|section|paragraph|exists|verdict)_(q\d+)(?:_([cp]\d+))?$/;

/**
 * A DecisionModel stub that answers each decision from its key and the shared
 * state, so tests describe behavior by question text, RFC, heading, or paragraph.
 *
 * Unrouted decisions default to a relevant RFC, uniformly likely sections and
 * paragraphs, an existing answer, and a supporting verdict.
 *
 * @param route Optional per-decision answers.
 * @param calls Receives every request the stub answers.
 * @returns The stub DecisionModel.
 */
export const makeRoutingModel = (route: Route = {}, calls: Array<RecordedCall> = []) =>
  ({
    [DecisionModel.TypeId]: DecisionModel.TypeId,
    decide: (
      definition: { readonly decisions: Readonly<Record<string, Decision.Any>> },
      options: { readonly input: RecordedCall["input"] },
    ) => {
      const input = options.input;
      calls.push({ decisions: definition.decisions, input });
      const answers = Object.fromEntries(
        Object.entries(definition.decisions).map(([key, decision]) => {
          const [, kind, questionId = "", target] = decisionKeyPattern.exec(key) ?? [];
          const question = input.questions[questionId] ?? "";
          const relevance = (label: string) =>
            (route.relevance ?? (() => 0.9))(question, input.candidates?.[label]?.identifier ?? "");
          if (decision._tag === "Probability") {
            return [
              key,
              {
                probability:
                  kind === "exists"
                    ? (route.exists ?? (() => 0.9))(question)
                    : relevance(target ?? ""),
              },
            ];
          }
          const labels = Object.keys(decision.criteria);
          if (kind === "verdict") {
            const verdict = (route.verdict ?? (() => "supports" as const))(
              question,
              input.paragraphs?.[target ?? ""]?.text ?? "",
            );
            return [
              key,
              {
                label: verdict,
                probabilities: Object.fromEntries(
                  labels.map((label) => [label, label === verdict ? 1 : 0]),
                ),
                confidence: 1,
              },
            ];
          }
          const weight =
            kind === "rank"
              ? relevance
              : kind === "section"
                ? (label: string) =>
                    (route.section ?? (() => 1))(question, input.toc?.[label]?.heading ?? "")
                : (label: string) =>
                    (route.paragraph ?? (() => 1))(question, input.paragraphs?.[label]?.text ?? "");
          return [key, { ...distribution(labels, weight), confidence: 0.9 }];
        }),
      );
      return Effect.succeed({ answers, usage: { inputTokens: 10, outputTokens: 2 } });
    },
  }) as unknown as DecisionModel.DecisionModel;
