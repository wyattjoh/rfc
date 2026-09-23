import { Clock, Context, Effect, FileSystem, Path, Ref, Result, Schema } from "effect";
import * as AiError from "effect/unstable/ai/AiError";
import * as Decision from "effect/unstable/ai/Decision";
import * as DecisionModel from "effect/unstable/ai/DecisionModel";
import { LiveRetrievalTraceSchema, RfcDocumentSchema } from "./discovery";
import { LiveRfcSource, RfcSourceRevalidationError } from "./live-source";
import type { RfcMetadata } from "./metadata";
import { makeUtf8OffsetMap, utf8OffsetUnit } from "./offsets";
import { DecisionModelError, retryDecisionModel } from "./decision-retry";
import { InputTokenCostSchema } from "./pricing";
import { retrievalPolicy } from "./policy";
import { schemaVersion } from "./protocol";
import { parseRfcStructure, type RfcParagraph, type RfcSection } from "./sections";
import { RfcSourceCacheError, RfcSourceFetchError, type RfcSource } from "./source";

export { retrievalPolicy, type RetrievalPolicy } from "./policy";

/**
 * Provider-observed model identifier shared with the research diagnostics layer.
 */
export class ResolvedModelName extends Context.Service<ResolvedModelName, Ref.Ref<string>>()(
  "@wyattjoh/rfc/ResolvedModelName",
) {}

/**
 * Provider-resolved model identifiers observed across every semantic call.
 */
export class ResolvedModelNames extends Context.Service<
  ResolvedModelNames,
  Ref.Ref<ReadonlyArray<string>>
>()("@wyattjoh/rfc/ResolvedModelNames") {}

/**
 * Collapse provider observations into one safe public model identity.
 *
 * @param fallback The configured or last observed model identifier.
 * @param observed Model identifiers returned by provider calls.
 * @returns The sole observed model or `mixed` when providers disagree.
 */
export const summarizeResolvedModels = (
  fallback: string,
  observed: ReadonlyArray<string>,
): string => {
  const models = [...new Set(observed)];
  return models.length === 0 ? fallback : models.length === 1 ? (models[0] ?? fallback) : "mixed";
};

/**
 * How an RFC entered the candidate pool.
 */
export const HitRoleSchema = Schema.Literals(["requested", "current", "discovered"]);

/**
 * How an RFC entered the candidate pool: named by the caller, the current
 * successor of a named RFC, or found by topic search.
 */
export type HitRole = Schema.Schema.Type<typeof HitRoleSchema>;

/**
 * How returned passages relate to a question, using citation-check semantics.
 */
export const VerdictSchema = Schema.Literals([
  "supports",
  "partial",
  "says_nothing",
  "contradicts",
]);

/**
 * How returned passages relate to a question.
 */
export type Verdict = Schema.Schema.Type<typeof VerdictSchema>;

/**
 * One directed live relationship followed while resolving RFC currency.
 */
export const RfcRelationshipStepSchema = Schema.Struct({
  from: Schema.NonEmptyString,
  to: Schema.NonEmptyString,
  relationship: Schema.Literals(["updates", "obsoletes"]),
});

/**
 * One directed relationship in the path from a requested RFC to a current RFC.
 */
export type RfcRelationshipStep = Schema.Schema.Type<typeof RfcRelationshipStepSchema>;

/**
 * The requested-to-current relationship report for one named RFC.
 */
export const RfcCurrencyReportSchema = Schema.Struct({
  requested: Schema.NonEmptyString,
  current: Schema.Array(Schema.NonEmptyString),
  complete: Schema.Boolean,
  paths: Schema.Array(
    Schema.Struct({
      identifier: Schema.NonEmptyString,
      path: Schema.Array(RfcRelationshipStepSchema),
    }),
  ),
});

/**
 * The requested-to-current relationship report for one named RFC.
 */
export type RfcCurrencyReport = Schema.Schema.Type<typeof RfcCurrencyReportSchema>;

/**
 * Exact source identity and UTF-8 byte range of a passage.
 */
export const PassageProvenanceSchema = Schema.Struct({
  sourceUrl: Schema.NonEmptyString,
  sourceHash: Schema.NonEmptyString,
  offsetUnit: Schema.Literal(utf8OffsetUnit),
  startOffset: Schema.Natural,
  endOffset: Schema.Natural,
  fetchedAt: Schema.String,
});

/**
 * Exact source identity and UTF-8 byte range of a passage.
 */
export type PassageProvenance = Schema.Schema.Type<typeof PassageProvenanceSchema>;

/**
 * One exact paragraph copied from canonical RFC text.
 */
export const PassageSchema = Schema.Struct({
  quote: Schema.String,
  section: Schema.NullOr(Schema.String),
  probability: Schema.Number,
  verdict: VerdictSchema,
  provenance: PassageProvenanceSchema,
});

/**
 * One exact paragraph copied from canonical RFC text.
 */
export type Passage = Schema.Schema.Type<typeof PassageSchema>;

/**
 * One RFC judged relevant to a question, with its best paragraphs.
 */
export const ResearchHitSchema = Schema.Struct({
  rfc: RfcDocumentSchema,
  role: HitRoleSchema,
  relevance: Schema.NullOr(Schema.Number),
  verdict: VerdictSchema,
  passages: Schema.Array(PassageSchema),
});

/**
 * One RFC judged relevant to a question, with its best paragraphs.
 */
export type ResearchHit = Schema.Schema.Type<typeof ResearchHitSchema>;

/**
 * The ranked hits for one caller question.
 */
export const ResearchAnswerSchema = Schema.Struct({
  question: Schema.NonEmptyString,
  found: Schema.Boolean,
  searched: Schema.Array(Schema.NonEmptyString),
  hits: Schema.Array(ResearchHitSchema),
});

/**
 * The ranked hits for one caller question.
 */
export type ResearchAnswer = Schema.Schema.Type<typeof ResearchAnswerSchema>;

const TokenUsageSchema = Schema.Struct({
  inputTokens: Schema.NullOr(Schema.Number),
  outputTokens: Schema.NullOr(Schema.Number),
});

/**
 * Bounded diagnostics for one research operation.
 */
