// Highlights, drawings, text boxes and notes as first-class, auto-saved document data.
// pdf.js owns the on-page editors; this keeps a saved copy per document and recreates the
// editors whenever the document is opened again.
import { AnnotationEditorParamsType, AnnotationEditorType, AnnotationLayer, AnnotationType } from "pdfjs-dist";
import type { EventBus, PDFViewer } from "./viewer";
import type { PDFDocumentProxy } from "./pdf";
import { getNotes, saveNotes, type AdoptedAnnotation, type DocNotes, type StoredMark } from "./recent";

export type Mark = StoredMark;

export interface Reply { author: string; text: string }

/**
 * A note already in the PDF that Folio shows but doesn't edit: a sticky note, or a comment on an underline, shape or
 * other annotation Folio can't redraw. It stays in the PDF exactly as it was.
 */
export interface OtherNote {
  id: string;
  page: number; // 0-based
  kind: string;
  /** The words it marks, when it marks text. */
  text: string;
  note: string;
  author: string;
  color: string;
  rect: number[];
  quadPoints?: number[];
  /** False for sticky notes: the PDF draws their icon itself. */
  icon: boolean;
}

/** Plain-data view of pdf.js's annotation records (getAnnotations). */
interface PdfAnnotation {
  id?: string;
  annotationType: number;
  subtype?: string;
  rect: ArrayLike<number>;
  quadPoints?: ArrayLike<number> | null;
  color?: ArrayLike<number> | null;
  opacity?: number;
  rotation?: number;
  contentsObj?: { str?: string };
  titleObj?: { str?: string };
  inReplyTo?: string;
  popupRef?: string | null;
  overlaidText?: string;
  stateModel?: string | null;
  hidden?: boolean;
  noView?: boolean;
  isEditable?: boolean;
  folioAdopted?: boolean;
  folioShown?: boolean;
}

const OTHER_KINDS: Partial<Record<number, string>> = {
  [AnnotationType.TEXT]: "Sticky note", [AnnotationType.UNDERLINE]: "Underline", [AnnotationType.SQUIGGLY]: "Squiggly underline",
  [AnnotationType.STRIKEOUT]: "Strikethrough", [AnnotationType.SQUARE]: "Box", [AnnotationType.CIRCLE]: "Circle",
  [AnnotationType.LINE]: "Line", [AnnotationType.POLYGON]: "Shape", [AnnotationType.POLYLINE]: "Shape",
  [AnnotationType.INK]: "Drawing", [AnnotationType.STAMP]: "Stamp", [AnnotationType.CARET]: "Insert text",
  [AnnotationType.FILEATTACHMENT]: "Attachment", [AnnotationType.HIGHLIGHT]: "Highlight",
};

// pdf.js turns highlights already in a PDF into its own editable highlights whenever an editing tool is picked.
// Folio shows the ones it has taken over as its own marks, so pdf.js must leave those alone.
const layerProto = AnnotationLayer.prototype as unknown as { getEditableAnnotations(): { data: PdfAnnotation }[] };
const editableAnnotations = layerProto.getEditableAnnotations;
layerProto.getEditableAnnotations = function () {
  return editableAnnotations.call(this).filter((element) => !element.data.folioAdopted);
};

const SAVED_TYPES: Record<string, Mark["type"]> = { highlight: "highlight", ink: "ink", freetext: "freetext" };

/* Minimal views of pdf.js internals used here (they're not part of its typed public API). */
interface Editor {
  id: string;
  pageIndex: number;
  div?: HTMLElement | null;
  deleted?: boolean;
  annotationElementId?: string | null;
  isClone?: boolean;
  x: number;
  y: number;
  pageDimensions: [number, number];
  comment: { text?: string; deleted?: boolean } | null;
  getPDFRect(): number[];
  getRectInCurrentCoords(rect: number[], pageHeight: number): number[];
  fixAndSetPosition(): void;
  isEmpty(): boolean;
  serialize(isForCopying?: boolean): Record<string, unknown> | null;
  remove(): void;
  constructor: { _type?: string };
  __folioMark?: string;
  __folioGeneration?: number;
  __folioText?: string;
  __folioShape?: Mark["shape"];
}
interface EditorLayer {
  div: HTMLElement;
  deserialize(data: Record<string, unknown>): Promise<Editor | null>;
  add(editor: Editor): void;
}
interface UIManager {
  getMode(): number;
  readonly hasSelection: boolean;
  endCurrentEditing(): void;
  unselectAll(): void;
  getEditors(pageIndex: number): Iterable<Editor>;
  getEditor(id: string): Editor | undefined;
  getLayer(pageIndex: number): EditorLayer | undefined;
  highlightSelection(methodOfCreation?: string): void;
}

