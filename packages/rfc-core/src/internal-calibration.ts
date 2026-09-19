import { createRfcClient, type RfcClient, type RfcClientOptions } from "./index";
import { calibrationOperationsFor } from "./internal-client";
import { calibrationAnswerActivation } from "./activation";
import type { EvidenceBundle } from "./research";
import type { CatalogRefreshResult, CatalogSource, CatalogStatus } from "./catalog";
import type { HttpClient } from "effect/unstable/http";

/**
 * Private schema-version-one request retained only by calibration fixtures.
 */
export interface CalibrationResearchRequest {
  readonly schemaVersion: 1;
  readonly question: string;
  readonly rfc: string | null;
}

/**
 * Private calibration client isolated from the public version-two contract.
 */
export type RfcCalibrationClient = Omit<RfcClient, "research"> & {
  readonly research: (request: CalibrationResearchRequest) => Promise<EvidenceBundle>;
  readonly catalogStatus: () => Promise<CatalogStatus>;
  readonly catalogRefresh: () => Promise<CatalogRefreshResult>;
  readonly prefetchSources: (rfcs: ReadonlyArray<string>) => Promise<void>;
};

/**
 * Construct the private live-calibration client without exposing its bypass
 * capability through the public client interface.
 *
 * @param options Cache, catalog fixture, clock, and provider options for calibration.
 * @returns A private client with calibration answers and legacy fixtures enabled.
 */
export interface RfcCalibrationClientOptions extends Omit<
  RfcClientOptions,
  "automaticAnswerActivation"
> {
  readonly catalogPath?: string | undefined;
  readonly catalogSource?: CatalogSource | undefined;
  readonly catalogHttpClient?: HttpClient.HttpClient | undefined;
  readonly catalogFetch?: typeof globalThis.fetch | undefined;
}

export const createRfcCalibrationClient = async (
  options: RfcCalibrationClientOptions,
): Promise<RfcCalibrationClient> => {
  const client = await createRfcClient({
    ...options,
    automaticAnswerActivation: calibrationAnswerActivation,
  });
  const operations = calibrationOperationsFor(client);
  return {
    ...client,
    catalogStatus: operations.catalogStatus,
    catalogRefresh: operations.catalogRefresh,
    prefetchSources: operations.prefetchSources,
    research: operations.researchLegacy,
  };
};
