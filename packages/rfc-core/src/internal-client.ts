import type { CatalogRefreshResult, CatalogStatus } from "./catalog";
import type { EvidenceBundle } from "./research";

/**
 * Private operations retained only for the calibration harness during protocol migration.
 */
export interface InternalCalibrationOperations {
  readonly catalogStatus: () => Promise<CatalogStatus>;
  readonly catalogRefresh: () => Promise<CatalogRefreshResult>;
  readonly prefetchSources: (rfcs: ReadonlyArray<string>) => Promise<void>;
  readonly researchLegacy: (request: unknown) => Promise<EvidenceBundle>;
}

const calibrationOperations = new WeakMap<object, InternalCalibrationOperations>();

/**
 * Associate private calibration operations with their authenticated public client.
 */
export const registerCalibrationOperations = (
  client: object,
  operations: InternalCalibrationOperations,
): void => {
  calibrationOperations.set(client, operations);
};

/**
 * Resolve private operations for an authenticated calibration client.
 */
export const calibrationOperationsFor = (client: object): InternalCalibrationOperations => {
  const operations = calibrationOperations.get(client);
  if (operations === undefined) throw new Error("Client is not a calibration client");
  return operations;
};