export const ResearchDiagnosticsSchema = Schema.Struct({
  policyVersion: Schema.NonEmptyString,
  requestedModel: Schema.NonEmptyString,
  resolvedModels: Schema.Array(Schema.NonEmptyString),
  usage: TokenUsageSchema,
  inputCost: InputTokenCostSchema,
  timings: Schema.Struct({
    metadataMs: Schema.Number,
    sourceMs: Schema.Number,
    rankMs: Schema.Number,
    sectionMs: Schema.Number,
    paragraphMs: Schema.Number,
    totalMs: Schema.Number,
  }),
  retrieval: LiveRetrievalTraceSchema,
  candidates: Schema.Struct({
    pool: Schema.Natural,
    ranked: Schema.Natural,
  }),
});

/**
 * Bounded diagnostics for one research operation.
 */
export type ResearchDiagnostics = Schema.Schema.Type<typeof ResearchDiagnosticsSchema>;

/**
 * The public result of one research operation.
 */
export const ResearchResultSchema = Schema.Struct({
  schemaVersion: Schema.Literal(schemaVersion),
  kind: Schema.Literal("research_result"),
  answers: Schema.Array(ResearchAnswerSchema),
  currency: Schema.optionalKey(Schema.Array(RfcCurrencyReportSchema)),
  diagnostics: ResearchDiagnosticsSchema,
});

/**
 * The public result of one research operation.
 */
export type ResearchResult = Schema.Schema.Type<typeof ResearchResultSchema>;

/**
 * A typed failure when a requested RFC is not an exact published document.
 */
export class RfcNotFoundError extends Schema.TaggedError<RfcNotFoundError>()("RfcNotFoundError", {
  rfc: Schema.String,
}) {}

export { DecisionModelError };

type DecisionStage = "rank" | "section" | "paragraph";

const providerErrorTag = (error: unknown): string =>
  AiError.isAiError(error) ? error.reason._tag : "UnknownProviderError";

const researchRetryPolicy = (stage: DecisionStage) => ({
  stage,
  maxAttempts: retrievalPolicy.providerMaxAttempts,
  maxElapsedMilliseconds: retrievalPolicy.providerMaxElapsedMilliseconds,
  startedAt: undefined,
  baseDelayMilliseconds: () => retrievalPolicy.providerDefaultRetryDelayMilliseconds,
  reasons: {
    budgetBeforeAttempt: (attempt: number) =>
      `DecisionModel elapsed-time budget exhausted before attempt ${attempt}`,
    budgetDuringAttempt: (attempt: number) =>
      `DecisionModel elapsed-time budget exhausted during attempt ${attempt}`,
    rejected: (error: unknown) => `DecisionModel provider failure (${providerErrorTag(error)})`,
    exhausted: (error: AiError.AiError, attempts: number) =>
      `DecisionModel retry budget exhausted after ${attempts} attempts (${providerErrorTag(error)})`,
  },
});

type Usage = {
  readonly inputTokens: number | undefined;
  readonly outputTokens: number | undefined;
};

const addUsage = (left: number | undefined, right: number | undefined): number | undefined => {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return left + right;
};

const combineUsages = (usages: ReadonlyArray<Usage>): Usage =>
  usages.reduce<Usage>(
    (total, usage) => ({
      inputTokens: addUsage(total.inputTokens, usage.inputTokens),
      outputTokens: addUsage(total.outputTokens, usage.outputTokens),
    }),
    { inputTokens: undefined, outputTokens: undefined },
  );

const noUsage: Usage = { inputTokens: undefined, outputTokens: undefined };

type DecisionBatch = {
  readonly answers: Decision.Answers<Record<string, Decision.Any>>;
  readonly usage: Usage;
};

/**
 * Send one batch of independent decisions over a shared state.
 */
const decide = Effect.fnUntraced(function* <S extends Schema.Codec<any, any, never, never>>(
  stage: DecisionStage,
  input: S,
  state: S["Type"],
  decisions: Readonly<Record<string, Decision.Any>>,
): Effect.fn.Return<DecisionBatch, DecisionModelError, DecisionModel.DecisionModel> {
  const model = yield* DecisionModel.DecisionModel;
  const definition = Decision.make({
    input,
    decisions: decisions as Record<string, Decision.Any>,
  });
  const response = yield* retryDecisionModel(
    researchRetryPolicy(stage),
    Effect.suspend(() => model.decide(definition, { input: state })),
  );
  // DecisionModel has already validated every answer against its decision.
  const { answers, usage } = response;
  return { answers, usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } };
});

type ChoiceResult = {
  readonly label: string;
  readonly probabilities: Readonly<Record<string, number>>;
};

// Research only reads keys it put in the definition, so a missing or mismatched
// answer is a wiring bug; it is still reported as a typed failure.
const choiceAnswer = (
  stage: DecisionStage,
  answers: DecisionBatch["answers"],
  key: string,
): Effect.Effect<ChoiceResult, DecisionModelError> => {
  const answer = answers[key];
  return answer !== undefined && "label" in answer
    ? Effect.succeed({ label: answer.label, probabilities: answer.probabilities })
    : Effect.fail(new DecisionModelError({ stage, reason: `Provider omitted ${key}` }));
};

const noulAnswer = (
  stage: DecisionStage,
  answers: DecisionBatch["answers"],
  key: string,
): Effect.Effect<number, DecisionModelError> => {
  const answer = answers[key];
  return answer !== undefined && "probability" in answer
    ? Effect.succeed(answer.probability)
    : Effect.fail(new DecisionModelError({ stage, reason: `Provider omitted ${key}` }));
};

/**
 * Keep options in probability order until they cover the policy's share of
 * the non-`none` mass, up to a count limit.
 */
const coverageSelect = (
  probabilities: Readonly<Record<string, number>>,
  labels: ReadonlyArray<string>,
  limit: number,
): ReadonlyArray<{ readonly label: string; readonly probability: number }> => {
  const ranked = labels
    .map((label) => ({ label, probability: probabilities[label] ?? 0 }))
    .sort((left, right) => right.probability - left.probability);
  const total = ranked.reduce((sum, { probability }) => sum + probability, 0);
  if (total <= 0) return [];
  const picked: Array<{ readonly label: string; readonly probability: number }> = [];
  let covered = 0;
  for (const option of ranked) {
    if (picked.length >= limit || covered >= retrievalPolicy.coverageMass) break;
    picked.push(option);
    covered += option.probability / total;
  }
  return picked;
};

