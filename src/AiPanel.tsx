import { lazy, Suspense, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./icons";
import { copyText } from "./clipboard";
import type { PDFDocumentProxy } from "./pdf";
import { getAiHistory, saveAiHistory } from "./recent";
import { ocrSession } from "./lib/ocr";
import { CLAUDE_CODE_URL, PROVIDERS, savedProvider, saveAiPreference, signInChatGPT, subscribeAiPreferences, USAGE_URL } from "./ai";
import { Modal } from "./Dialogs";
import { readSetting } from "./preferences";
import { splitComments, type AiComment, type PlacedComment } from "./aiComments";
import { imageUrl, isChatImageType, limitImages, MAX_IMAGES_PER_QUESTION, prepareImage, validChatImage, type ChatImage } from "./chatImages";
import { appendWords, cancelRecording, canRecord, recordingState, startRecording, stopRecording } from "./dictation";

const AiMarkdown = lazy(() => import("./AiMarkdown").then((module) => ({ default: module.AiMarkdown })));

export interface AiContext {
  text: string;
  page: number;
}

interface Message extends AiMessage {
  context?: AiContext;
  error?: { message: string; code?: string; link?: string };
  /** Session only: which answer this is, and what became of the comments it asked for. */
  answerId?: string;
  placed?: PlacedComment[] | "adding";
  /** The answer just finished: add any comments it asks for. */
  finished?: boolean;
}

const MAX_DOC_CHARS = 400_000;
const CLAUDE_MODELS = [
  { id: "", name: "Default model" },
  { id: "sonnet", name: "Sonnet" },
  { id: "opus", name: "Opus" },
  { id: "haiku", name: "Haiku" },
];

// ── Document text ───────────────────────────────────────────────────────────────────────
export type DocText = { text: string; truncated: boolean; recognized: boolean };
// Keyed by the OCR version too: pages of a scan gain text while it is being recognized.
const textCache = new WeakMap<PDFDocumentProxy, { version: number; text: Promise<DocText> }>();

export function documentText(pdf: PDFDocumentProxy) {
  const session = ocrSession(pdf);
  const version = session?.version ?? 0;
  const hit = textCache.get(pdf);
  if (hit?.version === version) return hit.text;
  const text = (async () => {
    let text = "";
    let truncated = false;
    for (let n = 1; n <= pdf.numPages; n++) {
      const content = await (await pdf.getPage(n)).getTextContent();
      const page = content.items.map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "")).join("")
        .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
      const block = `[Page ${n}]\n${page}\n\n`;
      if (text.length + block.length > MAX_DOC_CHARS) {
        truncated = true;
        break;
      }
      text += block;
    }
    // OCR can finish while extraction is awaiting a page; use the final state for the safety caveat.
    const recognized = !!session && (session.embedded.size > 0 || [...session.pages.values()].some((items) => items.length));
    return { text, truncated, recognized };
  })();
  textCache.set(pdf, { version, text });
  return text;
}

// ── Panel ─────────────────────────────────────────────────────────────────────────────────
// Keep partial replies and provider errors when the panel closes. Protected documents are session-only.
const conversations = new Map<string, { messages: Message[]; generation: number; persist: boolean }>();
let lastChatClear = 0;
export function forgetClearedChats(generation: number) {
  lastChatClear = Math.max(lastChatClear, generation);
  for (const [id, chat] of conversations) {
    if (chat.persist && chat.generation < generation) conversations.delete(id);
  }
}

function rememberChat(id: string, persist: boolean, messages: Message[], generation: number) {
  if (!persist || generation >= lastChatClear) conversations.set(id, { messages, generation, persist });
}

function CopyResponse({ text }: { text: string }) {
  const [label, setLabel] = useState("Copy response");
  useEffect(() => {
    if (label === "Copy response") return;
    const timer = window.setTimeout(() => setLabel("Copy response"), 2200);
    return () => window.clearTimeout(timer);
  }, [label]);

  return (
    <button className="link small copy-response" title="Copy response as Markdown"
      onClick={async () => setLabel(await copyText(text) ? "Copied" : "Copy failed")}>
      <Icon name={label === "Copied" ? "check" : "copy"} size={13} />
      <span aria-live="polite">{label}</span>
    </button>
  );
}

