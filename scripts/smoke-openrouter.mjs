import assert from "node:assert/strict";
import { PDFDocument } from "pdf-lib";

// Use only a synthetic PDF, key, and local responses. The production IPC, stream reader and citations run as usual.
export async function checkOpenRouter(app, page) {
  const pdf = await PDFDocument.create();
  pdf.addPage([480, 520]).drawText("Field notes", { x: 38, y: 435, size: 28 });
  pdf.addPage([480, 520]).drawText("Terns nest along the coast.", { x: 38, y: 435, size: 20 });
  const bytes = Buffer.from(await pdf.save()).toString("base64");
  await app.evaluate(({ webContents, net, safeStorage }, bytes) => {
    const target = webContents.getAllWebContents().find(c => c.getURL().startsWith("app://folio/"));
    const fetch = net.fetch;
    const methods = ["isAsyncEncryptionAvailable", "encryptStringAsync", "decryptStringAsync"];
    if (process.platform === "linux") methods.push("getSelectedStorageBackend");
    const original = Object.fromEntries(methods.map(name => [name, safeStorage[name]]));
    safeStorage.isAsyncEncryptionAvailable = async () => true;
    if (process.platform === "linux") safeStorage.getSelectedStorageBackend = () => "gnome_libsecret";
    safeStorage.encryptStringAsync = async value => Buffer.from(value).map(b => b ^ 128);
    safeStorage.decryptStringAsync = async bytes => ({ result: Buffer.from(bytes).map(b => b ^ 128).toString() });
    const state = globalThis.routerTest = { calls: [], cancelled: false, hold: false };
    net.fetch = async (url, options) => {
      if (!String(url).startsWith("https://openrouter.ai/")) return fetch.call(net, url, options);
      const endpoint = new URL(url).pathname;
      state.calls.push(endpoint);
      if (options.headers.Authorization !== "Bearer fixture-only-openrouter-key") return Response.json({ error: {} }, { status: 401 });
      if (endpoint === "/api/v1/key") return Response.json({ data: { label: "Test" } });
      if (endpoint === "/api/v1/models") return Response.json({ data: [
        { id: "sample/reader", name: "Sample Reader", context_length: 131072, architecture: { input_modalities: ["text"], output_modalities: ["text"] } },
        { id: "sample/small", name: "Sample Small", context_length: 8192, architecture: { input_modalities: ["text"], output_modalities: ["text"] } },
      ] });
      if (endpoint !== "/api/v1/chat/completions") throw new Error("Unexpected OpenRouter endpoint");
      state.request = JSON.parse(options.body);
      if (state.hold) return new Response(new ReadableStream({ start(controller) {
        options.signal.addEventListener("abort", () => { state.cancelled = true; controller.error(new Error("Stopped")); }, { once: true });
      } }));
      return new Response('data: {"choices":[{"delta":{"content":"Terns nest along the coast "}}]}\n\n'
        + 'data: {"choices":[{"delta":{"content":"(p. 2)."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    };
    state.restore = () => { net.fetch = fetch; Object.assign(safeStorage, original); };
    target.send("folio:open-file", { name: "Field notes.pdf", data: Buffer.from(bytes, "base64") });
  }, bytes);
  try {
    await page.window.waitForFunction(() => document.title.startsWith("Field notes.pdf"));
    await page.getByRole("button", { name: "Ask AI", exact: true }).click();
    const panel = page.getByRole("complementary", { name: "Ask AI" });
    const provider = panel.getByRole("combobox", { name: "AI provider" });
    await provider.selectOption("openrouter");
    await panel.getByRole("button", { name: "Open Ask AI settings" }).click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    assert.equal(await settings.getByRole("button", { name: "Ask AI", exact: true }).getAttribute("aria-current"), "page");
    assert.deepEqual(await app.evaluate(() => globalThis.routerTest.calls), []);
    await settings.getByLabel("API key", { exact: true }).fill("fixture-only-openrouter-key");
    await settings.getByRole("button", { name: "Verify and save" }).click();
    const filter = settings.getByRole("searchbox", { name: "Model" });
    await filter.fill("reader");
    await settings.getByRole("button", { name: /Sample Reader/ }).click();
    assert.deepEqual(await app.evaluate(() => globalThis.routerTest.calls), ["/api/v1/key", "/api/v1/models"]);
    await settings.getByRole("button", { name: "Close" }).click();
    await panel.getByRole("textbox").fill("Where do terns nest?");
    await panel.getByRole("button", { name: "Send", exact: true }).click();
    await panel.getByRole("button", { name: "(p. 2)" }).click();
    await page.waitForFunction(() => document.querySelector('[aria-label="Page number"]').value === "2");
    const request = await app.evaluate(() => globalThis.routerTest.request);
    assert.equal(request.model, "sample/reader");
    assert.match(JSON.parse(request.messages[1].content).document.text, /\[Page 2\]/);
    // Images: chosen from a file, pasted, and dropped on the panel (not opened as a document), then sent as image parts.
    const png = await panel.getByRole("textbox").evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 8;
      canvas.getContext("2d").fillRect(0, 0, 4, 4);
      return canvas.toDataURL("image/png").split(",")[1];
    });
    await panel.locator('input[type="file"]').setInputFiles({ name: "chosen.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
    const attached = panel.getByRole("list", { name: "Attached images" });
    await attached.getByRole("img", { name: "chosen.png" }).waitFor();
    await panel.getByRole("textbox").evaluate((textarea, png) => {
      const bytes = Uint8Array.from(atob(png), c => c.charCodeAt(0));
      const transfer = name => { const data = new DataTransfer(); data.items.add(new File([bytes], name, { type: "image/png" })); return data; };
      textarea.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer("pasted.png"), bubbles: true, cancelable: true }));
      const dropped = transfer("dropped.png");
      for (const type of ["dragenter", "dragover", "drop"]) textarea.dispatchEvent(new DragEvent(type, { dataTransfer: dropped, bubbles: true, cancelable: true }));
    }, png);
    await attached.getByRole("img", { name: "dropped.png" }).waitFor();
    assert.equal(await attached.getByRole("img").count(), 3);
    assert.ok((await page.window.title()).startsWith("Field notes.pdf"));
    await panel.getByRole("button", { name: "Remove pasted.png" }).click();
    await panel.getByRole("textbox").fill("What does this chart show?");
    await panel.getByRole("button", { name: "Send", exact: true }).click();
    await panel.locator(".msg.user .msg-images img").nth(1).waitFor();
    assert.equal(await attached.count(), 0);
    const withImages = (await app.evaluate(() => globalThis.routerTest.request)).messages.at(-1);
    assert.deepEqual(withImages.content.map(part => part.type), ["text", "image_url", "image_url"]);
    assert.equal(withImages.content[1].image_url.url, `data:image/png;base64,${png}`);
    await panel.getByRole("button", { name: "(p. 2)" }).nth(1).waitFor();
    await app.evaluate(() => { globalThis.routerTest.hold = true; });
    await panel.getByRole("textbox").fill("Continue");
    await panel.getByRole("button", { name: "Send", exact: true }).click();
    for (let i = 0; i < 100 && !(await app.evaluate(() => globalThis.routerTest.calls.filter(c => c.endsWith("completions")).length === 3)); i++) await page.waitForTimeout(50);
    await panel.getByRole("button", { name: "Stop" }).click();
    await panel.getByRole("button", { name: "Send", exact: true }).waitFor();
    assert.ok(await app.evaluate(() => globalThis.routerTest.cancelled));
    await provider.selectOption("claude");
    await provider.selectOption("openrouter");
    await panel.getByText("Where do terns nest?").waitFor();
    await panel.getByRole("button", { name: "sample/reader", exact: true }).click();
    await settings.getByRole("button", { name: "Change model" }).click();
    await filter.fill("custom/private");
    await settings.getByRole("button", { name: "Use custom/private" }).click();
    await settings.getByRole("button", { name: "Manage key" }).click();
    await settings.getByRole("button", { name: "Remove saved key" }).click();
    await settings.getByLabel("API key", { exact: true }).waitFor();
    await settings.getByLabel("Ask AI provider").selectOption("chatgpt");
    await settings.getByRole("button", { name: "Close" }).click();
    await page.getByRole("tablist", { name: "Open documents" }).getByRole("button", { name: "Close Field notes.pdf" }).click();
    console.log("ok  OpenRouter setup, models, streaming, citations, images, Stop, provider switching and key removal");
  } finally { await app.evaluate(() => { globalThis.routerTest.restore(); delete globalThis.routerTest; }); }
}