/**
 * Keep the highest-probability options regardless of coverage, for a beam.
 */
const topSelect = (
  probabilities: Readonly<Record<string, number>>,
  labels: ReadonlyArray<string>,
  width: number,
): ReadonlyArray<{ readonly label: string; readonly probability: number }> =>
  labels
    .map((label) => ({ label, probability: probabilities[label] ?? 0 }))
    .sort((left, right) => right.probability - left.probability)
    .slice(0, width);

const noneLabel = "none";

const questionKey = (index: number): string => `q${index}`;

const collapse = (value: string): string => value.replace(/\s+/g, " ").trim();

const truncate = (value: string, limit: number): string =>
  value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;

const QuestionsSchema = Schema.Record(Schema.String, Schema.String);

// ---------------------------------------------------------------------------
// Candidate pool and RFC currency
// ---------------------------------------------------------------------------

/**
 * One RFC eligible for ranking, with how it entered the pool.
 */
export interface PoolCandidate {
  /**
   * Request-local RFC metadata.
   */
  readonly document: RfcMetadata;
  /**
   * How the RFC entered the pool.
   */
  readonly role: HitRole;
  /**
   * Identifier of the named RFC this candidate descends from, or undefined for
   * a topic hit. A requested RFC and its current successors share a family.
   */
  readonly family: string | undefined;
}

/**
 * One named RFC resolved by live lookup, with the documents its currency
 * traversal visited.
 */
export interface NamedRfcLookup {
  /**
   * Exact metadata for the named RFC.
   */
  readonly document: RfcMetadata;
  /**
   * Request-local metadata for every RFC visited during currency traversal.
   */
  readonly documents: ReadonlyArray<RfcMetadata>;
  /**
   * Whether live traversal fetched every successor relationship it found.
   */
  readonly traversalComplete: boolean;
}

type SuccessorEdge = {
  readonly document: RfcMetadata;
  readonly relationship: RfcRelationshipStep["relationship"];
};

const normalizedRfcIdentifier = (value: string): string | undefined => {
  const match = /^RFC([1-9]\d*)$/i.exec(value.trim());
  if (match === null) return undefined;
  const number = Number(match[1]);
  return Number.isSafeInteger(number) && number > 0 ? `RFC${number}` : undefined;
};

const currencyIdentifier = (document: RfcMetadata): string =>
  normalizedRfcIdentifier(document.identifier) ?? document.identifier.toUpperCase();

const compareRfcDocuments = (left: RfcMetadata, right: RfcMetadata): number =>
  left.rfcNumber - right.rfcNumber || left.identifier.localeCompare(right.identifier);

const successorEdges = (
  documents: ReadonlyArray<RfcMetadata>,
  document: RfcMetadata,
): { readonly edges: ReadonlyArray<SuccessorEdge>; readonly unresolved: boolean } => {
  const documentsByIdentifier = new Map<string, RfcMetadata>();
  for (const candidate of documents) {
    documentsByIdentifier.set(currencyIdentifier(candidate), candidate);
  }
  const edges = new Map<string, SuccessorEdge>();
  let unresolved = false;
  const addEdge = (identifier: string, relationship: RfcRelationshipStep["relationship"]): void => {
    const normalized = normalizedRfcIdentifier(identifier);
    const successor = normalized === undefined ? undefined : documentsByIdentifier.get(normalized);
    if (successor === undefined) {
      unresolved = true;
      return;
    }
    edges.set(`${relationship}:${currencyIdentifier(successor)}`, {
      document: successor,
      relationship,
    });
  };
  // Successors are read only from the document's own `updatedBy` and
  // `obsoletedBy`; live discovery leaves `updates` and `obsoletes` empty.
  for (const identifier of document.updatedBy) addEdge(identifier, "updates");
  for (const identifier of document.obsoletedBy) addEdge(identifier, "obsoletes");
  return {
    edges: [...edges.values()].sort(
      (left, right) =>
        compareRfcDocuments(left.document, right.document) ||
        left.relationship.localeCompare(right.relationship),
    ),
    unresolved,
  };
};

type CurrentContext = {
  readonly document: RfcMetadata;
  readonly relationshipPath: ReadonlyArray<RfcRelationshipStep>;
};

/**
 * Resolve the bounded current successors of a requested RFC.
 *
 * A current RFC is a leaf of the successor graph reachable from the requested
 * RFC. A requested RFC with no successors is its own current RFC.
 *
 * @param documents Request-local metadata visited by currency traversal.
 * @param requested The named RFC.
 * @param traversalComplete Whether live traversal fetched every relationship it found.
 * @returns Current successor contexts and the relationship report. The report is
 * incomplete when a successor was unresolved or cut off by a traversal bound.
 */
export const resolveRfcCurrency = (
  documents: ReadonlyArray<RfcMetadata>,
  requested: RfcMetadata,
  traversalComplete = true,
): {
  readonly current: ReadonlyArray<CurrentContext>;
  readonly report: RfcCurrencyReport;
} => {
  const expanded = new Set<string>([currencyIdentifier(requested)]);
  const activePath = new Set<string>();
  const current: Array<CurrentContext> = [];
  let hasSuccessors = false;
  let complete = traversalComplete;

  const visit = (
    document: RfcMetadata,
    relationshipPath: ReadonlyArray<RfcRelationshipStep>,
    depth: number,
  ): void => {
    const identifier = currencyIdentifier(document);
    activePath.add(identifier);
    const { edges, unresolved } = successorEdges(documents, document);
    hasSuccessors ||= edges.length > 0 || unresolved;
    if (unresolved) complete = false;
    if (edges.length === 0) {
      if (document !== requested && !unresolved) current.push({ document, relationshipPath });
      activePath.delete(identifier);
      return;
    }
    for (const edge of edges) {
      const successor = currencyIdentifier(edge.document);
      if (activePath.has(successor) || expanded.has(successor)) continue;
      if (
        depth >= retrievalPolicy.maxCurrencyTraversalDepth ||
        expanded.size >= retrievalPolicy.maxCurrencyContexts
      ) {
        complete = false;
        continue;
      }
      expanded.add(successor);
      visit(
        edge.document,
        [
          ...relationshipPath,
          {
            from: document.identifier,
            to: edge.document.identifier,
            relationship: edge.relationship,
          },
        ],
        depth + 1,
      );
    }
    activePath.delete(identifier);
  };

  visit(requested, [], 0);
  const sorted = current
    .sort((left, right) => compareRfcDocuments(left.document, right.document))
    .slice(0, retrievalPolicy.maxCurrencyContexts);
  return {
    current: sorted,
    report: {
      requested: requested.identifier,
      current: hasSuccessors
        ? sorted.map(({ document }) => document.identifier)
        : [requested.identifier],
      complete,
      paths: [
        { identifier: requested.identifier, path: [] },
        ...sorted.map(({ document, relationshipPath }) => ({
          identifier: document.identifier,
          path: relationshipPath,
        })),
      ],
    },
  };
};

