import assert from "node:assert/strict";
import http from "node:http";
import { PDFDocument } from "pdf-lib";

// Ask AI adds comments: a local endpoint answers with a folio-comments block, and Folio highlights each quote with
// the comment as its note. One quote names the wrong page, one has different punctuation, one isn't in the document.
export async function checkAiComments(app, page) {
  const block = JSON.stringify([
    { page: 1, quote: "The ferry leaves at dawn", comment: "Check the timetable." },
    { page: 2, quote: "Tickets, cost five pounds", comment: "Price may be out of date." },
    { page: 2, quote: "words that are nowhere in it", comment: "Should not be placed." },
  ]);
  const answer = "I added three comments.\n\n```folio-comments\n" + block + "\n```";
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ data: [{ id: "harbor-large" }] }));
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      // Streamed in pieces, so the half-written block is hidden while it arrives.
      const pieces = answer.match(/[\s\S]{1,40}/g);
      res.end(pieces.map((text) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`).join("") + "data: [DONE]\n\n");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const host = `folio-local.test:${server.address().port}`;

  const pdf = await PDFDocument.create();
  pdf.addPage([480, 520]).drawText("Harbor notes", { x: 38, y: 435, size: 28 });
  const second = pdf.addPage([480, 520]);
  second.drawText("The ferry leaves at dawn.", { x: 38, y: 435, size: 20 });
  second.drawText("Tickets cost five pounds each.", { x: 38, y: 395, size: 20 });
  const bytes = Buffer.from(await pdf.save()).toString("base64");
  await app.evaluate(({ webContents, safeStorage, dialog }, bytes) => {
    const target = webContents.getAllWebContents().find((c) => c.getURL().startsWith("app://folio/"));
    const methods = ["isAsyncEncryptionAvailable", "encryptStringAsync", "decryptStringAsync"];
    if (process.platform === "linux") methods.push("getSelectedStorageBackend");
    const original = Object.fromEntries(methods.map((name) => [name, safeStorage[name]]));
    safeStorage.isAsyncEncryptionAvailable = async () => true;
    if (process.platform === "linux") safeStorage.getSelectedStorageBackend = () => "gnome_libsecret";
    safeStorage.encryptStringAsync = async (value) => Buffer.from(value).map((b) => b ^ 128);
    safeStorage.decryptStringAsync = async (bytes) => ({ result: Buffer.from(bytes).map((b) => b ^ 128).toString() });
    const ask = dialog.showMessageBox;
    dialog.showMessageBox = async () => ({ response: 0 });
    globalThis.commentsTest = { restore: () => { Object.assign(safeStorage, original); dialog.showMessageBox = ask; } };
    target.send("folio:open-file", { name: "Harbor notes.pdf", data: Buffer.from(bytes, "base64") });
  }, bytes);
  try {
    await page.window.waitForFunction(() => document.title.startsWith("Harbor notes.pdf"));
    const panel = page.getByRole("complementary", { name: "Ask AI" });
    if (!(await panel.count())) await page.getByRole("button", { name: "Ask AI", exact: true }).click();
    await panel.getByRole("combobox", { name: "AI provider" }).selectOption("custom");
    await panel.getByRole("button", { name: "Open Ask AI settings" }).click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    await settings.getByLabel("Base URL").fill(`http://${host}/v1/`);
    await settings.getByRole("button", { name: "Connect" }).click();
    await settings.getByRole("button", { name: /harbor-large/ }).click();
    await settings.getByRole("button", { name: "Close" }).click();

    await panel.getByRole("textbox").fill("Add comments on the ferry and the ticket price");
    await panel.getByRole("button", { name: "Send", exact: true }).click();
    await panel.getByText("Added 2 comments · 1 not found").waitFor({ timeout: 30_000 });
    assert.equal(await panel.getByText("folio-comments").count(), 0, "the raw comments block is shown in the chat");
    await panel.getByText("I added three comments.").waitFor();
    await panel.getByText("Couldn't find these words").waitFor();

    // Each placed comment is a highlight on the right words of page 2, with the comment as its note.
    await page.getByRole("tab", { name: /Notes/ }).click();
    for (const [quote, comment] of [["The ferry leaves at dawn", "Check the timetable."], ["Tickets cost five pounds", "Price may be out of date."]]) {
      const card = page.locator(".mark-card").filter({ hasText: quote });
      await card.waitFor();
      assert.match(await card.locator(".mark-page").innerText(), /p\. 2/);
      assert.equal(await card.getByRole("textbox", { name: "Note" }).inputValue(), comment);
    }
    assert.equal(await page.locator(".mark-card").count(), 2);
    assert.equal(await page.locator(".highlightEditor").count(), 2);

    // Clicking a comment in the chat shows it on the page.
    await page.evaluate(() => { document.querySelector(".pdfViewer").parentElement.scrollTop = 0; });
    await panel.locator(".ai-comment").filter({ hasText: "Check the timetable." }).click();
    await page.waitForFunction(() => document.querySelector('[aria-label="Page number"]').value === "2");
    await page.waitForTimeout(400);
    await page.screenshot({ path: "release/smoke/ai-comments.png" });

    await panel.getByRole("button", { name: "harbor-large", exact: true }).click();
    await settings.getByRole("button", { name: "Change endpoint" }).click();
    await settings.getByRole("button", { name: "Remove endpoint" }).click();
    await settings.getByLabel("Ask AI provider").selectOption("chatgpt");
    await settings.getByRole("button", { name: "Close" }).click();
    await page.getByRole("tablist", { name: "Open documents" }).getByRole("button", { name: "Close Harbor notes.pdf" }).click();
    console.log("ok  Ask AI comments: quotes found across pages and punctuation, comments attached, missing ones listed, click reveals");
  } finally {
    await app.evaluate(() => { globalThis.commentsTest.restore(); delete globalThis.commentsTest; });
    server.close();
    server.closeAllConnections();
  }
}
