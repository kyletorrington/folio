// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { findInTextLayer, splitComments } from "./aiComments";

describe("splitComments", () => {
  it("takes the comments out of a finished answer", () => {
    const answer = 'I commented on the payment terms.\n\n```folio-comments\n[{"page": 2, "quote": "within 30 days", "comment": "Too short."}]\n```';
    const { text, comments, pending } = splitComments(answer);
    expect(text).toBe("I commented on the payment terms.");
    expect(pending).toBe(false);
    expect(comments).toEqual([{ page: 2, quote: "within 30 days", comment: "Too short." }]);
  });

  it("hides a block that is still streaming", () => {
    const { text, comments, pending } = splitComments('Here you go.\n```folio-comments\n[{"page": 1, "quo');
    expect(text).toBe("Here you go.");
    expect(pending).toBe(true);
    expect(comments).toEqual([]);
  });

  it("leaves ordinary answers and code alone, and skips malformed entries", () => {
    expect(splitComments("Plain answer with ```js\ncode\n```").comments).toEqual([]);
    const { comments } = splitComments('```folio-comments\n[{"quote": "a b c", "comment": "ok"}, {"quote": 5}, "x"]\n```');
    expect(comments).toEqual([{ page: 0, quote: "a b c", comment: "ok" }]);
    expect(splitComments("```folio-comments\nnot json\n```").comments).toEqual([]);
  });
});

describe("findInTextLayer", () => {
  const layer = (...spans: string[]) => {
    const div = document.createElement("div");
    for (const text of spans) div.appendChild(Object.assign(document.createElement("span"), { textContent: text }));
    return div;
  };

  it("finds words split across lines and hyphenation, ignoring case and punctuation", () => {
    const div = layer("The Supplier shall deliver the ", "Goods with-", "in thirty (30) days of the “Order”.");
    const range = findInTextLayer(div, 'deliver the goods within thirty (30) days of the "Order"');
    expect(range?.toString()).toBe("deliver the Goods with-in thirty (30) days of the “Order");
  });

  it("falls back to the first half when the end was paraphrased", () => {
    const div = layer("This Agreement is governed by the laws of England and Wales.");
    expect(findInTextLayer(div, "governed by the laws of England, and the courts of London")?.toString())
      .toBe("governed by the laws of England");
  });

  it("returns null when the words aren't there", () => {
    expect(findInTextLayer(layer("Nothing relevant here."), "termination for convenience")).toBeNull();
  });
});