/**
 * Merge named RFCs, their current successors, and topic hits into one
 * deduplicated, bounded candidate pool.
 *
 * Named RFCs come first, then their successors, then topic hits, so the pool
 * bound only ever drops topic hits before caller-named material.
 *
 * @param named Named RFC lookups with their currency traversal documents.
 * @param discovered Topic-discovery candidates in discovery order.
 * @returns The candidate pool and one currency report per named RFC.
 */
export const buildCandidatePool = (
  named: ReadonlyArray<NamedRfcLookup>,
  discovered: ReadonlyArray<RfcMetadata>,
): {
  readonly pool: ReadonlyArray<PoolCandidate>;
  readonly currency: ReadonlyArray<RfcCurrencyReport>;
} => {
  const pool = new Map<string, PoolCandidate>();
  const add = (candidate: PoolCandidate): void => {
    const identifier = currencyIdentifier(candidate.document);
    if (!pool.has(identifier)) pool.set(identifier, candidate);
  };
  const resolutions = named.map((lookup) => ({
    lookup,
    resolution: resolveRfcCurrency(lookup.documents, lookup.document, lookup.traversalComplete),
  }));
  for (const { lookup } of resolutions) {
    add({ document: lookup.document, role: "requested", family: lookup.document.identifier });
  }
  for (const { lookup, resolution } of resolutions) {
    for (const { document } of resolution.current) {
      add({ document, role: "current", family: lookup.document.identifier });
    }
  }
  for (const document of discovered) add({ document, role: "discovered", family: undefined });
  return {
    pool: [...pool.values()].slice(0, retrievalPolicy.maxPoolCandidates),
    currency: resolutions.map(({ resolution }) => resolution.report),
  };
};

// ---------------------------------------------------------------------------
// Stage 1: rank RFCs
// ---------------------------------------------------------------------------

const RankInputSchema = Schema.Struct({
  questions: QuestionsSchema,
  candidates: Schema.Record(
    Schema.String,
    Schema.Struct({
      identifier: Schema.String,
      title: Schema.String,
      abstract: Schema.String,
    }),
  ),
});

type RankedCandidate = {
  readonly candidate: PoolCandidate;
  readonly relevance: number | null;
};

const candidateKey = (index: number): string => `c${index}`;

const rankDecisions = (
  questions: ReadonlyArray<string>,
  pool: ReadonlyArray<PoolCandidate>,
): Record<string, Decision.Any> =>
  Object.fromEntries(
    questions.flatMap((_, questionIndex) => {
      const question = `\`questions.${questionKey(questionIndex)}\``;
      return [
        [
          `rank_${questionKey(questionIndex)}`,
          Decision.classify({
            instructions: `Which candidate RFC in \`candidates\` defines or normatively specifies what the question ${question} asks about? Tell apart RFCs that specify the subject from lookalikes that only mention it.`,
            criteria: Object.fromEntries([
              ...pool.map(({ document }, index) => [
                candidateKey(index),
                `\`candidates.${candidateKey(index)}\` (${document.identifier}, ${truncate(collapse(document.title), 120)}) specifies what the question asks about`,
              ]),
              [noneLabel, "No candidate RFC specifies what the question asks about"],
            ]),
          }),
        ],
        ...pool.map(({ document }, index) => [
          `relevant_${questionKey(questionIndex)}_${candidateKey(index)}`,
          Decision.probability({
            instructions: `Does the candidate RFC \`candidates.${candidateKey(index)}\` (${document.identifier}) define or normatively specify what the question ${question} asks about?`,
            criteria: {
              true: "The candidate RFC defines or normatively specifies what the question asks about.",
              false:
                "The candidate RFC is only on a related topic; it does not specify what the question asks about.",
            },
          }),
        ]),
      ];
    }),
  );

