import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { link, save } = require("../electron/save-file.cjs");
const sha = (bytes: Buffer | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const pdf = (text: string) => new Uint8Array(Buffer.from(`%PDF-1.7\n${text}\n%%EOF\n`));

let folder = "";
afterEach(() => { if (folder) rmSync(folder, { recursive: true, force: true }); });
function opened(text = "original") {
  folder = mkdtempSync(path.join(tmpdir(), "folio-save-"));
  const file = path.join(folder, "Doc.pdf");
  writeFileSync(file, pdf(text));
  return file;
}

describe("Save back to the opened file", () => {
  it("links only with the hash of the file's current bytes", async () => {
    const file = opened();
    expect(await link(file, sha(Buffer.from("something else")))).toBeNull();
    expect(await link(file.replace(/\.pdf$/, ".txt"), sha(readFileSync(file)))).toBeNull();
    expect(await link(file, sha(readFileSync(file)))).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("replaces the file, leaves no temporary file, and saves again after its own save", async () => {
    const file = opened();
    const ref = await link(file, sha(readFileSync(file)));
    expect(await save(ref, pdf("first"))).toEqual({ ok: true });
    expect(readFileSync(file).toString()).toContain("first");
    expect(await save(ref, pdf("second"))).toEqual({ ok: true });
    expect(readFileSync(file).toString()).toContain("second");
    expect(readdirSync(folder)).toEqual(["Doc.pdf"]);
  });

  it("asks before replacing a file another program changed, or one that was moved away", async () => {
    const file = opened();
    const ref = await link(file, sha(readFileSync(file)));
    writeFileSync(file, pdf("theirs"));
    expect(await save(ref, pdf("mine"))).toEqual({ conflict: "changed" });
    expect(readFileSync(file).toString()).toContain("theirs");
    expect(await save(ref, pdf("mine"), true)).toEqual({ ok: true });
    rmSync(file);
    expect(await save(ref, pdf("again"))).toEqual({ conflict: "missing" });
  });

  it("refuses an unknown file and bytes that aren't a PDF", async () => {
    const file = opened();
    const ref = await link(file, sha(readFileSync(file)));
    expect((await save("not-a-ref", pdf("x"))).error).toBeTruthy();
    expect((await save(ref, new Uint8Array(Buffer.from("hello")))).error).toBeTruthy();
    expect(readFileSync(file).toString()).toContain("original");
  });
});
