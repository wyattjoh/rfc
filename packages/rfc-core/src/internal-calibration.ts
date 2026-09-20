import { calibrationAnswerActivation } from "./activation";
import { createRfcClient, type RfcClient, type RfcClientOptions } from "./index";

/**
 * Private calibration client that exercises the same request-local version-two
 * retrieval path as the public client while enabling measured answer outcomes.
 */
export type RfcCalibrationClient = RfcClient;

/**
 * Options for the private live-calibration client.
 */
export type RfcCalibrationClientOptions = Omit<RfcClientOptions, "automaticAnswerActivation">;

/**
 * Construct the private live-calibration client.
 *
 * @param options Live discovery, source cache, clock, and provider options.
 * @returns A version-two client with the private calibration capability.
 */
export const createRfcCalibrationClient = (
  options: RfcCalibrationClientOptions,
): Promise<RfcCalibrationClient> =>
  createRfcClient({
    ...options,
    automaticAnswerActivation: calibrationAnswerActivation,
  });