const rankStage = Effect.fnUntraced(function* (
  questions: ReadonlyArray<string>,
  pool: ReadonlyArray<PoolCandidate>,
): Effect.fn.Return<
  { readonly kept: ReadonlyArray<ReadonlyArray<RankedCandidate>>; readonly usage: Usage },
  DecisionModelError,
  DecisionModel.DecisionModel
> {
  if (pool.length === 0) {
    return { kept: questions.map(() => []), usage: noUsage };
  }
  const only = pool[0];
  if (pool.length === 1 && only !== undefined) {
    return { kept: questions.map(() => [{ candidate: only, relevance: null }]), usage: noUsage };
  }

  const batch = yield* decide(
    "rank",
    RankInputSchema,
    {
      questions: Object.fromEntries(
        questions.map((question, index) => [questionKey(index), question]),
      ),
      candidates: Object.fromEntries(
        pool.map(({ document }, index) => [
          candidateKey(index),
          {
            identifier: document.identifier,
            title: document.title,
            abstract: truncate(document.abstract, retrievalPolicy.abstractMaximumCharacters),
          },
        ]),
      ),
    },
    rankDecisions(questions, pool),
  );

  const kept: Array<ReadonlyArray<RankedCandidate>> = [];
  for (const [questionIndex] of questions.entries()) {
    const choice = yield* choiceAnswer("rank", batch.answers, `rank_${questionKey(questionIndex)}`);
    const scored: Array<{
      readonly candidate: PoolCandidate;
      readonly index: number;
      readonly relevance: number;
      readonly choice: number;
    }> = [];
    for (const [index, candidate] of pool.entries()) {
      scored.push({
        candidate,
        index,
        relevance: yield* noulAnswer(
          "rank",
          batch.answers,
          `relevant_${questionKey(questionIndex)}_${candidateKey(index)}`,
        ),
        choice: choice.probabilities[candidateKey(index)] ?? 0,
      });
    }
    const eligible = scored
      .filter(({ relevance }) => relevance >= retrievalPolicy.rankFloor)
      .sort(
        (left, right) =>
          right.relevance - left.relevance ||
          right.choice - left.choice ||
          left.index - right.index,
      );
    const top = eligible.slice(0, retrievalPolicy.maxRfcsPerQuestion);
    // A requested RFC and its current successor are both kept when both clear
    // the floor, so a successor never silently replaces what the caller named.
    const families = new Set(top.flatMap(({ candidate }) => candidate.family ?? []));
    const selected = eligible.filter(
      (entry) =>
        top.includes(entry) ||
        (entry.candidate.family !== undefined && families.has(entry.candidate.family)),
    );
    kept.push(selected.map(({ candidate, relevance }) => ({ candidate, relevance })));
  }
  return { kept, usage: batch.usage };
});

// ---------------------------------------------------------------------------
// Stage 2: pick sections
// ---------------------------------------------------------------------------

const SectionInputSchema = Schema.Struct({
  questions: QuestionsSchema,
  toc: Schema.Record(
    Schema.String,
    Schema.Struct({
      heading: Schema.String,
      preview: Schema.String,
    }),
  ),
});

type LoadedRfc = {
  readonly candidate: PoolCandidate;
  readonly source: RfcSource;
  readonly sections: ReadonlyArray<RfcSection>;
  readonly paragraphs: ReadonlyArray<RfcParagraph>;
  readonly paragraphsBySection: ReadonlyMap<number, ReadonlyArray<RfcParagraph>>;
};

type PickedSection = { readonly section: RfcSection; readonly probability: number };

const sectionKey = (section: RfcSection): string => `s${section.index}`;

type TocEntry = { readonly heading: string; readonly preview: string };

const sectionEntry = (rfc: LoadedRfc, section: RfcSection): TocEntry => ({
  heading: collapse(section.heading),
  preview: truncate(
    collapse(rfc.paragraphsBySection.get(section.index)?.[0]?.text ?? ""),
    retrievalPolicy.sectionPreviewCharacters,
  ),
});

// A chapter is summarized by the titles of the sections inside it, which is
// where a large RFC names the fields, codes, and procedures a question targets.
const chapterEntry = (rfc: LoadedRfc, chapter: RfcSection): TocEntry => ({
  heading: collapse(chapter.heading),
  preview: truncate(
    rfc.sections
      .filter(
        (section) =>
          section.index !== chapter.index &&
          topLevelAncestor(rfc.sections, section) === chapter.index,
      )
      .map((section) => collapse(section.heading))
      .join("; "),
    retrievalPolicy.chapterPreviewCharacters,
  ),
});

const sectionChoice = (
  questionIndex: number,
  sections: ReadonlyArray<RfcSection>,
  identifier: string,
): Decision.Any =>
  Decision.classify({
    instructions: `Which section of ${identifier}, listed in \`toc\`, contains the text that answers the question \`questions.${questionKey(questionIndex)}\`?`,
    criteria: Object.fromEntries([
      ...sections.map((section) => [
        sectionKey(section),
        `Section \`toc.${sectionKey(section)}\` (${truncate(collapse(section.heading), 120)}) contains the answer`,
      ]),
      [noneLabel, "No listed section contains the answer"],
    ]),
  });

const topLevelAncestor = (sections: ReadonlyArray<RfcSection>, section: RfcSection): number => {
  let current = section;
  while (current.parent !== undefined) {
    const parent = sections[current.parent];
    if (parent === undefined) break;
    current = parent;
  }
  return current.index;
};

const pickSections = Effect.fnUntraced(function* (
  rfc: LoadedRfc,
  questions: ReadonlyMap<number, string>,
): Effect.fn.Return<
  { readonly picked: ReadonlyMap<number, ReadonlyArray<PickedSection>>; readonly usage: Usage },
  DecisionModelError,
  DecisionModel.DecisionModel
> {
  const identifier = rfc.candidate.document.identifier;
  const withText = rfc.sections.filter((section) => rfc.paragraphsBySection.has(section.index));
  const questionState = Object.fromEntries(
    [...questions].map(([index, question]) => [questionKey(index), question]),
  );
  const usages: Array<Usage> = [];

  const choose = Effect.fnUntraced(function* (
    options: ReadonlyMap<number, ReadonlyArray<RfcSection>>,
    entry: (rfc: LoadedRfc, section: RfcSection) => TocEntry,
    select: "coverage" | "beam",
  ) {
    const toc = Object.fromEntries(
      [...new Set([...options.values()].flat())].map((section) => [
        sectionKey(section),
        entry(rfc, section),
      ]),
    );
    const batch = yield* decide(
      "section",
      SectionInputSchema,
      { questions: questionState, toc },
      Object.fromEntries(
        [...options].map(([questionIndex, sections]) => [
          `section_${questionKey(questionIndex)}`,
          sectionChoice(questionIndex, sections, identifier),
        ]),
      ),
    );
    usages.push(batch.usage);
    const picked = new Map<number, ReadonlyArray<PickedSection>>();
    for (const [questionIndex, sections] of options) {
      const labels = sections.map(sectionKey);
      const choice = yield* choiceAnswer(
        "section",
        batch.answers,
        `section_${questionKey(questionIndex)}`,
      );
      const byKey = new Map(sections.map((section) => [sectionKey(section), section]));
      picked.set(
        questionIndex,
        (select === "coverage"
          ? coverageSelect(choice.probabilities, labels, retrievalPolicy.maxSections)
          : topSelect(choice.probabilities, labels, retrievalPolicy.sectionBeamWidth)
        ).flatMap(({ label, probability }) => {
          const section = byKey.get(label);
          return section === undefined ? [] : [{ section, probability }];
        }),
      );
    }
    return picked;
  });

  if (withText.length === 0) {
    return { picked: new Map([...questions.keys()].map((index) => [index, []])), usage: noUsage };
  }

  if (withText.length <= retrievalPolicy.maxChoiceOptions) {
    const picked = yield* choose(
      new Map([...questions.keys()].map((index) => [index, withText])),
      sectionEntry,
      "coverage",
    );
    return { picked, usage: combineUsages(usages) };
  }

  // Too many sections for one Choice: pick top-level chapters first, then
  // choose among the sections inside the best few.
  const chapters = rfc.sections
    .filter((section) => section.depth === 1)
    .slice(0, retrievalPolicy.maxChoiceOptions);
  const beams = yield* choose(
    new Map([...questions.keys()].map((index) => [index, chapters])),
    chapterEntry,
    "beam",
  );
  const inner = new Map(
    [...beams].map(([questionIndex, beam]) => {
      const roots = new Set(beam.map(({ section }) => section.index));
      return [
        questionIndex,
        withText
          .filter((section) => roots.has(topLevelAncestor(rfc.sections, section)))
          .slice(0, retrievalPolicy.maxChoiceOptions),
      ] as const;
    }),
  );
  const answerable = new Map([...inner].filter(([, sections]) => sections.length > 0));
  const picked =
    answerable.size === 0
      ? new Map<number, ReadonlyArray<PickedSection>>()
      : yield* choose(answerable, sectionEntry, "coverage");
  for (const index of questions.keys()) {
    if (!picked.has(index)) picked.set(index, []);
  }
  return { picked, usage: combineUsages(usages) };
});

