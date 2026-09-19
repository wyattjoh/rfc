import { createRfcClient, type RfcClient, type RfcClientOptions } from "./index";
import { calibrationAnswerActivation } from "./activation";

/**
 * Construct the private live-calibration client without exposing its bypass
 * capability through the package's public entry point.
 *
 * @param options Cache, catalog, clock, and provider options for calibration.
 * @returns A Promise for a client with calibration answers enabled.
 */
export const createRfcCalibrationClient = async (
  options: Omit<RfcClientOptions, "automaticAnswerActivation">,
): Promise<RfcClient> =>
  createRfcClient({
    ...options,
    automaticAnswerActivation: calibrationAnswerActivation,
  });