const toHex = (color: unknown) =>
  Array.isArray(color) && color.length >= 3
    ? "#" + color.slice(0, 3).map((c) => Math.round(Number(c)).toString(16).padStart(2, "0")).join("")
    : "#ffd84d";

const newId = () => crypto.randomUUID();

export interface MarkupState {
  marks: Mark[];
  note: string;
  bookmarkedPages: number[] | null;
  /** Notes in the PDF that Folio shows read-only. */
  others: OtherNote[];
  /** Replies already in the PDF, by the id of the annotation they answer (a mark's source, or an OtherNote id). */
  replies: Record<string, Reply[]>;
}

export class MarkupController {
  #bus: EventBus;
  #viewer: PDFViewer;
  #ui: UIManager | null = null;
  #docId: string | null = null;
  #generation = 0;
  #storageGeneration = 0;
  #persist = false;
  #note = "";
  #bookmarkedPages: number[] | null = null;
  /** Saved marks whose page hasn't rendered yet, keyed by page index. */
  #pending = new Map<number, Mark[]>();
  /** Last known record for every mark (text, note, created time survive re-serialization). */
  #known = new Map<string, Mark>();
  #restoring = new Set<number>();
  #selectionText = "";
  /** Annotations in the PDF that Folio shows as its own marks, by pdf.js id. */
  #adopted = new Map<string, AdoptedAnnotation>();
  /** Annotations pdf.js shouldn't draw: the highlights Folio draws itself, and replies (shown with their note). */
  #suppressed = new Set<string>();
  #others: OtherNote[] = [];
  #replies: Record<string, Reply[]> = {};
  #pdf: PDFDocumentProxy | null = null;
  #penWidth = 1;
  #syncTimer = 0;
  #saveTimer = 0;
  #listener: (state: MarkupState) => void;
  /** True while Folio itself switches pdf.js modes for a one-click highlight. */
  quickHighlighting = false;

