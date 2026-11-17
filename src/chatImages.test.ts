import { describe, expect, it } from "vitest";
import { limitImages, type ChatImage } from "./chatImages";

const png = (data: string): ChatImage => ({ mediaType: "image/png", data });

describe("limitImages", () => {
  it("keeps the newest images and leaves the text of older turns", () => {
    const messages = [
      { role: "user", content: "first", images: [png("A"), png("B")] },
      { role: "assistant", content: "ok" },
      { role: "user", content: "second", images: [png("C"), png("D")] },
    ];
    expect(limitImages(messages, 3)).toEqual([
      { role: "user", content: "first", images: [png("B")] },
      { role: "assistant", content: "ok" },
      { role: "user", content: "second", images: [png("C"), png("D")] },
    ]);
    expect(limitImages(messages, 2)[0]).toEqual({ role: "user", content: "first" });
  });

  it("drops malformed stored images", () => {
    expect(limitImages([{ content: "x", images: [{ mediaType: "image/gif", data: "Z" } as unknown as ChatImage, png("A")] }]))
      .toEqual([{ content: "x", images: [png("A")] }]);
  });
});