// ---------------------------------------------------------------------------
// Stage 3: pick paragraphs and judge them
// ---------------------------------------------------------------------------

const ParagraphInputSchema = Schema.Struct({
  questions: QuestionsSchema,
  paragraphs: Schema.Record(
    Schema.String,
    Schema.Struct({
      section: Schema.String,
      text: Schema.String,
    }),
  ),
});

const paragraphKey = (paragraph: RfcParagraph): string => `p${paragraph.index}`;

const verdictCriteria = {
  supports:
    "The paragraph states the answer, directly implies it, or is the text that defines what the question asks about",
  partial: "The paragraph answers only part of the question",
  says_nothing: "The paragraph does not address what the question asks about, either way",
  contradicts:
    "The paragraph states the opposite of what the question presumes or implies it is false",
} as const satisfies Record<Verdict, string>;

type JudgedPassage = {
  readonly paragraph: RfcParagraph;
  readonly probability: number;
  readonly verdict: Verdict;
};

type RfcJudgment = {
  readonly exists: number;
  readonly passages: ReadonlyArray<JudgedPassage>;
};

const paragraphScope = (candidates: ReadonlyArray<RfcParagraph>, all: number): string =>
  candidates.length === all
    ? "`paragraphs`"
    : `the paragraphs ${candidates.map((paragraph) => `\`paragraphs.${paragraphKey(paragraph)}\``).join(", ")}`;

const judgeParagraphs = Effect.fnUntraced(function* (
  rfc: LoadedRfc,
  questions: ReadonlyMap<number, string>,
  sections: ReadonlyMap<number, ReadonlyArray<PickedSection>>,
): Effect.fn.Return<
  { readonly judged: ReadonlyMap<number, RfcJudgment>; readonly usage: Usage },
  DecisionModelError,
  DecisionModel.DecisionModel
> {
  // Fill the shared state in section-rank order across questions until the
  // character budget, the Choice option limit, or the judgment budget is
  // reached. A paragraph costs one judgment for every question whose chosen
  // sections contain it, since each such question gets a label and a verdict.
  const chosenSections = [...sections.values()].map(
    (picked) => new Set(picked.map(({ section }) => section.index)),
  );
  const included = new Map<number, RfcParagraph>();
  let characters = 0;
  let judgments = 0;
  const depth = Math.max(0, ...[...sections.values()].map((picked) => picked.length));
  fill: for (let rank = 0; rank < depth; rank += 1) {
    for (const picked of sections.values()) {
      const section = picked[rank]?.section;
      if (section === undefined) continue;
      for (const paragraph of rfc.paragraphsBySection.get(section.index) ?? []) {
        if (included.has(paragraph.index)) continue;
        const cost = chosenSections.filter((chosen) => chosen.has(section.index)).length;
        if (
          included.size >= retrievalPolicy.maxChoiceOptions ||
          characters + paragraph.text.length > retrievalPolicy.paragraphStateCharacters ||
          judgments + cost > retrievalPolicy.maxParagraphJudgments
        ) {
          break fill;
        }
        included.set(paragraph.index, paragraph);
        characters += paragraph.text.length;
        judgments += cost;
      }
    }
  }

  const candidates = new Map(
    [...questions.keys()].map((questionIndex) => {
      const chosen = new Set(
        (sections.get(questionIndex) ?? []).map(({ section }) => section.index),
      );
      return [
        questionIndex,
        [...included.values()]
          .filter((paragraph) => paragraph.section !== undefined && chosen.has(paragraph.section))
          .sort((left, right) => left.index - right.index),
      ] as const;
    }),
  );
  const answerable = [...candidates].filter(([, paragraphs]) => paragraphs.length > 0);
  if (answerable.length === 0) return { judged: new Map(), usage: noUsage };

  const identifier = rfc.candidate.document.identifier;
  const decisions = Object.fromEntries(
    answerable.flatMap(([questionIndex, paragraphs]) => {
      const question = `\`questions.${questionKey(questionIndex)}\``;
      const scope = paragraphScope(paragraphs, included.size);
      return [
        [
          `paragraph_${questionKey(questionIndex)}`,
          Decision.classify({
            instructions: `Which paragraph of ${identifier} in ${scope} best answers the question ${question}, fully or in part? Each paragraph gives its \`section\` and \`text\`; for a question about where something is defined, the answer is the paragraph whose text defines it.`,
            criteria: Object.fromEntries([
              ...paragraphs.map((paragraph) => [
                paragraphKey(paragraph),
                `Paragraph \`paragraphs.${paragraphKey(paragraph)}\` answers the question or defines what it asks about`,
              ]),
              [noneLabel, "No listed paragraph answers the question"],
            ]),
          }),
        ],
        [
          `exists_${questionKey(questionIndex)}`,
          Decision.probability({
            instructions: `Does any paragraph of ${identifier} in ${scope} answer the question ${question}, fully or in part? A paragraph that defines what the question asks about answers where it is defined, since its RFC and \`section\` are known.`,
            criteria: {
              true: "At least one of these paragraphs states, directly implies, or defines at least part of the answer.",
              false:
                "None of these paragraphs addresses what the question asks; they are only on a related topic.",
            },
          }),
        ],
        ...paragraphs.map((paragraph) => [
          `verdict_${questionKey(questionIndex)}_${paragraphKey(paragraph)}`,
          Decision.classify({
            instructions: `How does the paragraph \`paragraphs.${paragraphKey(paragraph)}\` relate to the question ${question}? Its RFC is ${identifier} and its \`section\` is given, so a paragraph that defines what the question asks about answers where it is defined.`,
            criteria: verdictCriteria,
          }),
        ]),
      ];
    }),
  );
  const batch = yield* decide(
    "paragraph",
    ParagraphInputSchema,
    {
      questions: Object.fromEntries(
        answerable.map(([questionIndex]) => [
          questionKey(questionIndex),
          questions.get(questionIndex) ?? "",
        ]),
      ),
      paragraphs: Object.fromEntries(
        [...included.values()].map((paragraph) => [
          paragraphKey(paragraph),
          {
            section:
              paragraph.section === undefined
                ? ""
                : collapse(rfc.sections[paragraph.section]?.heading ?? ""),
            text: paragraph.text,
          },
        ]),
      ),
    },
    decisions,
  );

  const judged = new Map<number, RfcJudgment>();
  for (const [questionIndex, paragraphs] of answerable) {
    const key = questionKey(questionIndex);
    const labels = paragraphs.map(paragraphKey);
    const choice = yield* choiceAnswer("paragraph", batch.answers, `paragraph_${key}`);
    const exists = yield* noulAnswer("paragraph", batch.answers, `exists_${key}`);
    const byKey = new Map(paragraphs.map((paragraph) => [paragraphKey(paragraph), paragraph]));
    const passages: Array<JudgedPassage> = [];
    for (const { label, probability } of coverageSelect(
      choice.probabilities,
      labels,
      retrievalPolicy.maxParagraphs,
    )) {
      const paragraph = byKey.get(label);
      if (paragraph === undefined) continue;
      const verdict = yield* choiceAnswer("paragraph", batch.answers, `verdict_${key}_${label}`);
      passages.push({ paragraph, probability, verdict: verdict.label as Verdict });
    }
    judged.set(questionIndex, { exists, passages });
  }
  return { judged, usage: batch.usage };
});

