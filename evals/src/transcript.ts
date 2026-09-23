import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Content = { type: string; text?: string; name?: string; arguments?: unknown };
type Message = {
  role: string;
  content?: Array<Content>;
  toolName?: string;
  usage?: { cost?: { total?: number } };
  details?: {
    structuredContent?: { diagnostics?: { inputCost?: { estimatedUsd?: number } } };
  };
};
type Entry = { timestamp?: string; message?: Message };
type Timed = { timestamp: string; message: Message };

/**
 * Measurements of one trial, all on the same basis for both arms.
 */
export type TrialMetrics = {
  /**
   * Seconds from the prompt to the final answer.
   */
  lat: number;
  /**
   * Tool calls made before the answer.
   */
  calls: number;
  /**
   * KB (UTF-8) of tool-result text placed in the agent's context.
   */
  out: number;
  /**
   * Model cost in USD, as reported by Pi.
   */
  cost: number;
  /**
   * TypeSafe input-token charge in USD, summed from `rfc_*` tool diagnostics.
   */
  ts: number;
  /**
   * Tool names in call order.
   */
  tools: ReadonlyArray<string>;
};

const parseLine = (line: string): Array<Entry> => {
  try {
    return [JSON.parse(line) as Entry];
  } catch {
    return [];
  }
};

/**
 * Parses a Pi session JSONL file into entries. Lines that are not valid JSON,
 * such as a last line cut short when a timed-out trial was killed, are skipped.
 */
export const parseSession = (jsonl: string): Array<Entry> =>
  jsonl
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .flatMap(parseLine);

/**
 * Reads the session JSONL Pi wrote into `sessionDir`, if any.
 */
export const readSession = (sessionDir: string): Array<Entry> | undefined => {
  if (!existsSync(sessionDir)) return undefined;
  const file = readdirSync(sessionDir).find((name) => name.endsWith(".jsonl"));
  return file === undefined
    ? undefined
    : parseSession(readFileSync(join(sessionDir, file), "utf8"));
};

const textOf = (message: Message): string =>
  (message.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("")
    .trim();

const timedMessages = (entries: ReadonlyArray<Entry>): Array<Timed> =>
  entries.filter((e): e is Timed => e.timestamp !== undefined && e.message !== undefined);

// The answer is the first assistant text after the last tool result.
// pi-web-access can inject a "content ready" message after the agent has
// answered, which triggers an extra turn; that turn is excluded.
const answerIndex = (messages: ReadonlyArray<Timed>): number => {
  const lastResult = messages.findLastIndex((e) => e.message.role === "toolResult");
  return messages.findIndex(
    (e, i) => i > lastResult && e.message.role === "assistant" && textOf(e.message).length > 0,
  );
};

/**
 * The agent's final answer, or undefined when it never answered.
 */
export const extractAnswer = (entries: ReadonlyArray<Entry>): string | undefined => {
  const messages = timedMessages(entries);
  const index = answerIndex(messages);
  return index === -1 ? undefined : textOf(messages[index]!.message);
};

/**
 * Every tool call's name and arguments, in order, for reading a transcript.
 */
export const extractToolCalls = (
  entries: ReadonlyArray<Entry>,
): Array<{ name: string; arguments: unknown }> =>
  timedMessages(entries).flatMap((e) =>
    e.message.role !== "assistant"
      ? []
      : (e.message.content ?? [])
          .filter((c) => c.type === "toolCall")
          .map((c) => ({ name: c.name ?? "", arguments: c.arguments })),
  );

const round = (value: number, digits: number): number => Number(value.toFixed(digits));

/**
 * Measures a trial up to its answer. A trial without an answer is measured to
 * its last message, so failed trials still show the time and tokens they used.
 */
export const measure = (entries: ReadonlyArray<Entry>): TrialMetrics | undefined => {
  const messages = timedMessages(entries);
  const first = messages.find((e) => e.message.role === "user");
  const index = answerIndex(messages);
  const endIndex = index === -1 ? messages.length - 1 : index;
  const last = messages[endIndex];
  if (first === undefined || last === undefined) return undefined;
  const upToAnswer = messages.slice(0, endIndex + 1);
  const results = upToAnswer.filter((e) => e.message.role === "toolResult");
  const bytes = results.reduce(
    (sum, e) =>
      sum +
      (e.message.content ?? []).reduce((total, c) => total + Buffer.byteLength(c.text ?? ""), 0),
    0,
  );
  const ts = results.reduce(
    (sum, e) =>
      (e.message.toolName ?? "").startsWith("rfc_")
        ? sum + (e.message.details?.structuredContent?.diagnostics?.inputCost?.estimatedUsd ?? 0)
        : sum,
    0,
  );
  const cost = upToAnswer.reduce((sum, e) => sum + (e.message.usage?.cost?.total ?? 0), 0);
  return {
    lat: round((Date.parse(last.timestamp) - Date.parse(first.timestamp)) / 1000, 1),
    calls: results.length,
    out: round(bytes / 1000, 1),
    cost: round(cost, 4),
    ts: round(ts, 6),
    tools: results.map((e) => e.message.toolName ?? ""),
  };
};
