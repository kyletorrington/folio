import { useRef, useState } from "react";
import { saveAiPreference } from "./ai";

/** The OpenAI API key that voice typing in Ask AI uses, whichever provider answers the questions. */
export function VoiceSettings({ ai, configured, onConfigured }: { ai: FolioAi; configured: boolean; onConfigured: (configured: boolean) => void }) {
  const key = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const act = async (action: "save" | "check" | "remove") => {
    const value = action === "save" ? key.current?.value.trim() : undefined;
    if (key.current) key.current.value = "";
    setNotice(""); setError(""); setBusy(true);
    try {
      const result = await ai.dictationKey(action, value);
      if (!result.ok) { setError(result.error || "Couldn't update the OpenAI key."); return; }
      onConfigured(!!result.configured);
      setEditing(false);
      setNotice(action === "check" ? "Connection verified." : "");
      if (action !== "check") saveAiPreference("folio:ai-key-revision", crypto.randomUUID());
    } catch { setError("Couldn't update the OpenAI key. Try again."); }
    finally { setBusy(false); }
  };
  return <div className="router-settings voice-settings">
    <h4>Voice typing</h4>
    <p className="settings-hint">The microphone in Ask AI writes out what you say with OpenAI's speech-to-text, billed to your OpenAI API account. Recordings are sent to OpenAI only to be written out and aren't kept.</p>
    {configured && !editing ? <div className="settings-row">
      <div className="settings-label"><span>OpenAI API key</span><small>Stored securely on this device.</small></div>
      <button className="link small" disabled={busy} onClick={() => { setEditing(true); setNotice(""); setError(""); }}>Manage key</button>
      <button className="btn ghost" disabled={busy} onClick={() => void act("check")}>{busy ? "Checking…" : "Check connection"}</button>
    </div> : <form className="router-key" onSubmit={event => { event.preventDefault(); void act("save"); }}>
      <label htmlFor="voice-key">{configured ? "Replacement OpenAI API key" : "OpenAI API key"}</label>
      <div><input ref={key} id="voice-key" type="password" autoComplete="off" spellCheck={false} maxLength={512} required
        placeholder="Paste your OpenAI API key (sk-…)" disabled={busy} />
        <button className="btn primary" disabled={busy}>{busy ? "Checking…" : "Verify and save"}</button></div>
      {configured && <div className="router-key-actions">
        <button type="button" className="link small" disabled={busy} onClick={() => { setEditing(false); setError(""); }}>Cancel</button>
        <button type="button" className="link small" disabled={busy} onClick={() => void act("remove")}>Remove saved key</button>
      </div>}
    </form>}
    {notice && <p role="status" className="settings-hint">{notice}</p>}
    {error && <p role="alert" className="form-error">{error}</p>}
  </div>;
}
