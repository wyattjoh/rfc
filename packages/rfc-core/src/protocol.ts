/**
 * The version of the public JSON contracts exposed by the RFC evidence engine.
 */
export const schemaVersion = 2 as const;

/**
 * Maximum number of caller-supplied terms in one topic request.
 */
export const datatrackerTopicSearchTermLimit = 4;

/**
 * Maximum length of one caller-supplied topic term.
 */
export const datatrackerTopicSearchTermMaximumCharacters = 200;