const verdictPrecedence: ReadonlyArray<Verdict> = [
  "supports",
  "partial",
  "contradicts",
  "says_nothing",
];

const hitVerdict = (passages: ReadonlyArray<JudgedPassage>): Verdict =>
  verdictPrecedence.find((verdict) => passages.some((passage) => passage.verdict === verdict)) ??
  "says_nothing";

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

/**
 * Inputs to one research pipeline run.
 */
export interface ResearchPipelineOptions {
  /**
   * Caller questions, each answered independently.
   */
  readonly questions: ReadonlyArray<string>;
  /**
   * Deduplicated candidate pool from {@link buildCandidatePool}.
   */
  readonly pool: ReadonlyArray<PoolCandidate>;
  /**
   * Request-local source loader.
   */
  readonly sourceLoader: (
    document: RfcMetadata,
  ) => Effect.Effect<
    RfcSource,
    RfcSourceCacheError | RfcSourceFetchError | RfcSourceRevalidationError,
    FileSystem.FileSystem | LiveRfcSource | Path.Path
  >;
}

/**
 * The engine-side output of one research pipeline run.
 */
export interface ResearchPipelineResult {
  /**
   * One answer per caller question, in order.
   */
  readonly answers: ReadonlyArray<ResearchAnswer>;
  /**
   * Combined provider usage across every request.
   */
  readonly usage: Usage;
  /**
   * Distinct RFCs kept by ranking across all questions.
   */
  readonly rankedCount: number;
  /**
   * Wall-clock stage timings.
   */
  readonly timings: {
    readonly sourceMs: number;
    readonly rankMs: number;
    readonly sectionMs: number;
    readonly paragraphMs: number;
  };
}

const elapsed = (start: number, end: number): number => Math.max(0, end - start);

const loadRfc = Effect.fnUntraced(function* (
  candidate: PoolCandidate,
  options: ResearchPipelineOptions,
) {
  const source = yield* options.sourceLoader(candidate.document);
  const { sections, paragraphs } = parseRfcStructure(source.text);
  const paragraphsBySection = new Map<number, Array<RfcParagraph>>();
  for (const paragraph of paragraphs) {
    if (paragraph.section === undefined) continue;
    const list = paragraphsBySection.get(paragraph.section) ?? [];
    list.push(paragraph);
    paragraphsBySection.set(paragraph.section, list);
  }
  return { candidate, source, sections, paragraphs, paragraphsBySection } satisfies LoadedRfc;
});

const toPassage = (
  rfc: LoadedRfc,
  offsets: ReturnType<typeof makeUtf8OffsetMap>,
  judged: JudgedPassage,
): Effect.Effect<Passage, DecisionModelError> => {
  const startOffset = offsets.byteOffsetAtCodeUnit(judged.paragraph.startOffset);
  const endOffset = offsets.byteOffsetAtCodeUnit(judged.paragraph.endOffset);
  if (startOffset === undefined || endOffset === undefined) {
    return Effect.fail(
      new DecisionModelError({
        stage: "paragraph",
        reason: "A selected paragraph is not on a UTF-8 source boundary",
      }),
    );
  }
  const section =
    judged.paragraph.section === undefined ? undefined : rfc.sections[judged.paragraph.section];
  return Effect.succeed({
    quote: rfc.source.text.slice(judged.paragraph.startOffset, judged.paragraph.endOffset),
    section: section?.heading ?? null,
    probability: judged.probability,
    verdict: judged.verdict,
    provenance: {
      sourceUrl: rfc.source.sourceUrl,
      sourceHash: rfc.source.contentHash,
      offsetUnit: utf8OffsetUnit,
      startOffset,
      endOffset,
      fetchedAt: rfc.source.fetchedAt,
    },
  });
};

