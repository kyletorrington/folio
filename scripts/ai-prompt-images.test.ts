import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

// The prompt builder runs in Electron's main process; these check the image parts each provider receives.
const require = createRequire(import.meta.url);
const { chatRequest, claudePrompt } = require("../electron/ai-prompt.cjs");

const png = (data: string) => ({ mediaType: "image/png", data });
const doc = { name: "a.pdf", text: "[Page 1]\nHi", truncated: false, recognized: false };

describe("image parts sent to providers", () => {
  const messages = [{ role: "user", content: "What is this?", images: [png("QUJD")] }];

  it("uses Responses API parts for ChatGPT", () => {
    expect(chatRequest("m", doc, messages).input[1]).toEqual({ role: "user", content: [
      { type: "input_text", text: "What is this?" }, { type: "input_image", image_url: "data:image/png;base64,QUJD" }] });
  });

  it("uses Chat Completions parts for OpenRouter and custom endpoints", () => {
    expect(chatRequest("m", doc, messages, "chat").input[1]).toEqual({ role: "user", content: [
      { type: "text", text: "What is this?" }, { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } }] });
  });

  it("sends an image on its own when there is no question text", () => {
    expect(chatRequest("m", doc, [{ role: "user", content: "", images: [png("QUJD")] }], "chat").input[1].content)
      .toEqual([{ type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } }]);
  });

  it("keeps text-only questions as plain strings", () => {
    expect(chatRequest("m", doc, [{ role: "user", content: "Hi" }], "chat").input[1]).toEqual({ role: "user", content: "Hi" });
    expect(claudePrompt(doc, [{ role: "user", content: "Hi" }]).images).toBeNull();
  });

  it("labels Claude's images in the conversation and sends them as matching blocks", () => {
    const prompt = claudePrompt(doc, [...messages, { role: "assistant", content: "A cat." }, { role: "user", content: "And this?", images: [png("REVG")] }]);
    expect(JSON.parse(prompt.input).conversation.map((m: { images?: string[] }) => m.images)).toEqual([["Image 1"], undefined, ["Image 2"]]);
    expect(prompt.input).not.toContain("QUJD");
    expect(prompt.images).toEqual([
      { type: "text", text: "Image 1" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } },
      { type: "text", text: "Image 2" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "REVG" } },
    ]);
  });
});
