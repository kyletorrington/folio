import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { adobeCommentedPdf } from "./pdf-notes-fixture.mjs";

// Save writes back to the PDF a document was opened from: notes go into that file, a change made by another program
// is asked about before it is replaced, and a document without a file still only offers Save a copy.
export async function checkSaveFile(app, page, folder) {
  const file = path.join(folder, "Save in place.pdf");
  // Distinct bytes, so nothing Folio stored for the same fixture in another check applies here.
  writeFileSync(file, Buffer.concat([Buffer.from(await adobeCommentedPdf()), Buffer.from("\n% save in place\n")]));
  const annotationsIn = (bytes) => page.evaluate(async (bytes) => {
    const task = pdfjsLib.getDocument({ data: Uint8Array.from(bytes) });
    try {
      const pdf = await task.promise;
      return (await (await pdf.getPage(1)).getAnnotations()).filter((a) => a.subtype === "Highlight").map((a) => a.contentsObj?.str ?? "");
    } finally { await task.destroy(); }
  }, Array.from(bytes));
  const saved = async (before) => {
    for (let i = 0; i < 100 && readFileSync(file).equals(before); i++) await page.waitForTimeout(100);
    return readFileSync(file);
  };

  // Opened the way Explorer opens it: the shell sends the bytes and where they came from.
  await app.evaluate(({ webContents }, { file, b64 }) => {
    const target = webContents.getAllWebContents().find((c) => c.getURL().startsWith("app://folio/"));
    target.send("folio:open-file", { name: "Save in place.pdf", data: Buffer.from(b64, "base64"), path: file });
  }, { file, b64: readFileSync(file).toString("base64") });
  await page.window.waitForFunction(() => document.title.startsWith("Save in place.pdf"));
  const save = page.getByRole("button", { name: "Save", exact: true });
  await save.waitFor({ timeout: 15_000 });
  const tab = page.getByRole("tab", { name: /Notes/ });
  if ((await tab.getAttribute("aria-selected")) !== "true") await tab.click();
  const note = page.locator(".mark-card:not(.other-card)").getByRole("textbox", { name: "Note" });
  await note.fill("Saved straight into the file.");
  await note.blur();
  await page.waitForTimeout(700);
  const original = readFileSync(file);
  await page.keyboard.press("ControlOrMeta+s");
  const first = await saved(original);
  assert.ok(first.subarray(0, 5).toString("latin1") === "%PDF-");
  assert.deepEqual(await annotationsIn(first), ["Saved straight into the file."]);
  // The saved file is what is open now, still linked, with its note read back from the PDF.
  await page.getByText("Saved “Save in place.pdf”").waitFor();
  await save.waitFor();
  assert.equal(await note.inputValue(), "Saved straight into the file.");

  // Another program changes the file: Save asks, and saying no leaves that program's version alone.
  const theirs = Buffer.concat([first, Buffer.from("\n% changed elsewhere\n")]);
  writeFileSync(file, theirs);
  await note.fill("Second edit.");
  await note.blur();
  await page.waitForTimeout(700);
  let asked = "";
  page.window.once("dialog", (dialog) => { asked = dialog.message(); void dialog.dismiss(); });
  await save.click();
  for (let i = 0; i < 50 && !asked; i++) await page.waitForTimeout(100);
  assert.match(asked, /was changed by another program/);
  await page.waitForTimeout(300);
  assert.ok(readFileSync(file).equals(theirs));
  page.window.once("dialog", (dialog) => void dialog.accept());
  await save.click();
  assert.deepEqual(await annotationsIn(await saved(theirs)), ["Second edit."]);

  // The menu offers both; a copy is still a download.
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: /^Save a copy/ }).waitFor();
  await page.getByRole("menuitem", { name: /^Save\b(?! a copy)/ }).waitFor();
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+w");
  await page.window.waitForFunction(() => !document.title.startsWith("Save in place.pdf"));
  console.log("ok  Save writes notes back to the opened PDF, asks before replacing a file changed elsewhere, and keeps Save a copy");
}
