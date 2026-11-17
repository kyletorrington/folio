// Voice typing in Ask AI (Kyle, 17 Nov 2026: "include exactly that, how it is set up" in the devbox console). The page
// records with the microphone; this turns the recording into words with OpenAI's speech-to-text, the same model and
// approach as the devbox console's server/dictate.js, using an OpenAI API key kept in the system key store. The
// recording is sent to OpenAI only to be written out and is never kept, here or there.
const fs = require("node:fs");
const { secureStorageAvailable, serial } = require("./chat-completions.cjs");

const API = "https://api.openai.com/v1";
const KEY_FILE = "openai-dictation-key.bin";
const MODEL = "gpt-transcribe";
const MAX_BYTES = 24 << 20; // OpenAI takes up to 25 MB; the page stops at ten minutes (a few MB of Opus)
const TYPES = { "audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/mpeg": "mp3", "audio/wav": "wav" };

function createDictation({ net, safeStorage, file, writeAtomic }) {
  const status = () => ({ configured: fs.existsSync(file(KEY_FILE)) });
  async function credential() {
    if (!status().configured) throw Object.assign(new Error("Add an OpenAI API key for voice typing in Settings."), { code: "no_key" });
    try { return (await safeStorage.decryptStringAsync(fs.readFileSync(file(KEY_FILE)))).result; }
    catch { throw new Error("Couldn't unlock the OpenAI key. Unlock your system key store or replace the key in Settings."); }
  }
  async function request(endpoint, key, options = {}) {
    let response;
    try {
      response = await net.fetch(API + endpoint, { ...options, signal: options.signal || AbortSignal.timeout(20_000),
        credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", headers: { Authorization: "Bearer " + key } });
    } catch (error) {
      throw new Error(error?.name === "TimeoutError" ? "OpenAI took too long to answer. Try again." : "Couldn't reach OpenAI. Check your connection and try again.");
    }
    if (response.status === 401) throw new Error("OpenAI rejected this key. Check the key in Settings.");
    if (response.status === 429) throw new Error("OpenAI is rate limiting this key, or its credit has run out. Try again shortly.");
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(`OpenAI couldn't write out the recording${body?.error?.message ? `: ${String(body.error.message).slice(0, 200)}` : ` (${response.status})`}.`);
    }
    return response;
  }
  const change = serial();
  return {
    status,
    check: async () => { await request("/models", await credential()); },
    save: (input) => change(async () => {
      if (typeof input !== "string" || !/^[\x21-\x7e]{8,512}$/.test(input.trim())) throw new Error("Enter a valid OpenAI API key.");
      const key = input.trim();
      if (!(await secureStorageAvailable(safeStorage))) throw new Error("Unlock or enable your system key store to save an OpenAI key.");
      await request("/models", key);
      try { writeAtomic(KEY_FILE, await safeStorage.encryptStringAsync(key)); }
      catch { throw new Error("Couldn't save the key securely. Check your system key store and try again."); }
    }),
    remove: () => change(() => fs.rmSync(file(KEY_FILE), { force: true })),
    /** The recording as words: { ok, text } or { error, code? }. */
    async transcribe(bytes, mime, documentName) {
      const type = String(mime || "").split(";")[0].trim().toLowerCase();
      if (!TYPES[type]) return { error: "That isn't a recording Folio can read." };
      if (!(bytes instanceof Uint8Array) || !bytes.byteLength) return { error: "The recording arrived empty." };
      if (bytes.byteLength > MAX_BYTES) return { error: "That recording is too long." };
      try {
        const key = await credential();
        const form = new FormData();
        form.append("model", MODEL);
        // Spelled the way the reader would expect: the document they are asking about.
        const name = typeof documentName === "string" ? documentName.replace(/\.pdf$/i, "").slice(0, 200) : "";
        form.append("prompt", `The user is dictating a question to an AI assistant about a PDF document${name ? ` named "${name}"` : ""}, in Folio, a PDF reader.`);
        form.append("file", new Blob([bytes], { type }), "dictation." + TYPES[type]);
        const response = await request("/audio/transcriptions", key, { method: "POST", body: form, signal: AbortSignal.timeout(60_000) });
        const out = await response.json().catch(() => ({}));
        return { ok: true, text: String(out.text || "").replace(/\s+/g, " ").trim() };
      } catch (error) {
        return { error: error.message, code: error.code ?? "" };
      }
    },
  };
}

module.exports = { createDictation, MODEL };
