import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { piBinary } from "./paths";
import { waitWithTimeout } from "./process";
import type { Verdict } from "./results";
import type { Task } from "./tasks";

/**
 * Judge settings.
 */
export type JudgeOptions = {
  model: string;
  thinking: string;
  timeoutMs: number;
};

/**
 * One claim's verdict with the judge's one-sentence reason and the call's cost.
 */
export type ClaimGrade = { verdict: Verdict; reason: string; cost: number };

/**
 * The prompt for grading one claim. Each claim gets its own isolated call so a
 * judgment on one claim cannot leak into another.
 */
export const judgePrompt = (task: Task, claim: number, answer: string): string =>
  [
    "You are grading one claim of an answer to a question about IETF RFCs.",
    "",
    "<question>",
    task.prompt,
    "</question>",
    "",
    "The answer key below was read from the canonical rfc-editor.org text. Its numbered items are the claims;",
    "notes outside the numbered items apply to every claim. Where the key names alternates (for example",
    '"also accepted" or "Added during grading"), each alternate counts as correct.',
    "",
    "<answer-key>",
    task.key.trim(),
    "</answer-key>",
    "",
    `Grade only claim ${claim}:`,
    "<claim>",
    task.claims[claim - 1],
    "</claim>",
    "",
    "Rules:",
    "- The claim is correct only if the answer states its value and cites an RFC and section the key accepts,",
    "  unless the key says a citation is not needed for that claim.",
    "- Require only what the question asked for. Detail the key adds as context (quoted wording, line numbers,",
    "  parenthetical explanations, related values the question did not ask about) is not required.",
    "- For a claim about which RFC is current, or which RFC obsoletes or is obsoleted by another, naming the right",
    "  RFC numbers is enough; any section or the RFC header is an acceptable citation.",
    "- A section that is the direct parent or a direct subsection of an accepted section, in the same RFC, is an",
    "  acceptable citation (for example §2.2 for §2.2.1, or §15.1 for §15). A different section or RFC is not.",
    "- A paraphrase counts when it means the same thing. Normative strength matters: SHOULD is not MUST.",
    "- An answer that declines, hedges without committing, or says it could not find the fact is incorrect.",
    "- Ignore other claims. Errors elsewhere in the answer only matter if the key says they do for this claim.",
    '- If you cannot decide from the answer and the key, use "unknown".',
    "",
    "<answer>",
    answer,
    "</answer>",
    "",
    'Reply with only a JSON object: {"verdict": "correct" | "incorrect" | "unknown", "reason": "<one sentence>"}',
  ].join("\n");

const verdicts: ReadonlyArray<Verdict> = ["correct", "incorrect", "unknown"];

/**
 * Extracts the verdict object from the judge's reply, or undefined when the
 * reply holds no valid one.
 */
export const parseVerdict = (text: string): { verdict: Verdict; reason: string } | undefined => {
  // The whole outermost {...} first, then each flat {...} group, so a reply
  // with prose braces around the verdict still parses.
  const candidates = [
    ...(/\{[\s\S]*\}/.exec(text) ?? []),
    ...[...text.matchAll(/\{[^{}]*\}/g)].map((match) => match[0]),
  ];
  for (const candidate of candidates) {
    const parsed = parseObject(candidate);
    if (parsed === undefined || !verdicts.includes(parsed.verdict as Verdict)) continue;
    return {
      verdict: parsed.verdict as Verdict,
      reason: typeof parsed.reason === "string" ? parsed.reason : "",
    };
  }
  return undefined;
};

const parseObject = (text: string): Record<string, unknown> | undefined => {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

type JsonEvent = {
  type: string;
  messages?: Array<{
    role: string;
    content?: Array<{ type: string; text?: string }>;
    usage?: { cost?: { total?: number } };
  }>;
};

/**
 * The judge's final reply text and model cost from Pi's JSON-mode output, where
 * the `agent_end` event carries the whole conversation. Lines that are not
 * valid JSON are skipped.
 */
export const finalReply = (stdout: string): { text: string; cost: number } => {
  const end = stdout
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .flatMap((line) => {
      const event = parseObject(line);
      return event === undefined ? [] : [event as JsonEvent];
    })
    .findLast((event) => event.type === "agent_end");
  const assistant = (end?.messages ?? []).filter((m) => m.role === "assistant");
  const text = (assistant.at(-1)?.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");
  const cost = assistant.reduce((sum, m) => sum + (m.usage?.cost?.total ?? 0), 0);
  return { text, cost };
};

const callJudge = async (
  options: JudgeOptions,
  prompt: string,
): Promise<{ text: string; cost: number } | undefined> => {
  const cwd = mkdtempSync(join(tmpdir(), "rfc-eval-judge-"));
  try {
    // Bun.spawn rather than Bun.$ for the hard timeout. stderr is ignored so an
    // undrained pipe can never block the judge.
    const proc = Bun.spawn(
      [
        piBinary,
        "-p",
        "--mode",
        "json",
        "-nt",
        "-ne",
        "-ns",
        "-nc",
        "-np",
        "--no-session",
        "--model",
        options.model,
        "--thinking",
        options.thinking,
        prompt,
      ],
      { cwd, stdin: "ignore", stdout: "pipe", stderr: "ignore" },
    );
    const [stdout, end] = await Promise.all([
      new Response(proc.stdout).text(),
      waitWithTimeout(proc, options.timeoutMs),
    ]);
    if (end.timedOut || end.exitCode !== 0) return undefined;
    return finalReply(stdout);
  } catch {
    // A spawn failure counts as a failed attempt; gradeClaim retries once.
    return undefined;
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
};

/**
 * Grades one claim of one answer, retrying once when the judge fails or replies
 * without a valid verdict. A second failure is recorded as `unknown`.
 */
export const gradeClaim = async (
  options: JudgeOptions,
  task: Task,
  claim: number,
  answer: string,
): Promise<ClaimGrade> => {
  const prompt = judgePrompt(task, claim, answer);
  let cost = 0;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const reply = await callJudge(options, prompt);
    cost += reply?.cost ?? 0;
    const parsed = reply === undefined ? undefined : parseVerdict(reply.text);
    if (parsed !== undefined) return { ...parsed, cost };
  }
  return { verdict: "unknown", reason: "judge failed to return a verdict twice", cost };
};
