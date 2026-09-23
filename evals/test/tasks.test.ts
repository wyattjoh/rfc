import { describe, expect, test } from "bun:test";
import { listCohortTaskIds, listTaskIds, loadTask, parseClaims } from "../src/tasks";

describe("tasks", () => {
  test("parses numbered claims with their continuation lines and stops at notes", () => {
    const key = [
      "# q0 — example",
      "",
      "1. First claim — **RFC 1 §1**.",
      "2. Second claim spans",
      "   two lines.",
      "",
      "   Score it leniently.",
      "",
      "Note: applies to every claim.",
    ].join("\n");
    expect(parseClaims(key)).toEqual([
      "1. First claim — **RFC 1 §1**.",
      "2. Second claim spans\n   two lines.\n\n   Score it leniently.",
    ]);
  });

  test("the baseline retains its 15 tasks and 47 claims", () => {
    const ids = listCohortTaskIds("baseline");
    expect(ids[0]).toBe("q1");
    expect(ids.at(-1)).toBe("q15");
    const claims = ids.map((id) => loadTask(id).claims.length);
    expect(claims).toEqual([2, 4, 4, 3, 3, 3, 4, 2, 4, 2, 4, 3, 3, 3, 3]);
  });

  test("recorded token-exchange queries load as a separate cohort", () => {
    const ids = listCohortTaskIds("token-exchange");
    expect(ids).toEqual(["te1", "te2", "te3", "te4", "te5", "te6"]);
    expect(ids.map((id) => loadTask(id).claims.length)).toEqual([1, 2, 3, 2, 2, 2]);
    expect(listTaskIds()).toEqual([...listCohortTaskIds("baseline"), ...ids]);
  });
});
