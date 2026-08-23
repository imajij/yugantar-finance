/** PRD 12 — the CSV writer. Quoting is the whole job; get it wrong and every later column shifts. */
import { expect, test } from "vitest";
import { csv } from "@/lib/services/exports";

test("a description containing a comma stays in one column", () => {
  const out = csv([{ human_id: "RB-0001", description: "Cables, adapters and tape", amount: "250.00" }]);
  expect(out.split("\r\n")[1]).toBe('RB-0001,"Cables, adapters and tape",250.00');
});

test("quotes are doubled, not dropped", () => {
  const out = csv([{ note: 'He said "urgent"' }]);
  expect(out.split("\r\n")[1]).toBe('"He said ""urgent"""');
});

test("newlines inside a field are quoted so the row count stays right", () => {
  const out = csv([{ note: "line one\nline two" }]);
  expect(out.split("\r\n")).toHaveLength(2);
});

test("null and undefined become empty, not the strings", () => {
  expect(csv([{ a: null, b: undefined, c: 0 }]).split("\r\n")[1]).toBe(",,0");
});

test("no rows means no headers either", () => {
  expect(csv([])).toBe("");
});
