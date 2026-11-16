import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "./icons";
import { keys } from "./platform";
import { MoreMenu } from "./MoreMenu";
import type { Mark, MarkupState, OtherNote, Reply } from "./markup";

interface Props {
  state: MarkupState;
  onExport: (format: "markdown" | "json") => void;
  persisted: boolean;
  onReveal: (id: string) => void;
  onNote: (id: string, note: string) => void;
  onRemove: (id: string) => void;
  onDocNote: (note: string) => void;
  onAsk: (mark: Mark) => void;
  onPage: (page: number) => void;
}

/** Commits text after the reader pauses typing (and on blur), so every keystroke isn't a save. */
function useDebouncedField(value: string, commit: (v: string) => void) {
  const [draft, setDraft] = useState(value);
  const timer = useRef(0);
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setDraft(value); }, [value]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return {
    value: draft,
    onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const next = e.target.value;
      setDraft(next);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => commit(next), 500);
    },
    onFocus: () => { focused.current = true; },
    onBlur: () => {
      focused.current = false;
      window.clearTimeout(timer.current);
      if (draft !== value) commit(draft);
    },
  };
}

function fit(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight + 2}px`;
}
const autoGrow = (e: React.FormEvent<HTMLTextAreaElement>) => fit(e.currentTarget);

/** A textarea that grows with its content, including content set from outside. */
function GrowingTextarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => fit(ref.current), [props.value]);
  return <textarea ref={ref} {...props} onInput={autoGrow} />;
}

export function NotesPanel({ state, onExport, persisted, onReveal, onNote, onRemove, onDocNote, onAsk, onPage }: Props) {
  const docNote = useDebouncedField(state.note, onDocNote);
  const highlights = state.marks.filter((m) => m.type === "highlight" || (m.type === "freetext" && m.text));
  const other = state.marks.length - highlights.length;
  // Highlights and the read-only notes already in the PDF, in reading order.
  const top = (rect: unknown) => (Array.isArray(rect) ? rect[3] as number : 0);
  const items = [
    ...highlights.map((mark) => ({ page: mark.page, top: top(mark.data.rect), mark, other: undefined })),
    ...state.others.map((note) => ({ page: note.page, top: top(note.rect), mark: undefined, other: note })),
  ].sort((a, b) => a.page - b.page || b.top - a.top);
  const counts = [
    highlights.length && `${highlights.length} highlight${highlights.length === 1 ? "" : "s"}`,
    state.others.length && `${state.others.length} comment${state.others.length === 1 ? "" : "s"}`,
  ].filter(Boolean).join(" · ");

  return (
    <div className="notes-panel">
      <div className="notes-head">
        <span>{counts || "Notes"}</span>
        <MoreMenu label="Export" items={[
          { kind: "action", icon: "copy", label: "Copy Markdown", disabled: !state.marks.length && !docNote.value.trim() && !state.bookmarkedPages?.length,
            onSelect: () => onExport("markdown") },
          { kind: "action", icon: "download", label: "Save JSON…", disabled: state.bookmarkedPages === null, onSelect: () => onExport("json") },
        ]} />
      </div>

      <GrowingTextarea
        className="doc-note"
        placeholder="Notes about this document…"
        aria-label="Notes about this document"
        rows={3}
        {...docNote}
      />

      {items.length === 0 ? (
        <div className="notes-empty">
          <Icon name="highlight" size={22} />
          <p>Select text and click a color to highlight it. Highlights and their notes show up here.</p>
        </div>
      ) : (
        <ul className="mark-list">
          {items.map(({ mark, other }) => mark
            ? <MarkCard key={mark.id} mark={mark} replies={mark.source ? state.replies[mark.source] : undefined}
                onReveal={onReveal} onNote={onNote} onRemove={onRemove} onAsk={onAsk} />
            : <OtherCard key={other!.id} note={other!} replies={state.replies[other!.id]} onPage={onPage} />)}
        </ul>
      )}
      {other > 0 && <p className="notes-foot">Plus {other} drawing{other === 1 ? "" : "s"} on the pages.</p>}
      <p className="notes-foot">
        {keys(persisted ? "Saved automatically on this computer. Ctrl+S saves a PDF copy that includes them."
          : "Password-protected documents aren't saved in Folio. Use Ctrl+S to keep a copy with your highlights.")}
      </p>
    </div>
  );
}

function Replies({ replies }: { replies?: Reply[] }) {
  if (!replies?.length) return null;
  return (
    <ul className="mark-replies">
      {replies.map((reply, i) => (
        <li key={i}>{reply.author && <span className="note-author">{reply.author}</span>}{reply.text}</li>
      ))}
    </ul>
  );
}

/** A note already in the PDF that Folio shows but doesn't edit, such as a sticky note added in another app. */
function OtherCard({ note, replies, onPage }: { note: OtherNote; replies?: Reply[]; onPage: (page: number) => void }) {
  return (
    <li className="mark-card other-card" style={{ "--mark": note.color } as React.CSSProperties}>
      <button className="mark-quote" onClick={() => onPage(note.page + 1)} title="Show on page">
        <span className="mark-page">p. {note.page + 1}</span>
        {note.text || note.kind}
      </button>
      <div className="mark-note-read">
        {note.author && <span className="note-author">{note.author}</span>}
        {note.note}
      </div>
      <Replies replies={replies} />
    </li>
  );
}

function MarkCard({ mark, replies, onReveal, onNote, onRemove, onAsk }: {
  mark: Mark;
  replies?: Reply[];
  onReveal: (id: string) => void;
  onNote: (id: string, note: string) => void;
  onRemove: (id: string) => void;
  onAsk: (mark: Mark) => void;
}) {
  const note = useDebouncedField(mark.note, (v) => onNote(mark.id, v.trim()));
  return (
    <li className="mark-card" style={{ "--mark": mark.color } as React.CSSProperties}>
      <button className="mark-quote" onClick={() => onReveal(mark.id)} title="Show on page">
        <span className="mark-page">p. {mark.page + 1}</span>
        {mark.text || (mark.type === "freetext" ? "Text box" : "Highlight")}
      </button>
      {mark.author && <span className="note-author mark-author">{mark.author}</span>}
      {mark.type === "highlight" && (
        <GrowingTextarea className="mark-note" placeholder="Add a note…" aria-label="Note" rows={1} {...note} />
      )}
      <Replies replies={replies} />
      <div className="mark-actions">
        {mark.type === "highlight" && (
          <button className="pill-btn" onClick={() => onAsk(mark)} title="Ask AI about this highlight" aria-label="Ask AI about this highlight">
            <Icon name="sparkle" size={14} />
          </button>
        )}
        <button className="pill-btn" onClick={() => onRemove(mark.id)} title="Delete" aria-label="Delete highlight">
          <Icon name="trash" size={14} />
        </button>
      </div>
    </li>
  );
}
