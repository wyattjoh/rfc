declare const automaticAnswerActivationBrand: unique symbol;

/**
 * Opaque capability required before a normal client can return `answered`.
 */
export type AutomaticAnswerActivation = {
  readonly [automaticAnswerActivationBrand]: "accepted";
};

const authorizedActivations = new WeakSet<object>();

const makeActivation = (): AutomaticAnswerActivation => {
  const activation = Object.freeze({});
  authorizedActivations.add(activation);
  return activation as AutomaticAnswerActivation;
};

/**
 * Create an activation capability for a validated release artifact.
 *
 * @returns A runtime-registered opaque capability.
 */
export const makeArtifactActivation = (): AutomaticAnswerActivation => makeActivation();

/**
 * The private capability used only by the live calibration workflow.
 */
export const calibrationAnswerActivation = makeActivation();

/**
 * Check the runtime identity of an activation capability.
 *
 * @param value Unknown public-boundary input.
 * @returns Whether the value was created by this module.
 */
export const isAutomaticAnswerActivation = (value: unknown): value is AutomaticAnswerActivation =>
  typeof value === "object" && value !== null && authorizedActivations.has(value);
