import { Schema } from "effect";

const inputPriceUsdPerMillionTokensByModel: Readonly<Record<string, number>> = {
  "jev-1.13.0": 0.042,
};

/**
 * Schema for an estimated model-input charge in US dollars.
 */
export const InputTokenCostSchema = Schema.Struct({
  estimatedUsd: Schema.NullOr(Schema.Finite),
  rateUsdPerMillionTokens: Schema.NullOr(Schema.Finite),
});

/**
 * Estimated model-input charge and the rate used to calculate it.
 */
export type InputTokenCost = Schema.Schema.Type<typeof InputTokenCostSchema>;

/**
 * Estimate the input-token charge for provider-resolved model calls.
 *
 * Unknown or differently priced models fail closed to a null estimate rather
 * than applying a stale or incorrect rate. An absent token count likewise
 * remains unknown instead of being reported as a zero-cost request.
 *
 * @param inputTokens Aggregated provider-reported input tokens, or null when unavailable.
 * @param resolvedModels Provider-resolved model identifiers observed during the operation.
 * @returns The estimated USD charge and per-million-token rate, or null values when unpriced.
 */
export const estimateInputTokenCost = (
  inputTokens: number | null,
  resolvedModels: ReadonlyArray<string>,
): InputTokenCost => {
  const models = [...new Set(resolvedModels)];
  // The model name is provider-reported, so an inherited `Object.prototype`
  // member must not read as a known rate and produce a non-finite estimate.
  const rates = models.map((model) =>
    Object.hasOwn(inputPriceUsdPerMillionTokensByModel, model)
      ? inputPriceUsdPerMillionTokensByModel[model]
      : undefined,
  );
  const priced = rates.length > 0 && rates.every((rate) => rate !== undefined);
  const uniqueRates = priced ? [...new Set(rates)] : [];
  const rateUsdPerMillionTokens = uniqueRates.length === 1 ? (uniqueRates[0] ?? null) : null;

  const rawEstimate =
    inputTokens === null || rateUsdPerMillionTokens === null
      ? null
      : (inputTokens * rateUsdPerMillionTokens) / 1_000_000;

  return {
    estimatedUsd:
      rawEstimate === null ? null : Math.round(rawEstimate * 1_000_000_000_000) / 1_000_000_000_000,
    rateUsdPerMillionTokens,
  };
};
