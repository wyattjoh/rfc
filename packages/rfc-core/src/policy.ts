import {
  datatrackerCurrencyContextLimit,
  datatrackerCurrencyDepthLimit,
  datatrackerDocumentCandidateLimit,
} from "./discovery";

/**
 * Every threshold and bound used by Jev-ranked retrieval.
 *
 * The engine only retrieves and judges relevance; the caller reasons over the
 * returned passages. Thresholds are uncalibrated working values chosen to keep
 * one to three passages per question.
 */
export const retrievalPolicy = {
  policyVersion: "jev-retrieval-v1",
  pinnedModel: "jev-1.13.0",
  maxQuestions: 4,
  maxRequestedRfcs: 4,
  maxPoolCandidates: datatrackerDocumentCandidateLimit,
  abstractMaximumCharacters: 1_500,
  rankFloor: 0.3,
  maxRfcsPerQuestion: 2,
  coverageMass: 0.8,
  maxSections: 3,
  maxParagraphs: 3,
  maxChoiceOptions: 250,
  sectionBeamWidth: 3,
  sectionPreviewCharacters: 120,
  chapterPreviewCharacters: 600,
  paragraphStateCharacters: 60_000,
  // Paragraph-question pairs judged in one request: each is one Choice label
  // and one verdict decision. TypeSafe rejects a System One request near 64k
  // tokens with max_tokens_exceeded; 250 short paragraphs times two questions
  // crossed it, so this bounds the request independently of paragraph length.
  maxParagraphJudgments: 100,
  existsFloor: 0.35,
  maxCurrencyTraversalDepth: datatrackerCurrencyDepthLimit,
  maxCurrencyContexts: datatrackerCurrencyContextLimit,
  providerMaxAttempts: 3,
  providerMaxElapsedMilliseconds: 10_000,
  providerDefaultRetryDelayMilliseconds: 100,
} as const;

/**
 * The shape of the retrieval policy.
 */
export type RetrievalPolicy = typeof retrievalPolicy;