const rfcDocument = (document: RfcMetadata) =>
  Schema.decodeUnknownSync(RfcDocumentSchema)({
    identifier: document.identifier,
    rfcNumber: document.rfcNumber,
    title: document.title,
    abstract: document.abstract,
    status: document.status,
    stream: document.stream,
    canonicalUrl: document.canonicalUrl,
  });

/**
 * Rank candidate RFCs, pick sections and paragraphs, and return exact
 * passages for every question.
 *
 * @param options Questions, candidate pool, and source loader.
 * @returns One ranked answer per question with provider usage and timings.
 */
export const researchQuestions = Effect.fnUntraced(function* (
  options: ResearchPipelineOptions,
): Effect.fn.Return<
  ResearchPipelineResult,
  RfcSourceCacheError | RfcSourceFetchError | RfcSourceRevalidationError | DecisionModelError,
  FileSystem.FileSystem | LiveRfcSource | DecisionModel.DecisionModel | Path.Path
> {
  const { questions, pool } = options;
  const rankStarted = yield* Clock.currentTimeMillis;
  const ranking = yield* rankStage(questions, pool);
  const rankFinished = yield* Clock.currentTimeMillis;

  const keptByIdentifier = new Map<string, PoolCandidate>();
  for (const kept of ranking.kept) {
    for (const { candidate } of kept) {
      keptByIdentifier.set(candidate.document.identifier, candidate);
    }
  }

  const loads = yield* Effect.forEach(
    [...keptByIdentifier.values()],
    (candidate) => Effect.result(loadRfc(candidate, options)),
    { concurrency: "unbounded" },
  );
  const sourceFinished = yield* Clock.currentTimeMillis;
  const loaded = new Map<string, LoadedRfc>();
  for (const [index, load] of loads.entries()) {
    const candidate = [...keptByIdentifier.values()][index];
    if (candidate === undefined) continue;
    if (Result.isSuccess(load)) {
      loaded.set(candidate.document.identifier, load.success);
      continue;
    }
    // Only a named RFC's source is required; a successor or topic hit that
    // cannot be fetched is dropped rather than failing every question.
    const error = load.failure;
    const tolerable =
      candidate.role !== "requested" &&
      (error instanceof RfcSourceCacheError || error instanceof RfcSourceFetchError);
    if (!tolerable) return yield* Effect.fail(error);
  }

  const questionsByRfc = new Map<string, Map<number, string>>();
  for (const [questionIndex, kept] of ranking.kept.entries()) {
    for (const { candidate } of kept) {
      const identifier = candidate.document.identifier;
      if (!loaded.has(identifier)) continue;
      const entry = questionsByRfc.get(identifier) ?? new Map<number, string>();
      entry.set(questionIndex, questions[questionIndex] ?? "");
      questionsByRfc.set(identifier, entry);
    }
  }

  const sectionStarted = yield* Clock.currentTimeMillis;
  const sectionResults = yield* Effect.forEach(
    [...questionsByRfc],
    ([identifier, rfcQuestions]) =>
      Effect.map(pickSections(loaded.get(identifier) as LoadedRfc, rfcQuestions), (result) => ({
        identifier,
        rfcQuestions,
        ...result,
      })),
    { concurrency: "unbounded" },
  );
  const sectionFinished = yield* Clock.currentTimeMillis;

  const paragraphResults = yield* Effect.forEach(
    sectionResults,
    ({ identifier, rfcQuestions, picked }) =>
      Effect.map(
        judgeParagraphs(loaded.get(identifier) as LoadedRfc, rfcQuestions, picked),
        (result) => ({ identifier, ...result }),
      ),
    { concurrency: "unbounded" },
  );
  const paragraphFinished = yield* Clock.currentTimeMillis;
  const judgments = new Map(paragraphResults.map(({ identifier, judged }) => [identifier, judged]));

  const offsetMaps = new Map(
    [...loaded].map(([identifier, rfc]) => [identifier, makeUtf8OffsetMap(rfc.source.text)]),
  );
  const answers: Array<ResearchAnswer> = [];
  for (const [questionIndex, question] of questions.entries()) {
    const kept = (ranking.kept[questionIndex] ?? []).filter(({ candidate }) =>
      loaded.has(candidate.document.identifier),
    );
    const hits: Array<ResearchHit> = [];
    for (const { candidate, relevance } of kept) {
      const identifier = candidate.document.identifier;
      const rfc = loaded.get(identifier);
      const offsets = offsetMaps.get(identifier);
      const judgment = judgments.get(identifier)?.get(questionIndex);
      if (rfc === undefined || offsets === undefined || judgment === undefined) continue;
      if (judgment.exists < retrievalPolicy.existsFloor || judgment.passages.length === 0) continue;
      const passages: Array<Passage> = [];
      for (const passage of judgment.passages) {
        passages.push(yield* toPassage(rfc, offsets, passage));
      }
      hits.push({
        rfc: rfcDocument(candidate.document),
        role: candidate.role,
        relevance,
        verdict: hitVerdict(judgment.passages),
        passages,
      });
    }
    answers.push({
      question,
      found: hits.length > 0,
      searched: kept.map(({ candidate }) => candidate.document.identifier),
      hits,
    });
  }

  return {
    answers,
    usage: combineUsages([
      ranking.usage,
      ...sectionResults.map(({ usage }) => usage),
      ...paragraphResults.map(({ usage }) => usage),
    ]),
    rankedCount: keptByIdentifier.size,
    timings: {
      rankMs: elapsed(rankStarted, rankFinished),
      sourceMs: elapsed(rankFinished, sourceFinished),
      sectionMs: elapsed(sectionStarted, sectionFinished),
      paragraphMs: elapsed(sectionFinished, paragraphFinished),
    },
  };
});
