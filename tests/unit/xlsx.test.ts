/**
 * `lib/xlsx.ts` writes the ZIP and the SpreadsheetML by hand, so it gets tested by
 * hand too. A corrupt workbook is a file the college's accounts office simply cannot
 * open, and nothing upstream would notice — the export would look like it worked.
 *
 * These tests read the bytes back: the ZIP structure, the parts an .xlsx must
 * contain, and the cell types, because "the number arrived as a number" is the
 * whole reason this exists rather than a second CSV.
 */
import { expect, test } from "vitest";
import { inflateRawSync } from "node:zlib";
import { buildXlsx, cellRef, safeSheetName } from "@/lib/xlsx";

/** Minimal ZIP reader: walk the central directory and inflate each entry. */
function readZip(buf: Buffer): Map<string, string> {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(eocd, "end-of-central-directory signature").toBeGreaterThan(-1);

  const entryCount = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);

  const entries = new Map<string, string>();
  for (let i = 0; i < entryCount; i++) {
    expect(buf.readUInt32LE(offset)).toBe(0x02014b50); // central directory header
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");

    // Jump to the local header to find where the data actually starts.
    expect(buf.readUInt32LE(localOffset)).toBe(0x04034b50);
    const localNameLength = buf.readUInt16LE(localOffset + 26);
    const localExtraLength = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;

    entries.set(name, inflateRawSync(buf.subarray(dataStart, dataStart + compressedSize)).toString("utf8"));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

const SIMPLE = () =>
  buildXlsx([
    {
      name: "Ledger",
      columns: [
        { key: "ref", header: "Reference", type: "text" },
        { key: "amount", header: "Amount", type: "money" },
        { key: "count", header: "Count", type: "number" },
        { key: "when", header: "Date", type: "date" },
        { key: "paid", header: "Paid" },
        { key: "note", header: "Note", type: "text" },
      ],
      rows: [
        { ref: "RB-0001", amount: 12345600, count: 3, when: new Date("2026-11-27T00:00:00Z"), paid: true, note: 'a, "b" & <c>' },
        { ref: "RB-0002", amount: 0, count: 0, when: null, paid: false, note: null },
      ],
    },
  ]);

test("produces a readable ZIP with every part an .xlsx needs", () => {
  const entries = readZip(SIMPLE());
  for (const part of [
    "[Content_Types].xml",
    "_rels/.rels",
    "xl/workbook.xml",
    "xl/_rels/workbook.xml.rels",
    "xl/styles.xml",
    "xl/worksheets/sheet1.xml",
  ]) {
    expect(entries.has(part), `missing ${part}`).toBe(true);
  }
});

test("money is written as a number in rupees, not a formatted string", () => {
  const sheet = readZip(SIMPLE()).get("xl/worksheets/sheet1.xml")!;
  // 12345600 paise is ₹1,23,456 — the cell holds 123456, and the ₹ comes from the format.
  expect(sheet).toContain("<v>123456</v>");
  expect(sheet).not.toContain("₹1,23,456");
  expect(readZip(SIMPLE()).get("xl/styles.xml")).toContain("#,##,##0.00");
});

test("dates become Excel serials, booleans become booleans", () => {
  const sheet = readZip(SIMPLE()).get("xl/worksheets/sheet1.xml")!;
  // 2026-11-27 is 46353 days after 1899-12-30.
  expect(sheet).toContain("<v>46353</v>");
  expect(sheet).toContain('t="b"><v>1</v>');
  expect(sheet).toContain('t="b"><v>0</v>');
});

test("XML-significant characters in free text are escaped, not dropped", () => {
  const sheet = readZip(SIMPLE()).get("xl/worksheets/sheet1.xml")!;
  expect(sheet).toContain("a, &quot;b&quot; &amp; &lt;c&gt;");
});

test("control characters are stripped — one would make Excel refuse the file", () => {
  const buf = buildXlsx([{
    name: "S",
    columns: [{ key: "a", header: "A", type: "text" }],
    // \x07 is a real thing to find in text pasted from a phone keyboard.
    rows: [{ a: "before\x07after" }],
  }]);
  const sheet = readZip(buf).get("xl/worksheets/sheet1.xml")!;
  expect(sheet).toContain("beforeafter");
  expect(sheet).not.toContain("\x07");
});

test("null, undefined and empty values produce no cell at all", () => {
  const sheet = readZip(SIMPLE()).get("xl/worksheets/sheet1.xml")!;
  // Row 3 is RB-0002: `when` and `note` are null, so D3 and F3 must not exist.
  expect(sheet).not.toContain('r="D3"');
  expect(sheet).not.toContain('r="F3"');
  expect(sheet).toContain('r="A3"');
});

test("a workbook can carry several sheets, each with its own columns", () => {
  const entries = readZip(buildXlsx([
    { name: "One", columns: [{ key: "a", header: "A" }], rows: [{ a: 1 }] },
    { name: "Two", columns: [{ key: "b", header: "B" }], rows: [{ b: 2 }] },
    { name: "Three", columns: [{ key: "c", header: "C" }], rows: [] },
  ]));
  expect(entries.has("xl/worksheets/sheet3.xml")).toBe(true);
  expect(entries.get("xl/workbook.xml")).toContain('name="Three"');
  expect(entries.get("xl/_rels/workbook.xml.rels")).toContain('Target="worksheets/sheet3.xml"');
  // The styles relationship must come after the sheets, or Excel loses the formats.
  expect(entries.get("xl/_rels/workbook.xml.rels")).toContain('Id="rId4"');
});

test("sheet names are trimmed to what Excel accepts", () => {
  expect(safeSheetName("Line items")).toBe("Line items");
  expect(safeSheetName("Budget: Tech/Sound [2026]")).toBe("Budget  Tech Sound  2026");
  expect(safeSheetName("x".repeat(40))).toHaveLength(31);
  expect(safeSheetName("///", "Fallback")).toBe("Fallback");
});

test("column references run past Z the way spreadsheets do", () => {
  expect(cellRef(0, 0)).toBe("A1");
  expect(cellRef(25, 0)).toBe("Z1");
  expect(cellRef(26, 1)).toBe("AA2");
  expect(cellRef(51, 9)).toBe("AZ10");
  expect(cellRef(52, 0)).toBe("BA1");
});

test("an empty sheet is still a valid workbook", () => {
  const entries = readZip(buildXlsx([{ name: "Empty", columns: [{ key: "a", header: "A" }], rows: [] }]));
  const sheet = entries.get("xl/worksheets/sheet1.xml")!;
  expect(sheet).toContain('<t>A</t>');
  expect(sheet).toContain('<autoFilter ref="A1:A1"/>');
});

test("a workbook with no sheets is a programming error, not an empty file", () => {
  expect(() => buildXlsx([])).toThrow(/at least one sheet/);
});