// Failed and empty answers aren't kept.
const storedMessages = (messages: Message[]) =>
  messages.filter((m) => !m.error && (m.content || m.images?.length)).map(({ role, content, context, images }) =>
    ({ role, content, ...(context ? { context } : {}), ...(images?.length ? { images } : {}) }));

/** Dragged items are files Ask AI can attach (other files, such as PDFs, still open as documents). */
const draggingImages = (data: DataTransfer | null) =>
  !!data && data.types.includes("Files") && [...data.items].some((item) => item.kind === "file" && isChatImageType(item.type));

function NewConversationDialog({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
  return <div onMouseDownCapture={event => {
    // The backdrop closes on mousedown; its default action must not blur the restored button.
    if (event.target === event.currentTarget.querySelector(".modal-backdrop")) event.preventDefault();
  }} onKeyDown={event => {
    event.stopPropagation();
    if (event.key === "Escape") { event.preventDefault(); onCancel(); }
    if (event.key !== "Tab") return;
    const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>("button");
    const first = buttons[0], last = buttons[buttons.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }}>
    <Modal title="Start a new conversation?" onClose={onCancel}>
      <div className="password-form">
        <p>The current conversation for this document will be deleted. This cannot be undone.</p>
        <div className="form-actions">
          <button className="btn ghost" autoFocus onClick={onCancel}>Cancel</button>
          <button className="btn primary" onClick={onConfirm}>Delete conversation</button>
        </div>
      </div>
    </Modal>
  </div>;
}

interface Props {
  pdf: PDFDocumentProxy;
  docId: string;
  /** Save the conversation with the document (off for password-protected documents). */
  persist: boolean;
  docName: string;
  context: AiContext | null;
  onClearContext: () => void;
  onGoToPage: (n: number) => void;
  /** Highlights each quote and attaches its comment; resolves with where each one went. */
  onAddComments: (comments: AiComment[]) => Promise<PlacedComment[]>;
  onRevealMark: (id: string) => void;
  onSettings: () => void;
  onClose: () => void;
}

/** The comments an answer asked for: being added, added (each one opens its spot), or from an earlier session. */
function CommentsCard({ comments, placed, onAdd, onRevealMark, onGoToPage }: {
  comments: AiComment[];
  placed?: PlacedComment[] | "adding";
  onAdd: () => void;
  onRevealMark: (id: string) => void;
  onGoToPage: (n: number) => void;
}) {
  const done = Array.isArray(placed) ? placed : null;
  const added = done?.filter((c) => c.markId).length ?? 0;
  const missed = done ? done.length - added : 0;
  const list: PlacedComment[] = done ?? comments;
  const title = placed === "adding" ? `Adding ${comments.length} comment${comments.length === 1 ? "" : "s"}…`
    : done ? `Added ${added} comment${added === 1 ? "" : "s"}${missed ? ` · ${missed} not found` : ""}`
    : `${comments.length} comment${comments.length === 1 ? "" : "s"} suggested`;
  return (
    <div className="ai-comments">
      <div className="ai-comments-head">
        <Icon name="note" size={14} /> <span>{title}</span>
        {!placed && <button className="link small" onClick={onAdd}>Add to document</button>}
        {done && missed > 0 && <button className="link small" onClick={onAdd}>Try again</button>}
      </div>
      <ul>
        {list.map((c, i) => (
          <li key={i} className={done && !c.markId ? "missed" : undefined}>
            <button className="ai-comment" disabled={placed === "adding"}
              title={done && !c.markId ? "Folio couldn't find these words in the document" : "Show on page"}
              onClick={() => c.markId ? onRevealMark(c.markId) : c.page && onGoToPage(c.page)}>
              <span className="ai-comment-quote">{c.page ? `p. ${c.page}: ` : ""}“{c.quote.length > 80 ? c.quote.slice(0, 80) + "…" : c.quote}”</span>
              <span className="ai-comment-text">{c.comment}</span>
              {done && !c.markId && <span className="ai-comment-missed">Couldn't find these words</span>}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function AiPanel({ pdf, docId, persist, docName, context, onClearContext, onGoToPage, onAddComments, onRevealMark, onSettings, onClose }: Props) {
  const ai = window.folioDesktop?.ai;
  const [status, setStatus] = useState<AiStatus | null>(null);
  const provider = useSyncExternalStore(subscribeAiPreferences, savedProvider);
  const keyRevision = useSyncExternalStore(subscribeAiPreferences, () => readSetting("folio:ai-key-revision"));
  const [models, setModels] = useState<{ id: string; name: string }[]>([]);
  const modelKey = `folio:ai-model:${provider}`;
  const savedModel = useSyncExternalStore(subscribeAiPreferences, () => readSetting(modelKey) ?? "");
  const model = provider === "chatgpt" && models.length && !models.some(m => m.id === savedModel) ? models[0].id : savedModel;
  const [messages, setMessages] = useState<Message[]>(() => conversations.get(docId)?.messages ?? []);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [confirmNew, setConfirmNew] = useState(false);
  const [attachments, setAttachments] = useState<ChatImage[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);
  const dropDepth = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Voice typing: one tap records, the next writes the words out at the end of the box. Nothing is sent.
  const [voice, setVoice] = useState<"starting" | "recording" | "working" | null>(null);
  const [voiceLevel, setVoiceLevel] = useState(0);
  const [voiceNotice, setVoiceNotice] = useState<{ text: string; settings?: boolean } | null>(null);
  const voiceTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => { window.clearInterval(voiceTimer.current); cancelRecording(); }, []);
  const busyRef = useRef<string | null>(null);
  const preparing = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const newConversationRef = useRef<HTMLButtonElement>(null);
  const cancelNew = () => { setConfirmNew(false); newConversationRef.current?.focus(); };

  // The panel is mounted per document (keyed by docId in App), so this conversation always belongs to docId.
  const [generation, setGeneration] = useState<number | null>(() => conversations.get(docId)?.generation ?? (persist ? null : 0));
  const loaded = generation !== null;
  useEffect(() => {
    if (loaded) return;
    let cancelled = false;
    void getAiHistory(docId).then(({ messages, generation }) => {
      if (cancelled) return;
      setMessages(messages);
      setGeneration(generation);
    });
    return () => { cancelled = true; };
  }, [docId, loaded]);
  useEffect(() => {
    if (generation === null) return;
    rememberChat(docId, persist, messages, generation);
    // Save once an answer has finished (not on every streamed word).
    if (persist && !busy) void saveAiHistory(docId, storedMessages(messages), generation);
  }, [docId, messages, busy, generation, persist]);
  useEffect(() => {
    let current = true;
    void ai?.status().then(value => { if (current) setStatus(value); }).catch(() => { if (current) setSetupError("Couldn't check AI connections."); });
    return () => { current = false; };
  }, [ai, keyRevision]);
  useEffect(() => { if (context) inputRef.current?.focus(); }, [context]);

  // ChatGPT's model list depends on the signed-in account.
  const chatgptConnected = !!status?.chatgpt.connected;
  useEffect(() => {
    setSetupError(null);
    if (!ai || provider !== "chatgpt" || !chatgptConnected) return;
    let current = true;
    void ai.chatgptModels().then((result) => {
      if (!current) return;
      if (!result.ok) {
        if (result.code === "signed_out") void ai.status().then(setStatus);
        setSetupError(result.error ?? null);
        return;
      }
      setModels(result.models ?? []);
    });
    return () => { current = false; };
  }, [ai, provider, chatgptConnected]);

  // Stream answers into the last assistant message.
  useEffect(() => {
    if (!ai) return;
    return ai.onEvent((event) => {
      if (event.id !== busyRef.current) return;
      setMessages((list) => {
        const next = list.slice();
        const last = next[next.length - 1];
        if (!last || last.role !== "assistant") return list;
        if (event.type === "delta") next[next.length - 1] = { ...last, content: last.content + (event.text ?? "") };
        if (event.type === "error") next[next.length - 1] = { ...last, error: { message: event.message ?? "Something went wrong.", code: event.code, link: event.link } };
        if (event.type === "done") next[next.length - 1] = { ...next[next.length - 1], finished: true };
        return next;
      });
      if (event.type !== "delta") {
        busyRef.current = null;
        setBusy(null);
        if (event.code === "signed_out") void ai.status().then(setStatus);
      }
    });
  }, [ai]);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Once an answer finishes, add the comments it asked for. Marked on the answer itself (in the same update as its
  // last words), so this never reads an answer that is still arriving.
  const addCommentsRef = useRef(onAddComments);
  addCommentsRef.current = onAddComments;
  const addComments = useCallback((answerId: string, comments: AiComment[], kept: PlacedComment[] = []) => {
    const mark = (placed: Message["placed"]) => setMessages((list) => list.map((m) => m.answerId === answerId ? { ...m, placed } : m));
    mark("adding");
    void addCommentsRef.current(comments).then((placed) => mark([...kept, ...placed]), () => mark([...kept, ...comments.map((c) => ({ ...c }))]));
  }, []);
  useEffect(() => {
    const done = messages.filter((m) => m.finished);
    if (!done.length) return;
    setMessages((list) => list.map((m) => m.finished ? { ...m, finished: false } : m));
    for (const answer of done) {
      const { comments } = splitComments(answer.content);
      if (answer.answerId && !answer.error && comments.length) addComments(answer.answerId, comments);
    }
  }, [messages, addComments]);

  const connected = { chatgpt: chatgptConnected, claude: !!status?.claude.installed && status.claude.loggedIn,
    openrouter: !!status?.openrouter?.configured && !!model, custom: !!status?.custom?.configured && !!model };
  const ready = loaded && connected[provider];

  // Closing the panel, entering focus mode, or opening another document ends an answer in progress the way Stop does.
  // Otherwise it keeps running unseen, holds one of the two answers allowed at a time, and comes back never finishing.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  useEffect(() => () => {
    preparing.current = null;
    const id = busyRef.current;
    if (!id) return;
    busyRef.current = null;
    void ai?.cancel(id);
    const list = messagesRef.current;
    const last = list[list.length - 1];
    const kept = last?.role === "assistant" && !last.content && !last.error ? list.slice(0, -1) : list;
    if (generation !== null) {
      rememberChat(docId, persist, kept, generation);
      if (persist) void saveAiHistory(docId, storedMessages(kept), generation);
    }
  }, [ai, docId, persist, generation]);
  const stop = () => {
    if (!busy) return;
    if (preparing.current !== busy) { void ai?.cancel(busy); return; }
    preparing.current = null;
    busyRef.current = null;
    setBusy(null);
    setMessages(list => list.slice(0, -1));
  };

  const addImages = useCallback(async (files: File[]) => {
    setAttachError(null);
    const images = files.filter((file) => isChatImageType(file.type));
    if (images.length < files.length) setAttachError("Only PNG and JPEG images can be added.");
    if (!images.length) return;
    const room = MAX_IMAGES_PER_QUESTION - attachments.length;
    if (images.length > room) setAttachError(`You can add up to ${MAX_IMAGES_PER_QUESTION} images to a question.`);
    const prepared = await Promise.all(images.slice(0, Math.max(0, room)).map((file) => prepareImage(file).catch(() => null)));
    if (prepared.some((image) => !image)) setAttachError("Folio couldn't read that image.");
    const added = prepared.filter((image): image is ChatImage => !!image);
    setAttachments((list) => [...list, ...added].slice(0, MAX_IMAGES_PER_QUESTION));
    inputRef.current?.focus();
  }, [attachments.length]);

  const stopDictating = async () => {
    window.clearInterval(voiceTimer.current);
    setVoice("working");
    setVoiceLevel(0);
    try {
      const recording = await stopRecording();
      if ("error" in recording) { setVoiceNotice({ text: recording.error }); return; }
      if (recording.ms < 500) { setVoiceNotice({ text: "Too short to make anything out." }); return; }
      const result = await ai!.dictate(recording.bytes, recording.mime, docName);
      if (!result.ok) { setVoiceNotice({ text: result.error ?? "The words couldn't be made out.", settings: result.code === "no_key" }); return; }
      if (!result.text) {
        setVoiceNotice({ text: recording.peak < 0.02
          ? `No sound came from the microphone${recording.mic ? ` (“${recording.mic}”)` : ""}. Check which microphone your computer is using.`
          : "No words were heard." });
        return;
      }
      setInput((box) => appendWords(box, result.text!));
      requestAnimationFrame(() => {
        const box = inputRef.current;
        if (!box) return;
        box.focus();
        box.setSelectionRange(box.value.length, box.value.length);
        box.scrollTop = box.scrollHeight;
      });
    } catch {
      setVoiceNotice({ text: "Folio couldn't write out what you said." });
    } finally {
      setVoice(null);
    }
  };

  const dictate = async () => {
    if (voice === "recording") return stopDictating();
    if (voice || !ai) return;
    setVoiceNotice(null);
    if (!status?.dictation?.configured) {
      setVoiceNotice({ text: "Voice typing needs an OpenAI API key. Add one in Ask AI settings.", settings: true });
      return;
    }
    setVoice("starting");
    const started = await startRecording();
    if ("error" in started) { setVoice(null); setVoiceNotice({ text: started.error }); return; }
    setVoice("recording");
    // How loud, for the glow; and whether it stopped by itself at ten minutes, in which case what there is is written out.
    voiceTimer.current = window.setInterval(() => {
      const now = recordingState();
      setVoiceLevel(now.level);
      if (!now.recording) void stopDictating();
    }, 200);
  };

  const send = useCallback(async (question: string) => {
    if (!ai || (!question.trim() && !attachments.length) || busyRef.current || !ready) return;
    const turn: Message = { role: "user", content: question.trim(), ...(context ? { context } : {}),
      ...(attachments.length ? { images: attachments } : {}) };
    const history = limitImages([...messages.filter((m) => !m.error && (m.content || m.images?.length)), turn]);
    const id = crypto.randomUUID();
    preparing.current = id;
    busyRef.current = id;
    setBusy(id);
    setMessages([...messages, turn, { role: "assistant", content: "", answerId: id }]);
    setInput("");
    setAttachments([]);
    setAttachError(null);
    onClearContext();
    try {
      const session = ocrSession(pdf);
      const doc = (provider === "openrouter" || provider === "custom") && context
        ? { text: "", truncated: true, recognized: !!session && (session.embedded.has(context.page) || !!session.pages.get(context.page)?.length) }
        : await documentText(pdf);
      if (preparing.current !== id) return;
      preparing.current = null;
      await ai.ask({ id, provider, model, document: { name: docName, ...doc },
        messages: history.map(({ role, content, context, images }) => ({ role, content, ...(context ? { context } : {}),
          ...(role === "user" && images?.length ? { images: images.map(({ mediaType, data }) => ({ mediaType, data })) } : {}) })) });
    } catch {
      if (busyRef.current !== id) return;
      preparing.current = null;
      busyRef.current = null;
      setBusy(null);
      setMessages((list) => {
        const next = list.slice();
        next[next.length - 1] = { role: "assistant", content: "", error: { message: "Folio couldn't send that question." } };
        return next;
      });
    }
  }, [ai, pdf, context, messages, attachments, provider, model, docName, onClearContext, ready]);

  const signIn = async () => {
    if (!ai) return;
    setSigningIn(true);
    setSetupError(null);
    const result = await signInChatGPT(ai);
    setSigningIn(false);
    setSetupError(result.error);
    setStatus(result.status);
  };

  const placeholder = !ready ? "Connect an AI provider to ask questions"
    : context ? "Ask about the selected passage…" : "Ask about this document…";

  return (
    // Images dropped here are attached to the question; the window's own handler (which opens dropped PDFs) never sees them.
    <aside className={`ai-panel${dropping ? " dropping" : ""}`} aria-label="Ask AI"
      onDragEnter={(e) => {
        if (!ready || !draggingImages(e.dataTransfer)) return;
        e.preventDefault();
        e.stopPropagation();
        dropDepth.current++;
        setDropping(true);
      }}
      onDragOver={(e) => {
        if (!ready || !draggingImages(e.dataTransfer)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(e) => {
        if (!ready || !draggingImages(e.dataTransfer)) return;
        e.stopPropagation();
        if (--dropDepth.current <= 0) { dropDepth.current = 0; setDropping(false); }
      }}
      onDrop={(e) => {
        if (!ready || !draggingImages(e.dataTransfer)) return;
        e.preventDefault();
        e.stopPropagation();
        dropDepth.current = 0;
        setDropping(false);
        void addImages([...e.dataTransfer.files]);
      }}>
      <header className="ai-head">
        <div className="ai-title"><Icon name="sparkle" size={16} /> Ask AI</div>
        {ai && <select className="ai-provider" aria-label="AI provider" value={provider} disabled={!!busy}
          onChange={event => saveAiPreference("folio:ai-provider", event.target.value)}>
          {Object.entries(PROVIDERS).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>}
        <div className="ai-head-actions">
          <button ref={newConversationRef} className="pill-btn" title="New conversation" aria-label="New conversation" disabled={!messages.length || !!busy} onClick={() => setConfirmNew(true)}>
            <Icon name="plus" size={15} />
          </button>
          <button className="pill-btn" title="Close" aria-label="Close Ask AI" onClick={onClose}>
            <Icon name="close" size={15} />
          </button>
        </div>
      </header>

      <div className="ai-body" ref={listRef}>
        {!ai ? (
          <div className="ai-card"><p>Ask AI is available in the Folio desktop app.</p></div>
        ) : !status ? (
          <p className="ai-checking">Checking connections…</p>
        ) : provider === "chatgpt" && !chatgptConnected ? (
          <div className="ai-card">
            <h3>Use your ChatGPT plan</h3>
            <p>Sign in with ChatGPT to ask questions using your existing ChatGPT plan (Go, Plus, or Pro). No API key needed.</p>
            {/* Stays clickable while waiting: a closed browser tab is opened again. */}
            <button className="btn primary chatgpt-btn" onClick={signIn}>
              {signingIn ? "Open the sign-in page again" : "Continue with ChatGPT"}
            </button>
            {signingIn && <p className="fine">Finish signing in in your browser, then come back here.</p>}
            <p className="fine">When you ask, Folio sends your question and the document's text to OpenAI. Nothing is sent otherwise.</p>
          </div>
        ) : provider === "claude" && !(status.claude.installed && status.claude.loggedIn) ? (
          <div className="ai-card">
            <h3>Use your Claude subscription</h3>
            {!status.claude.installed ? (
              <p>Folio uses Claude Code, Anthropic's official app, signed in with your own Claude Pro or Max account. Install Claude Code, sign in once, then check again.</p>
            ) : (
              <p>Claude Code is installed but not signed in. Open a terminal, run <code>claude</code>, and sign in with your Claude account.</p>
            )}
            <div className="ai-card-actions">
              {!status.claude.installed && <a className="btn ghost" href={CLAUDE_CODE_URL} target="_blank" rel="noreferrer">Get Claude Code</a>}
              <button className="btn primary" onClick={async () => setStatus({ ...status, claude: await ai.recheckClaude() })}>Check again</button>
            </div>
            <p className="fine">Folio never sees your Claude password or tokens. When you ask, it sends your question and the document's text to Anthropic through Claude Code.</p>
          </div>
        ) : provider === "openrouter" && !connected.openrouter ? (
          <div className="ai-card">
            <h3>Connect OpenRouter</h3>
            <p>{status.openrouter?.configured ? "Choose a model for your questions." : "Use your own API key and choose a model in Settings."}</p>
            <button className="btn primary" onClick={onSettings}>Open Ask AI settings</button>
          </div>
        ) : provider === "custom" && !connected.custom ? (
          <div className="ai-card">
            <h3>Connect an endpoint</h3>
            <p>{status.custom?.configured ? "Choose a model for your questions." : "Enter your server's address, an optional key, and a model in Settings."}</p>
            <button className="btn primary" onClick={onSettings}>Open Ask AI settings</button>
          </div>
        ) : (
          <>
            {provider === "chatgpt" && !status.chatgpt.welcomeSeen && (
              <div className="ai-card ai-welcome">
                <p><strong>You're connected{status.chatgpt.email ? ` as ${status.chatgpt.email}` : ""}.</strong> Questions you ask in Folio use your ChatGPT plan. You can manage usage in ChatGPT settings.</p>
                <div className="ai-card-actions">
                  <a className="btn ghost" href={USAGE_URL} target="_blank" rel="noreferrer">Manage usage</a>
                  <button className="btn primary" onClick={async () => { await ai.chatgptWelcomeSeen(); setStatus(await ai.status()); }}>Got it</button>
                </div>
              </div>
            )}
            {messages.length === 0 && (
              <div className="ai-empty">
                <p>Ask anything about <strong>{docName.replace(/\.pdf$/i, "")}</strong>, or select text in the document and choose <em>Ask AI</em>.</p>
                <div className="suggestions">
                  {(context ? ["Explain this in simple terms", "Why does this matter?", "Summarize this passage"]
                    : ["Summarize this document", "What are the key takeaways?", "What questions does this leave open?"]).map((q) => (
                    <button key={q} className="suggestion" onClick={() => void send(q)}>{q}</button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`msg ${m.role}`}>
                {m.role === "user" ? (
                  <>
                    {m.context && <blockquote>p. {m.context.page}: {m.context.text.length > 220 ? m.context.text.slice(0, 220) + "…" : m.context.text}</blockquote>}
                    {Array.isArray(m.images) && m.images.some(validChatImage) && (
                      <div className="msg-images">
                        {m.images.filter(validChatImage).map((image, k) => (
                          <img key={k} src={imageUrl(image)} alt={image.name ?? `Image ${k + 1}`} title={image.name} />
                        ))}
                      </div>
                    )}
                    {m.content && <p>{m.content}</p>}
                  </>
                ) : m.error ? (
                  <div className="msg-error">
                    <p>{m.error.message}</p>
                    {m.error.code === "usage_limit" && provider === "chatgpt" && (
                      <a className="btn primary" href={m.error.link || USAGE_URL} target="_blank" rel="noreferrer">Manage usage</a>
                    )}
                    {m.error.code === "signed_out" && provider === "chatgpt" && (
                      <button className="btn primary" onClick={signIn}>Continue with ChatGPT</button>
                    )}
                  </div>
                ) : m.content ? (() => {
                  const answer = splitComments(m.content);
                  const answerId = m.answerId ?? `history-${i}`;
                  return <>
                    {answer.text && <Suspense fallback={<p style={{ whiteSpace: "pre-wrap" }}>{answer.text}</p>}>
                      <AiMarkdown text={answer.text} onPage={onGoToPage} />
                    </Suspense>}
                    {answer.pending && <p className="ai-checking">Writing comments…</p>}
                    {!answer.pending && answer.comments.length > 0 && (
                      <CommentsCard comments={answer.comments} placed={m.placed} onRevealMark={onRevealMark} onGoToPage={onGoToPage}
                        onAdd={() => {
                          if (!m.answerId) setMessages((list) => list.map((x, k) => k === i ? { ...x, answerId } : x));
                          if (Array.isArray(m.placed)) addComments(answerId, m.placed.filter((c) => !c.markId), m.placed.filter((c) => c.markId));
                          else addComments(answerId, answer.comments);
                        }} />
                    )}
                    {(!busy || i < messages.length - 1) && answer.text && <CopyResponse text={answer.text} />}
                  </>;
                })() : (
                  <div className="typing" aria-label="Thinking"><span /><span /><span /></div>
                )}
              </div>
            ))}
          </>
        )}
        {setupError && <div className="msg-error"><p>{setupError}</p></div>}
      </div>

      <footer className="ai-foot">
        {context && (
          <div className="context-chip">
            <span>p. {context.page}: “{context.text.length > 90 ? context.text.slice(0, 90) + "…" : context.text}”</span>
            <button onClick={onClearContext} aria-label="Ask about the whole document instead" title="Ask about the whole document instead">
              <Icon name="close" size={12} />
            </button>
          </div>
        )}
        {attachments.length > 0 && (
          <ul className="ai-attachments" aria-label="Attached images">
            {attachments.map((image, i) => (
              <li key={i}>
                <img src={imageUrl(image)} alt={image.name ?? `Image ${i + 1}`} title={image.name} />
                <button type="button" aria-label={`Remove ${image.name ?? `image ${i + 1}`}`} title="Remove"
                  onClick={() => { setAttachments((list) => list.filter((_, k) => k !== i)); setAttachError(null); }}>
                  <Icon name="close" size={11} />
                </button>
              </li>
            ))}
          </ul>
        )}
        {attachError && <p className="ai-attach-error" role="status">{attachError}</p>}
        {voiceNotice && <p className="ai-attach-error" role="status">{voiceNotice.text}
          {voiceNotice.settings && <> <button type="button" className="link small" onClick={onSettings}>Open settings</button></>}</p>}
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            void send(input);
          }}
        >
          <textarea
            ref={inputRef}
            value={input}
            rows={2}
            disabled={!ready}
            placeholder={placeholder}
            onChange={(e) => setInput(e.target.value)}
            onPaste={(e) => {
              // Copied text wins over the picture some apps put on the clipboard with it (Excel cells, Word paragraphs).
              const files = [...e.clipboardData.files].filter((file) => isChatImageType(file.type));
              if (!files.length || e.clipboardData.getData("text/plain").trim()) return;
              e.preventDefault();
              void addImages(files);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send(input);
              }
            }}
          />
          <input ref={fileInputRef} type="file" accept="image/png,image/jpeg" multiple hidden aria-label="Choose images"
            onChange={(e) => {
              const files = [...(e.target.files ?? [])];
              e.target.value = "";
              void addImages(files);
            }} />
          {ai && canRecord() && (
            <button type="button" className={`attach-btn dictate-btn${voice ? ` ${voice}` : ""}`} disabled={!ready || voice === "starting" || voice === "working"}
              style={{ "--lvl": voice === "recording" ? voiceLevel.toFixed(2) : "0" } as React.CSSProperties}
              aria-pressed={voice === "recording"}
              title={voice === "recording" ? "Stop dictating" : voice === "working" ? "Writing out what you said…" : "Dictate (click again to stop)"}
              aria-label={voice === "recording" ? "Stop dictating" : "Dictate"} onClick={() => void dictate()}>
              <Icon name="mic" size={16} />
            </button>
          )}
          <button type="button" className="attach-btn" disabled={!ready || attachments.length >= MAX_IMAGES_PER_QUESTION}
            title="Add an image (or paste or drop one)" aria-label="Add image" onClick={() => fileInputRef.current?.click()}>
            <Icon name="image" size={16} />
          </button>
          {busy ? (
            <button type="button" className="send-btn" onClick={stop} title="Stop" aria-label="Stop">
              <Icon name="stop" size={15} />
            </button>
          ) : (
            <button type="submit" className="send-btn" disabled={!ready || (!input.trim() && !attachments.length)} title="Send (Enter)" aria-label="Send">
              <Icon name="send" size={16} />
            </button>
          )}
        </form>
        {ready && (
          <div className="ai-meta">
            {provider === "openrouter" || provider === "custom" ? <button className="link small router-model-link" title={model} onClick={onSettings}>{model}</button> :
            <select value={model} onChange={(e) => saveAiPreference(modelKey, e.target.value)} aria-label="Model">
              {(provider === "chatgpt" ? models : CLAUDE_MODELS).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>}
            {provider === "chatgpt" ? (
              <span>Using ChatGPT plan · <a href={USAGE_URL} target="_blank" rel="noreferrer">Manage usage</a></span>
            ) : provider === "openrouter" ? <span>Billed by OpenRouter</span> : provider === "custom" ? (
              <span title={status?.custom.baseUrl}>Sent to {status?.custom.configured ? new URL(status.custom.baseUrl).host : "your endpoint"}</span>
            ) : (
              <span>{status?.claude.subscription ? "Using your Claude subscription via Claude Code" : "Using Claude Code"}</span>
            )}
          </div>
        )}
      </footer>
      {confirmNew && createPortal(<NewConversationDialog onCancel={cancelNew} onConfirm={() => {
        setConfirmNew(false);
        setMessages([]);
        inputRef.current?.focus();
      }} />, document.body)}
    </aside>
  );
}
