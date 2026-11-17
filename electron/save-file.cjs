// Save writes a document back to the PDF it was opened from (Kyle, 17 Nov 2026: "a proper save button so that it
// writes straight back to the open file"). The page can only write to a file it has shown it opened: linking a
// path needs the SHA-256 of that file's current bytes, which a page cannot know for a file it never read.
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const { checkDiskPath, readRegular } = require("./document-files.cjs");

const linked = new Map(); // ref -> { file, hash }
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

async function link(file, hash) {
  if (typeof file !== "string" || !path.isAbsolute(file) || !/\.pdf$/i.test(file) || typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) return null;
  try {
    checkDiskPath(file);
    const real = await fsp.realpath(file);
    checkDiskPath(real);
    if (sha256(await readRegular(real)) !== hash) return null;
    for (const [ref, entry] of linked) if (entry.file === real) { entry.hash = hash; return ref; }
    const ref = crypto.randomUUID();
    linked.set(ref, { file: real, hash });
    return ref;
  } catch { return null; }
}

/** Replaces the file in one step (a new file renamed over it), so a crash or full disk never leaves half a PDF. */
async function save(ref, bytes, force) {
  const entry = typeof ref === "string" ? linked.get(ref) : undefined;
  if (!entry) return { error: "Folio no longer knows where this file is. Use Save a copy instead." };
  if (!(bytes instanceof Uint8Array) || Buffer.from(bytes.subarray(0, 5)).toString("latin1") !== "%PDF-") return { error: "That isn't a PDF." };
  let current = null;
  try { current = sha256(await readRegular(entry.file)); } catch (error) { if (error?.code !== "ENOENT") current = ""; }
  if (current !== entry.hash && !force) return { conflict: current === null ? "missing" : "changed" };
  const temp = path.join(path.dirname(entry.file), `.${path.basename(entry.file)}.${crypto.randomBytes(4).toString("hex")}.folio-saving`);
  try {
    await fsp.writeFile(temp, bytes, { flag: "wx" });
    await fsp.rename(temp, entry.file);
  } catch (error) {
    await fsp.rm(temp, { force: true }).catch(() => {});
    const locked = ["EPERM", "EBUSY", "EACCES"].includes(error?.code);
    return { error: locked ? "Folio couldn't write to it. If it's open in another program, close it there and try again, or use Save a copy."
      : `Folio couldn't write to it (${error?.code || error?.message || "unknown error"}). Use Save a copy instead.` };
  }
  entry.hash = sha256(bytes);
  return { ok: true };
}

function register(handle) {
  handle("folio:link-file", (_event, file, hash) => link(file, hash));
  handle("folio:save-file", (_event, ref, bytes, force) => save(ref, bytes, force === true));
}

module.exports = { register, link, save };
