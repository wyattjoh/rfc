import { describe, expect, test } from "bun:test";
import { estimateInputTokenCost } from "../src/index";

describe("input-token cost estimates", () => {
  test("prices aggregated Jev 1.13 input tokens", () => {
    expect(estimateInputTokenCost(1_000_000, ["jev-1.13.0"])).toEqual({
      estimatedUsd: 0.042,
      rateUsdPerMillionTokens: 0.042,
    });
  });

  test("keeps missing usage unknown while exposing a known model rate", () => {
    expect(estimateInputTokenCost(null, ["jev-1.13.0"])).toEqual({
      estimatedUsd: null,
      rateUsdPerMillionTokens: 0.042,
    });
  });

  test("fails closed when any resolved model has no known price", () => {
    expect(estimateInputTokenCost(1_000_000, ["jev-1.13.0", "jev-future"])).toEqual({
      estimatedUsd: null,
      rateUsdPerMillionTokens: null,
    });
  });
});
