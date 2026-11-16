import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { adobeCommentedPdf } from "./pdf-notes-fixture.mjs";

// Notes already in a PDF (added in Adobe Acrobat, by someone else, or saved by Folio) show up in Folio, and notes
// saved by Folio are ordinary PDF comments that other apps show. The round trip: open a PDF commented in Adobe,
// edit its note, add a highlight with a note, save a copy, reopen the copy, delete a highlight, save again.
export async function checkPdfNotes(app, page, folder) {
  const open = async (name, bytes) => {
    await app.evaluate(({ webContents }, { name, b64 }) => {
      const target = webContents.getAllWebContents().find((c) => c.getURL().startsWith("app://folio/"));
      target.send("folio:open-file", { name, data: Buffer.from(b64, "base64") });
    }, { name, b64: Buffer.from(bytes).toString("base64") });
    await page.window.waitForFunction((name) => document.title.startsWith(name), name);
    await page.locator(".textLayer span:not(.markedContent)").first().waitFor({ timeout: 30_000 });
  };
  const close = async (name) => {
    await page.getByRole("tablist", { name: "Open documents" }).getByRole("button", { name: `Close ${name}` }).click();
  };
  const saveCopy = async (file) => {
    await app.evaluate(({ session }, file) => {
      globalThis.notesCopySaved = new Promise((resolve) => session.defaultSession.once("will-download", (_event, item) => {
        item.setSavePath(file);
        item.once("done", (_done, state) => resolve(state));
      }));
    }, file);
    await page.keyboard.press("ControlOrMeta+s");
    assert.equal(await app.evaluate(() => globalThis.notesCopySaved), "completed");
    return readFileSync(file);
  };
  // What another PDF app sees in a saved copy.
  const annotationsIn = (bytes) => page.evaluate(async (bytes) => {
    const task = pdfjsLib.getDocument({ data: Uint8Array.from(bytes) });
    try {
      const pdf = await task.promise;
      return (await (await pdf.getPage(1)).getAnnotations()).filter((a) => a.subtype !== "Popup").map((a) => ({
        id: a.id, subtype: a.subtype, note: a.contentsObj?.str ?? "", author: a.titleObj?.str ?? "", replyTo: a.inReplyTo ?? null,
        popup: !!a.popupRef,
      }));
    } finally { await task.destroy(); }
  }, Array.from(bytes));
  const notesTab = async () => {
    const tab = page.getByRole("tab", { name: /Notes/ });
    if ((await tab.getAttribute("aria-selected")) !== "true") await tab.click();
  };
  const peek = page.locator(".note-peek");
  const hoverText = async (words) => {
    const point = await page.evaluate((words) => {
      const span = [...document.querySelectorAll(".textLayer span")].find((s) => s.textContent.includes(words));
      const range = document.createRange();
      const at = span.firstChild.textContent.indexOf(words);
      range.setStart(span.firstChild, at);
      range.setEnd(span.firstChild, at + words.length);
      const r = range.getBoundingClientRect();
      const frame = window.frameElement?.getBoundingClientRect() ?? { left: 0, top: 0 };
      return { x: frame.left + r.left + r.width / 2, y: frame.top + r.top + r.height / 2 };
    }, words);
    await page.mouse.move(point.x, point.y);
  };
  const away = async () => { await page.mouse.move(5, 5); await peek.waitFor({ state: "detached" }); };

  // ── A PDF commented in Adobe ──
  await open("Lease.pdf", await adobeCommentedPdf());
  await notesTab();
  await page.getByText("1 highlight · 2 comments").waitFor({ timeout: 15_000 });
  const highlightCard = page.locator(".mark-card:not(.other-card)");
  assert.equal(await highlightCard.count(), 1);
  assert.match(await highlightCard.innerText(), /Rent is due[\s\S]*Alex Adobe[\s\S]*Sam Reviewer[\s\S]*Agreed, it moved to the 5th\./);
  assert.equal(await highlightCard.getByRole("textbox", { name: "Note" }).inputValue(), "Check the date with the landlord.");
  const others = page.locator(".other-card");
  assert.deepEqual((await others.allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim()),
    ["p. 1Sticky note Sam Reviewer Who signs for the tenant?", "p. 1two months Jo Lawyer Too high for this area."]);
  // Folio draws the highlight (once: pdf.js doesn't draw the original as well); the reply isn't an icon of its own.
  assert.equal(await page.locator(".highlightEditor").count(), 1);
  assert.equal(await page.locator(".annotationLayer section.textAnnotation:not([hidden])").count(), 1);

  // Hovering shows each note over the page: the highlight's with its reply, and the read-only ones without Edit.
  await hoverText("Rent is due");
  await peek.filter({ hasText: "Check the date with the landlord." }).filter({ hasText: "Agreed, it moved to the 5th." }).waitFor();
  assert.equal(await peek.getByRole("button", { name: "Edit" }).count(), 1);
  await away();
  await hoverText("two months");
  await peek.filter({ hasText: "Too high for this area." }).filter({ hasText: "Jo Lawyer" }).waitFor();
  assert.equal(await peek.getByRole("button", { name: "Edit" }).count(), 0);
  await away();
  const sticky = await page.locator(".annotationLayer section.textAnnotation:not([hidden])").boundingBox();
  await page.mouse.move(sticky.x + sticky.width / 2, sticky.y + sticky.height / 2);
  await peek.filter({ hasText: "Who signs for the tenant?" }).waitFor();
  await page.waitForTimeout(150);
  await page.screenshot({ path: "release/smoke/pdf-notes.png" });
  await away();
  assert.equal(await page.locator(".popupAnnotation:not([hidden])").count(), 0, "pdf.js's own pop-up opened too");
  assert.equal(await page.locator(".folio-note-marker").count(), 2, "an icon for the highlight's note and the underline's");

  // Edit the Adobe note, and add a highlight with a note of our own.
  const noteBox = highlightCard.getByRole("textbox", { name: "Note" });
  await noteBox.fill("Rent is due on the 5th now.");
  await noteBox.blur();
  await page.locator(".textLayer span").filter({ hasText: "The deposit is" }).first().evaluate((span) => {
    const range = document.createRange();
    range.selectNodeContents(span);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });
  await page.locator(".selection-popover").waitFor();
  await page.getByRole("button", { name: "Highlight yellow" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".highlightEditor").length === 2, null, { timeout: 15_000 });
  const mine = page.locator(".mark-card:not(.other-card)").filter({ hasText: "The deposit is" });
  await mine.getByRole("textbox", { name: "Note" }).fill("Ask for one month.");
  await mine.getByRole("textbox", { name: "Note" }).blur();
  await page.waitForTimeout(700);

  // The saved copy is an ordinary commented PDF: the original highlight was updated in place (same author, the
  // reply still attached), ours was added, and the sticky note and underline are untouched.
  const copy = await saveCopy(path.join(folder, "Lease copy.pdf"));
  const saved = await annotationsIn(copy);
  const highlights = saved.filter((a) => a.subtype === "Highlight");
  assert.equal(highlights.length, 2);
  const theirs = highlights.find((a) => a.author === "Alex Adobe");
  assert.equal(theirs?.note, "Rent is due on the 5th now.");
  assert.ok(theirs.popup);
  assert.equal(highlights.find((a) => a !== theirs).note, "Ask for one month.");
  assert.equal(saved.find((a) => a.note === "Agreed, it moved to the 5th.")?.replyTo, theirs.id, "the reply lost its highlight");
  assert.ok(saved.some((a) => a.subtype === "Text" && a.note === "Who signs for the tenant?"));
  assert.ok(saved.some((a) => a.subtype === "Underline" && a.note === "Too high for this area."));
  assert.equal(saved.length, 5);
  await close("Lease.pdf");

  // ── The saved copy, reopened: everything is back as it was ──
  await open("Lease copy.pdf", copy);
  await notesTab();
  await page.getByText("2 highlights · 2 comments").waitFor({ timeout: 15_000 });
  const cards = page.locator(".mark-card:not(.other-card)");
  assert.deepEqual(await cards.getByRole("textbox", { name: "Note" }).evaluateAll((els) => els.map((e) => e.value)),
    ["Rent is due on the 5th now.", "Ask for one month."]);
  assert.match(await cards.first().innerText(), /Alex Adobe[\s\S]*Agreed, it moved to the 5th\./);
  assert.equal(await page.locator(".highlightEditor").count(), 2);
  assert.equal(await page.locator(".folio-note-marker").count(), 3);
  await hoverText("Rent is due");
  await peek.filter({ hasText: "Rent is due on the 5th now." }).waitFor();
  await away();

  // Deleting a highlight that came from the PDF deletes it (and the replies to it) from the next copy.
  await cards.first().getByRole("button", { name: "Delete highlight" }).click();
  await page.getByText("1 highlight · 2 comments").waitFor();
  const second = await annotationsIn(await saveCopy(path.join(folder, "Lease copy 2.pdf")));
  assert.deepEqual(second.filter((a) => a.subtype === "Highlight").map((a) => a.note), ["Ask for one month."]);
  assert.ok(!second.some((a) => a.note === "Agreed, it moved to the 5th."), "the reply outlived its highlight");
  assert.equal(second.length, 3);
  await close("Lease copy.pdf");
  console.log("ok  notes in a PDF: Adobe highlights, sticky notes, replies and authors shown; edits and deletes saved in place; saved copies reopen with their notes");
}