  constructor(bus: EventBus, viewer: PDFViewer, listener: (state: MarkupState) => void) {
    this.#bus = bus;
    this.#viewer = viewer;
    this.#listener = listener;
    bus.on("annotationeditoruimanager", ({ uiManager }: { uiManager: UIManager }) => {
      this.#ui = uiManager;
    });
    // pdf.js asks the host app to enter highlight mode when highlighting a selection.
    bus.on("showannotationeditorui", ({ source, mode }: { source: UIManager; mode: number }) => {
      if (source === this.#ui) this.#viewer.annotationEditorMode = { mode };
    });
    document.addEventListener("selectionchange", () => {
      if (!this.#docId || this.quickHighlighting || this.#ui?.getMode() !== AnnotationEditorType.HIGHLIGHT) return;
      const selection = document.getSelection();
      if (!selection) return;
      if (selection.isCollapsed && this.#selectionText) {
        // pdf.js clears the range when it creates the mark. Record its passage before the next drag.
        this.sync();
      }
      const anchor = selection.anchorNode instanceof Element ? selection.anchorNode : selection.anchorNode?.parentElement;
      this.#selectionText = anchor?.closest(".textLayer") && this.#viewer.viewer?.contains(anchor)
        ? selection.toString().replace(/\s+/g, " ").trim() : "";
    });
    bus.on("annotationeditorlayerrendered", ({ source, pageNumber }: { source: unknown; pageNumber: number }) => {
      if (source === this.#viewer.getPageView(pageNumber - 1)) void this.#restorePage(pageNumber - 1);
    });
    bus.on("annotationlayerrendered", ({ pageNumber }: { pageNumber: number }) => this.#hidePdfPopups(pageNumber - 1));
    for (const name of ["editingstateschanged", "annotationeditormodechanged", "editingaction"]) {
      bus.on(name, () => this.scheduleSync());
    }
    bus.on("annotationeditormodechanged", ({ mode }: { mode: number }) => {
      if (mode === AnnotationEditorType.INK) this.#applyPenWidth();
    });
  }

  get state(): MarkupState {
    return { marks: this.#sorted(), note: this.#note, bookmarkedPages: this.#bookmarkedPages, others: this.#others, replies: this.#replies };
  }

  clearEditorSelection() {
    this.#ui?.unselectAll();
  }

  get penWidth() { return this.#penWidth; }

  setPenWidth(width: number) {
    // PDF.js groups consecutive strokes. Finish that group before changing the next stroke's width.
    this.#ui?.endCurrentEditing();
    this.clearEditorSelection();
    this.#penWidth = width;
    this.#applyPenWidth();
  }

  #applyPenWidth() {
    if (this.#ui && !this.#ui.hasSelection) {
      this.#bus.dispatch("switchannotationeditorparams", { source: this, type: AnnotationEditorParamsType.INK_THICKNESS, value: this.#penWidth });
    }
  }

  /** Loads saved markup for a newly opened document. Password-protected documents aren't persisted. */
  async load(docId: string, persist: boolean, reading?: Pick<MarkupState, "note" | "bookmarkedPages">, pdf?: PDFDocumentProxy) {
    const readingGeneration = this.#storageGeneration;
    this.unload();
    const generation = this.#generation;
    this.#docId = docId;
    const record = persist ? await getNotes(docId) : undefined;
    if (generation !== this.#generation) return;
    const cleared = record && record.generation < this.#storageGeneration;
    if (cleared || (record && readingGeneration < record.generation)) reading = undefined;
    const saved = cleared ? undefined : record?.value;
    if (record) this.#storageGeneration = Math.max(this.#storageGeneration, record.generation);
    this.#persist = persist;
    this.#note = reading?.note ?? saved?.note ?? "";
    this.#bookmarkedPages = reading?.bookmarkedPages ?? saved?.bookmarkedPages ?? [];
    for (const mark of saved?.marks ?? []) {
      this.#known.set(mark.id, mark);
      const list = this.#pending.get(mark.page) ?? [];
      list.push(mark);
      this.#pending.set(mark.page, list);
    }
    this.#emit();
    if (reading) this.#scheduleSave();
    if (pdf) {
      this.#pdf = pdf;
      // Highlights and notes already in the PDF: from another app, another person, or a copy saved by Folio.
      const imported = await this.#readPdfNotes(pdf, generation, saved?.adopted).catch((e) => { console.warn("Couldn't read the notes already in this PDF.", e); return false; });
      if (generation !== this.#generation) return;
      if (imported) this.#scheduleSave();
    }
    // Finish restoring visible pages before an export collects the marks still pending on other pages.
    await Promise.allSettled(Array.from(this.#pending.keys(), page => this.#restorePage(page)));
  }

  unload() {
    // Read the live editors first: an edit committed in place (retyping a text box, then Escape) fires no event
    // that schedules a sync, so it would otherwise be lost.
    this.sync();
    this.flush();
    this.#generation++;
    this.#persist = false;
    this.#ui = null;
    this.quickHighlighting = false;
    this.#restoring.clear();
    this.#selectionText = "";
    const selection = document.getSelection();
    if (selection?.anchorNode && this.#viewer.viewer?.contains(selection.anchorNode)) selection.removeAllRanges();
    this.#docId = null;
    this.#pending.clear();
    this.#known.clear();
    this.#adopted.clear();
    this.#suppressed.clear();
    this.#others = [];
    this.#replies = {};
    this.#pdf = null;
    this.#note = "";
    this.#bookmarkedPages = null;
    this.#emit();
  }

  /**
   * Reads the notes and highlights already in the PDF. Highlights become Folio marks (the first time this file is
   * opened), so they can be recoloured, noted and deleted like any other; when a copy is saved they replace the
   * originals in place, keeping their author and replies. Every other annotation with a note is shown read-only.
   * Resolves true when it added marks.
   */
  async #readPdfNotes(pdf: PDFDocumentProxy, generation: number, adopted: AdoptedAnnotation[] | undefined) {
    const all: { page: number; a: PdfAnnotation }[] = [];
    for (let page = 0; page < pdf.numPages; page++) {
      const list = await (await pdf.getPage(page + 1)).getAnnotations() as PdfAnnotation[];
      if (generation !== this.#generation) return false;
      // Replies count even when hidden: Folio shows them with the note they answer.
      for (const a of list) if (a.id && /^\d+R\d*$/.test(a.id) && (a.inReplyTo || !a.hidden && !a.noView)) all.push({ page, a });
    }
    const text = (v?: { str?: string }) => (v?.str ?? "").replace(/\r\n?/g, "\n").trim();
    const color = (c: PdfAnnotation["color"]) => c && c.length >= 3 ? toHex(Array.from(c)) : "#ffd84d";
    const replies: Record<string, Reply[]> = {};
    const replyIds = new Map<string, { id: string; popupRef: string | null }[]>();
    for (const { a } of all) {
      if (!a.inReplyTo) continue;
      // Shown with the note they answer, so not also as an icon of their own.
      this.#suppressed.add(a.id!);
      replyIds.set(a.inReplyTo, [...replyIds.get(a.inReplyTo) ?? [], { id: a.id!, popupRef: a.popupRef ?? null }]);
      // Review states ("Accepted", "Completed") are replies too, with no text of their own worth showing.
      if (!a.stateModel && text(a.contentsObj)) (replies[a.inReplyTo] ??= []).push({ author: text(a.titleObj), text: text(a.contentsObj) });
    }
    const known = new Set((adopted ?? []).map((x) => x.id));
    const fresh: Mark[] = [];
    const others: OtherNote[] = [];
    for (const { page, a } of all) {
      if (a.inReplyTo) continue;
      const isHighlight = a.annotationType === AnnotationType.HIGHLIGHT && a.quadPoints && a.quadPoints.length >= 8;
      if (isHighlight && (known.has(a.id!) || !adopted)) {
        a.folioAdopted = true;
        const info = { id: a.id!, page, popupRef: a.popupRef ?? null, replies: replyIds.get(a.id!) };
        this.#adopted.set(a.id!, info);
        this.#suppressed.add(a.id!);
        if (known.has(a.id!)) continue;
        fresh.push({
          id: newId(), type: "highlight", page, text: (a.overlaidText ?? "").replace(/\s+/g, " ").trim(),
          note: text(a.contentsObj), color: color(a.color), createdAt: Date.now() + fresh.length, source: a.id,
          ...(text(a.titleObj) && { author: text(a.titleObj) }),
          data: { annotationType: AnnotationEditorType.HIGHLIGHT, color: Array.from(a.color ?? [255, 216, 77]), opacity: a.opacity ?? 1,
            quadPoints: Array.from(a.quadPoints!), pageIndex: page, rect: Array.from(a.rect), rotation: a.rotation ?? 0 },
        });
        continue;
      }
      const kind = OTHER_KINDS[a.annotationType];
      if (!kind || !text(a.contentsObj)) continue;
      a.folioShown = true;
      others.push({
        id: a.id!, page, kind, text: (a.overlaidText ?? "").replace(/\s+/g, " ").trim(), note: text(a.contentsObj),
        author: text(a.titleObj), color: color(a.color), rect: Array.from(a.rect),
        ...(a.quadPoints && a.quadPoints.length >= 8 && { quadPoints: Array.from(a.quadPoints) }),
        icon: a.annotationType !== AnnotationType.TEXT,
      });
    }
    // Replies to a sticky note or other annotation, by the note they answer.
    this.#replies = replies;
    this.#others = others;
    for (const mark of fresh) {
      this.#known.set(mark.id, mark);
      this.#pending.set(mark.page, [...this.#pending.get(mark.page) ?? [], mark]);
    }
    this.#emit();
    if (this.#suppressed.size || others.length) {
      // Pages drawn before this finished show the PDF's own copy of each highlight under Folio's: draw them again.
      this.#hideOriginals(pdf);
      for (let page = 0; page < this.#viewer.pagesCount; page++) this.#hidePdfPopups(page);
    }
    return fresh.length > 0;
  }

  /** Stops pdf.js drawing the highlights Folio has taken over (Folio draws them), and redraws pages already drawn. */
  #hideOriginals(pdf: PDFDocumentProxy) {
    const storage = pdf.annotationStorage as unknown as { modifiedIds: { ids: Set<string>; hash: string } };
    const own = Object.getOwnPropertyDescriptor(storage, "modifiedIds");
    const base = own?.get ?? Object.getOwnPropertyDescriptor(Object.getPrototypeOf(storage), "modifiedIds")?.get;
    if (!base || own?.get?.name === "folioModifiedIds") {
      // Already patched for this document: the set below is read live.
    } else {
      const suppressed = this.#suppressed;
      let cache: { from: unknown; size: number; value: { ids: Set<string>; hash: string } } | null = null;
      Object.defineProperty(storage, "modifiedIds", {
        configurable: true,
        get: function folioModifiedIds(this: unknown) {
          const from = base.call(this) as { ids: Set<string>; hash: string };
          if (!suppressed.size) return from;
          if (cache?.from !== from || cache.size !== suppressed.size) {
            cache = { from, size: suppressed.size, value: { ids: new Set([...from.ids, ...suppressed]), hash: `${from.hash}|folio:${[...suppressed].join(",")}` } };
          }
          return cache.value;
        },
      });
    }
    if (this.#viewer.pdfDocument === pdf) this.#viewer.refresh();
  }

  /**
   * pdf.js's own pop-ups for notes Folio shows (Folio shows them its own way), and the clickable areas of the
   * highlights it has taken over.
   */
  #hidePdfPopups(page: number) {
    const div = (this.#viewer.getPageView(page) as unknown as { div?: HTMLElement } | undefined)?.div;
    const layer = div?.querySelector<HTMLElement>(".annotationLayer");
    if (!layer) return;
    const ids = new Set(this.#suppressed);
    for (const a of this.#adopted.values()) if (a.popupRef) ids.add(a.popupRef);
    for (const element of layer.querySelectorAll<HTMLElement>("[data-annotation-id]")) {
      const id = element.dataset.annotationId!;
      if (ids.has(id) || element.classList.contains("popupAnnotation")
        && this.#others.some((o) => o.page === page && element.getAttribute("aria-labelledby")?.includes(o.id))) element.hidden = true;
    }
    for (const other of this.#others) {
      if (other.page !== page) continue;
      const element = layer.querySelector<HTMLElement>(`[data-annotation-id="${other.id}"]`);
      // Keep the element (a sticky note's icon may be drawn by it), but not pdf.js's pop-up on click or hover.
      if (element) element.classList.add("folio-note-source");
    }
  }

  clearSaved(generation: number) {
    if (generation <= this.#storageGeneration) return;
    this.#storageGeneration = generation;
    if (!this.#persist) return;
    this.#generation++;
    this.quickHighlighting = false;
    window.clearTimeout(this.#saveTimer);
    this.#restoring.clear();
    this.#pending.clear();
    this.#known.clear();
    this.#note = "";
    this.#bookmarkedPages = [];
    for (const editor of this.#liveEditors()) editor.remove();
    this.#emit();
  }

  async #restorePage(page: number) {
    const marks = this.#pending.get(page);
    const layer = this.#ui?.getLayer(page);
    if (!marks?.length || !layer || this.#restoring.has(page)) return;
    this.#restoring.add(page);
    const generation = this.#generation;
    try {
      let added = false;
      // Marks pdf.js couldn't bring back stay pending, which keeps their saved records (and Notes entries) intact.
      const missed: Mark[] = [];
      for (const mark of marks) {
        // pdf.js only puts a text box's saved text on the page when the box is recreated as a copy; without it
        // the box comes back empty and the next sync drops it. isClone stops the copy being offset like a paste
        // (the same steps pdf.js takes when it duplicates a page).
        const textBox = mark.type === "freetext";
        const editor = await layer.deserialize({ ...mark.data, deleted: false, annotationElementId: null, isCopy: textBox }).catch(() => null);
        if (generation !== this.#generation) return;
        if (!editor) {
          missed.push(mark);
          continue;
        }
        editor.__folioMark = mark.id;
        editor.__folioGeneration = this.#storageGeneration;
        if (mark.type === "highlight") editor.__folioText = mark.text;
        editor.__folioShape = mark.shape;
        if (textBox) editor.isClone = true;
        layer.add(editor);
        // An empty editor would be thrown away by pdf.js (and its mark with it) at the next tool change.
        if (editor.isEmpty()) {
          editor.remove();
          missed.push(mark);
          continue;
        }
        if (textBox) this.#moveTo(editor, mark.data.rect);
        if (mark.note) this.#setEditorNote(editor, mark.note);
        added = true;
      }
      // pdf.js hides an editor layer that was empty when its page rendered, and saved marks arrive after that.
      if (added) layer.div.hidden = false;
      if (missed.length) this.#pending.set(page, missed);
      else this.#pending.delete(page);
    } finally {
      if (generation === this.#generation) this.#restoring.delete(page);
    }
    this.scheduleSync();
  }

  /** Puts a restored text box back on its saved rectangle: pdf.js nudges a new box by its font size when it's first drawn. */
  #moveTo(editor: Editor, rect: unknown) {
    if (!Array.isArray(rect)) return;
    try {
      const [pageWidth, pageHeight] = editor.pageDimensions;
      const [wantX, wantY] = editor.getRectInCurrentCoords(rect, pageHeight);
      const [haveX, haveY] = editor.getRectInCurrentCoords(editor.getPDFRect(), pageHeight);
      editor.x += (wantX - haveX) / pageWidth;
      editor.y += (wantY - haveY) / pageHeight;
      editor.fixAndSetPosition();
    } catch {
      /* the text is restored either way */
    }
  }

  #setEditorNote(editor: Editor, note: string) {
    try {
      // Stored on the pdf.js editor too, so saved copies of the PDF carry the note as a pop-up.
      (editor as unknown as { comment: string }).comment = note;
    } catch {
      /* the note still lives in Folio's own record */
    }
  }

  #liveEditors(): Editor[] {
    const ui = this.#ui;
    const count = this.#viewer.pagesCount;
    if (!ui || !count) return [];
    const editors: Editor[] = [];
    for (let page = 0; page < count; page++) {
      for (const editor of ui.getEditors(page)) {
        if (SAVED_TYPES[editor.constructor._type ?? ""] && !editor.annotationElementId && !editor.deleted) editors.push(editor);
      }
    }
    return editors;
  }

  async addShape(page: number, shape: NonNullable<Mark["shape"]>, data: Record<string, unknown>) {
    const layer = this.#ui?.getLayer(page);
    if (!layer) throw new Error("The page is not ready.");
    const editor = await layer.deserialize(data);
    if (this.#ui?.getLayer(page) !== layer) return;
    if (!editor) throw new Error("The drawing could not be created.");
    editor.__folioShape = shape;
    layer.add(editor);
    this.sync();
  }

  scheduleSync() {
    window.clearTimeout(this.#syncTimer);
    this.#syncTimer = window.setTimeout(() => this.sync(), 250);
  }

  /** Reads every live editor back into records, then saves. Returns ids of newly seen marks. */
  sync(): string[] {
    window.clearTimeout(this.#syncTimer);
    if (!this.#docId) return [];
    const fresh: string[] = [];
    const live = new Map<string, Mark>();
    for (const editor of this.#liveEditors()) {
      // pdf.js can reattach a removed editor through its Undo history.
      if (this.#persist && editor.__folioGeneration !== undefined && editor.__folioGeneration < this.#storageGeneration) {
        editor.remove();
        continue;
      }
      editor.__folioGeneration = this.#storageGeneration;
      if (editor.isEmpty()) {
        // A saved mark whose editor reads empty (a text box cleared but not yet committed) keeps its record until
        // the edit is committed. Removing a mark removes its editor, so deletes still work.
        const previous = editor.__folioMark ? this.#known.get(editor.__folioMark) : undefined;
        if (previous) live.set(previous.id, previous);
        continue;
      }
      let data: Record<string, unknown> | null = null;
      try { data = editor.serialize(false); } catch { data = null; }
      if (!data) continue;
      if (!editor.__folioMark) {
        editor.__folioMark = newId();
        fresh.push(editor.__folioMark);
        if (data.quadPoints) editor.__folioText = this.#selectionText;
      }
      const previous = this.#known.get(editor.__folioMark);
      const type = SAVED_TYPES[editor.constructor._type!];
      const comment = editor.comment;
      const text = type === "highlight" ? previous?.text || editor.__folioText || ""
        : type === "freetext" ? String(data.value ?? "") : "";
      const mark: Mark = {
        id: editor.__folioMark,
        type,
        ...(editor.__folioShape && { shape: editor.__folioShape }),
        page: editor.pageIndex,
        text,
        note: comment && !comment.deleted ? comment.text ?? "" : previous?.note ?? "",
        color: toHex(data.color),
        createdAt: previous?.createdAt ?? Date.now(),
        ...(previous?.source && { source: previous.source }),
        ...(previous?.author && { author: previous.author }),
        data: { ...data, id: undefined, popupRef: undefined },
      };
      live.set(mark.id, mark);
    }
    // Marks on pages that haven't rendered yet are kept as saved.
    for (const marks of this.#pending.values()) for (const mark of marks) live.set(mark.id, mark);
    const changed = live.size !== this.#known.size
      || [...live.values()].some((mark) => JSON.stringify(mark) !== JSON.stringify(this.#known.get(mark.id)));
    this.#known = live;
    if (changed) {
      this.#emit();
      this.#scheduleSave();
    }
    return fresh;
  }

  #sorted() {
    return [...this.#known.values()].sort((a, b) => {
      if (a.page !== b.page) return a.page - b.page;
      const ra = a.data.rect as number[] | undefined;
      const rb = b.data.rect as number[] | undefined;
      // PDF y grows upward: higher on the page first.
      return (rb?.[3] ?? 0) - (ra?.[3] ?? 0) || a.createdAt - b.createdAt;
    });
  }

  #emit() {
    this.#listener(this.state);
  }

  #scheduleSave() {
    if (!this.#persist) return;
    window.clearTimeout(this.#saveTimer);
    this.#saveTimer = window.setTimeout(() => this.flush(), 400);
  }

  flush() {
    window.clearTimeout(this.#saveTimer);
    if (!this.#persist || !this.#docId) return;
    const notes: DocNotes = { id: this.#docId, note: this.#note, marks: [...this.#known.values()],
      bookmarkedPages: this.#bookmarkedPages ?? [], adopted: [...this.#adopted.values()], updatedAt: Date.now() };
    return saveNotes(notes, this.#storageGeneration);
  }

  /**
   * Saved marks on pages pdf.js hasn't drawn yet, serialized like their editors would be. pdf.js only recreates a
   * mark's editor (and adds it to its annotation storage) when the page renders, so saved copies and printouts
   * need these added to include every mark.
   */
  async unrenderedMarks(pdf: PDFDocumentProxy): Promise<Record<string, unknown>[]> {
    const generation = this.#generation;
    const marks: Record<string, unknown>[] = [];
    for (const [pageIndex, pending] of this.#pending) {
      const [, , pageRight] = (await pdf.getPage(pageIndex + 1)).view;
      if (generation !== this.#generation) throw new Error("The document changed.");
      for (const mark of pending) {
        const data: Record<string, unknown> = { ...mark.data, pageIndex, deleted: false };
        const top = (mark.data.rect as number[] | undefined)?.[3];
        // The pop-up pdf.js gives an editor's comment (see AnnotationEditor.addComment).
        if (mark.note && top !== undefined) data.popup = { contents: mark.note, deleted: false, rect: [pageRight + 1, top - 100, pageRight + 181, top] };
        marks.push(this.#replacing(mark, data));
      }
    }
    // Highlights taken over from the PDF and since deleted: remove the originals, and the replies to them.
    const live = new Set([...this.#known.values()].map((m) => m.source).filter(Boolean));
    for (const a of this.#adopted.values()) {
      if (live.has(a.id)) continue;
      for (const r of [a, ...a.replies ?? []]) marks.push({ id: r.id, popupRef: r.popupRef, pageIndex: a.page, deleted: true });
    }
    return marks;
  }

  /** A taken-over highlight's saved data, set to replace its original in the PDF (keeping its author and replies). */
  #replacing(mark: Mark, data: Record<string, unknown>) {
    const original = mark.source ? this.#adopted.get(mark.source) : undefined;
    if (!original) return data;
    data.id = original.id;
    data.popupRef = original.popupRef;
    // A note that was cleared: remove the original's note too, not just leave it unchanged.
    if (!mark.note && !data.popup) data.popup = { deleted: true };
    return data;
  }

  /**
   * While a copy is saved or printed, Folio's highlights that came from the PDF replace their originals instead of
   * being added next to them. Returns the undo.
   */
  replaceOriginalsWhileSaving(): () => void {
    const undo: (() => void)[] = [];
    for (const editor of this.#liveEditors()) {
      const mark = editor.__folioMark ? this.#known.get(editor.__folioMark) : undefined;
      if (!mark?.source || !this.#adopted.has(mark.source)) continue;
      const own = Object.prototype.hasOwnProperty.call(editor, "serialize") ? editor.serialize : undefined;
      const serialize = editor.serialize;
      editor.serialize = (isForCopying?: boolean, ...rest: unknown[]) => {
        const data = (serialize as (...args: unknown[]) => Record<string, unknown> | null).call(editor, isForCopying, ...rest);
        if (!data || isForCopying || data.deleted) return data;
        const current = this.#known.get(mark.id) ?? mark;
        return this.#replacing(current, { ...data });
      };
      undo.push(() => { if (own) editor.serialize = own; else delete (editor as Partial<Editor>).serialize; });
    }
    return () => undo.forEach((u) => u());
  }

  /** Highlights the current text selection in one click. Resolves to the new mark's id. */
  async highlightSelection(color: string): Promise<string | null> {
    const generation = this.#generation;
    const ui = this.#ui;
    const selection = document.getSelection();
    if (!ui || !selection || selection.isCollapsed) return null;
    // A page's text can be selected before pdf.js has finished drawing the page, but its highlight layer only exists
    // afterwards, and pdf.js drops a highlight (and the selection) on a page without one. Wait for the layer.
    const anchor = selection.anchorNode instanceof Element ? selection.anchorNode : selection.anchorNode?.parentElement;
    const page = Number((anchor?.closest(".page") as HTMLElement | null)?.dataset.pageNumber);
    for (let i = 0; i < 200 && page && !ui.getLayer(page - 1); i++) {
      await new Promise((r) => setTimeout(r, 25));
      if (generation !== this.#generation) return null;
    }
    if (selection.isCollapsed) return null;
    this.sync();
    const before = new Set(this.#liveEditors().map((e) => e.id));
    this.#selectionText = selection.toString().replace(/\s+/g, " ").trim();
    this.quickHighlighting = true;
    try {
      this.#bus.dispatch("switchannotationeditorparams", { source: null, type: AnnotationEditorParamsType.HIGHLIGHT_COLOR, value: color });
      ui.highlightSelection("floating_button");
      // pdf.js clears the selection when it goes ahead; if it's still there, pdf.js found nothing to highlight.
      if (!selection.isCollapsed) return null;
      // pdf.js switches into highlight mode, creates the editor, and we return to reading mode. The switch first
      // redraws the visible pages, which can take seconds on a busy computer, and returning to reading mode before
      // it finishes cancels it and loses the highlight, so give it plenty of time.
      let created: Editor | undefined;
      for (let i = 0; i < 400 && !created; i++) {
        await new Promise((r) => setTimeout(r, 25));
        if (generation !== this.#generation) return null;
        created = this.#liveEditors().find((e) => !before.has(e.id) && !e.isEmpty());
      }
      // pdf.js focuses the new highlight. Leaving highlight mode with it focused moves focus to the current page's
      // highlight layer, and throws if that page hasn't drawn one yet, which leaves pdf.js stuck mid-switch and
      // every later highlight ignored. Nothing needs the focus, so drop it first.
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && focused.closest(".annotationEditorLayer")) focused.blur();
      this.#viewer.annotationEditorMode = { mode: AnnotationEditorType.NONE };
      await new Promise((r) => setTimeout(r, 0));
      if (!created || generation !== this.#generation) return null;
      this.sync();
      return created.__folioMark ?? null;
    } finally {
      if (generation === this.#generation) this.quickHighlighting = false;
    }
  }

  #editorFor(markId: string) {
    return this.#liveEditors().find((e) => e.__folioMark === markId);
  }

  /** The highlight under a screen point (pdf.js highlights don't take clicks while reading), with its screen box. */
  markAt(clientX: number, clientY: number): { id: string; rect: { left: number; top: number; right: number; bottom: number } } | null {
    for (const editor of this.#liveEditors()) {
      if (editor.constructor._type !== "highlight" || !editor.__folioMark) continue;
      const view = this.#viewer.getPageView(editor.pageIndex) as unknown as
        { div?: HTMLElement; viewport?: { convertToViewportPoint(x: number, y: number): number[] } } | undefined;
      const surface = view?.div?.querySelector(".canvasWrapper") ?? view?.div;
      if (!surface || !view?.viewport) continue;
      const box = surface.getBoundingClientRect();
      if (clientY < box.top || clientY > box.bottom || clientX < box.left || clientX > box.right) continue;
      const quads = (this.#known.get(editor.__folioMark)?.data.quadPoints ?? editor.serialize(false)?.quadPoints) as ArrayLike<number> | undefined;
      if (!quads) continue;
      const q = Array.from(quads);
      const hits: { left: number; top: number; right: number; bottom: number }[] = [];
      for (let i = 0; i + 7 < q.length; i += 8) {
        const corners = [0, 2, 4, 6].map((k) => view.viewport!.convertToViewportPoint(q[i + k], q[i + k + 1]));
        const xs = corners.map((c) => box.left + c[0]);
        const ys = corners.map((c) => box.top + c[1]);
        hits.push({ left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) });
      }
      if (hits.some((r) => clientX >= r.left - 2 && clientX <= r.right + 2 && clientY >= r.top - 2 && clientY <= r.bottom + 2)) {
        return {
          id: editor.__folioMark,
          rect: {
            left: Math.min(...hits.map((r) => r.left)), right: Math.max(...hits.map((r) => r.right)),
            top: Math.min(...hits.map((r) => r.top)), bottom: Math.max(...hits.map((r) => r.bottom)),
          },
        };
      }
    }
    return null;
  }

  recolor(markId: string, hex: string) {
    const editor = this.#editorFor(markId) as (Editor & { updateParams?: (type: number, value: string) => void }) | undefined;
    editor?.updateParams?.(AnnotationEditorParamsType.HIGHLIGHT_COLOR, hex);
    this.scheduleSync();
  }

  markForEditorId(editorId: string) {
    const editor = this.#ui?.getEditor(editorId);
    return editor?.__folioMark ?? null;
  }

  setNote(markId: string, note: string) {
    const editor = this.#editorFor(markId);
    if (editor) this.#setEditorNote(editor, note);
    const known = this.#known.get(markId);
    if (known) this.#known.set(markId, { ...known, note });
    for (const marks of this.#pending.values()) {
      const pending = marks.find((m) => m.id === markId);
      if (pending) pending.note = note;
    }
    this.#emit();
    this.#scheduleSave();
    if (editor) this.scheduleSync();
  }

  setDocNote(note: string) {
    this.#note = note;
    this.#emit();
    this.#scheduleSave();
  }

  toggleBookmark(page: number) {
    const pages = this.#bookmarkedPages;
    if (!pages || !Number.isInteger(page) || page < 1 || page > this.#viewer.pagesCount) return;
    this.#bookmarkedPages = pages.includes(page)
      ? pages.filter(n => n !== page)
      : [...pages, page].sort((a, b) => a - b);
    this.#emit();
    this.#scheduleSave();
  }

  remove(markId: string) {
    const editor = this.#editorFor(markId);
    if (editor) editor.remove();
    for (const [page, marks] of this.#pending) {
      const rest = marks.filter((m) => m.id !== markId);
      if (rest.length) this.#pending.set(page, rest);
      else this.#pending.delete(page);
    }
    this.#known.delete(markId);
    this.#emit();
    this.#scheduleSave();
  }

  /** Scrolls a mark into view and briefly pulses it. */
  reveal(markId: string) {
    const mark = this.#known.get(markId);
    if (!mark) return;
    const rect = mark.data.rect as number[] | undefined;
    this.#viewer.scrollPageIntoView({
      pageNumber: mark.page + 1,
      destArray: rect ? [null, { name: "XYZ" }, null, rect[3] + 48, null] : undefined,
    } as Parameters<PDFViewer["scrollPageIntoView"]>[0]);
    window.setTimeout(() => {
      const div = this.#editorFor(markId)?.div;
      if (!div) return;
      div.classList.remove("folio-pulse");
      void div.offsetWidth;
      div.classList.add("folio-pulse");
    }, 350);
  }
}
