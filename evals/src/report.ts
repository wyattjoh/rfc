import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { evalsDir } from "./paths";
import type { Summary } from "./summary";

const placeholder = "/*DATA*/ null";

/**
 * Renders the report template with the given runs inlined, so the HTML file
 * opens from disk with no server. With more than one run, the report shows a
 * run selector; the first run is shown by default.
 */
export const renderReport = (runs: ReadonlyArray<Summary>): string => {
  const template = readFileSync(join(evalsDir, "report", "template.html"), "utf8");
  if (!template.includes(placeholder)) throw new Error(`report template is missing ${placeholder}`);
  // `<\/` keeps a stray "</script>" inside prompt or answer text from closing the tag.
  const data = JSON.stringify({ runs }).replaceAll("</", "<\\/");
  return template.replace(placeholder, () => data);
};

/**
 * Writes the rendered report to `path`.
 */
export const writeReport = (runs: ReadonlyArray<Summary>, path: string): void => {
  writeFileSync(path, renderReport(runs));
};
