import { describe, expect, it } from "vitest";
import { appendWords } from "./dictation";

describe("appendWords", () => {
  it("puts dictated words at the end of the box, after a space", () => {
    expect(appendWords("", "Hello there.")).toBe("Hello there.");
    expect(appendWords("Summarize", " page two ")).toBe("Summarize page two");
    expect(appendWords("Line one\n", "line two")).toBe("Line one\nline two");
    expect(appendWords("Unchanged", "  ")).toBe("Unchanged");
  });
});
