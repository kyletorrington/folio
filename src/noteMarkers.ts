// A small note icon at the end of every highlight that has a note, drawn on the page itself (like a PDF editor's
// comment icon), so notes can be found while reading and not only in the Notes tab. Hovering it shows the note.
// Notes already in the PDF that Folio shows read-only (an underline's comment, say) get one too; sticky notes don't,
// as the PDF draws their icon itself.
import type { PDFViewer } from "./viewer";
import type { Mark, OtherNote } from "./markup";

interface PageView {
  div?: HTMLElement;
  viewport?: { width: number; height: number; convertToViewportPoint(x: number, y: number): number[] };
}

const ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
  + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 4.5h14a1 1 0 0 1 1 1V15l-5 4.5H5a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1Z" />'
  + '<path d="M15 19.5V15h5M8 9h8M8 12.5h5" /></svg>';

export const hasNote = (mark: Mark) => mark.type === "highlight" && !!mark.note.trim();

const short = (text: string) => text.length > 120 ? text.slice(0, 120) + "…" : text;

/**
 * Redraws the icons on every drawn page. pdf.js clears a page's extra layers when it redraws the page (zoom, rotation),
 * so this runs again after each page render. Positions are in percent of the page, so they follow zooming.
 */
export function drawNoteMarkers(viewer: PDFViewer, marks: Mark[], others: OtherNote[] = []) {
  for (let i = 0; i < viewer.pagesCount; i++) {
    const view = viewer.getPageView(i) as unknown as PageView | undefined;
    const div = view?.div, viewport = view?.viewport;
    if (!div || !viewport) continue;
    const items = [
      ...marks.filter((m) => m.page === i && hasNote(m) && Array.isArray(m.data.rect))
        .map((m) => ({ key: "mark", id: m.id, rect: m.data.rect as number[], color: m.color, note: m.note })),
      ...others.filter((o) => o.page === i && o.icon).map((o) => ({ key: "other", id: o.id, rect: o.rect, color: o.color, note: o.note })),
    ];
    let layer = div.querySelector<HTMLElement>(":scope > .folio-note-layer");
    if (!items.length) {
      layer?.remove();
      continue;
    }
    if (!layer) {
      layer = document.createElement("div");
      layer.className = "folio-note-layer";
      div.append(layer);
    }
    layer.replaceChildren(...items.map((item) => {
      const [x1, y1, x2, y2] = item.rect;
      // The corner that is top right on screen, whatever the page rotation.
      const corners = [[x1, y1], [x2, y1], [x1, y2], [x2, y2]].map(([x, y]) => viewport.convertToViewportPoint(x, y));
      const right = Math.max(...corners.map((c) => c[0]));
      const top = Math.min(...corners.map((c) => c[1]));
      const button = document.createElement("button");
      button.type = "button";
      button.className = "folio-note-marker";
      button.dataset[item.key] = item.id;
      button.style.left = `${(100 * right) / viewport.width}%`;
      button.style.top = `${(100 * top) / viewport.height}%`;
      button.style.setProperty("--mark", item.color);
      button.setAttribute("aria-label", "Note: " + short(item.note));
      button.innerHTML = ICON;
      return button;
    }));
  }
}

type Box = { left: number; top: number; right: number; bottom: number };

/** Screen boxes of an area on a page: its quadrilaterals when it marks text, else its rectangle. */
function screenBoxes(viewer: PDFViewer, page: number, rect: number[], quads?: number[]): Box[] {
  const view = viewer.getPageView(page) as unknown as PageView | undefined;
  const surface = view?.div?.querySelector(".canvasWrapper") ?? view?.div;
  if (!surface || !view?.viewport) return [];
  const box = surface.getBoundingClientRect();
  const shapes = quads && quads.length >= 8
    ? Array.from({ length: Math.floor(quads.length / 8) }, (_, k) => [0, 2, 4, 6].map((j) => [quads[k * 8 + j], quads[k * 8 + j + 1]]))
    : [[[rect[0], rect[1]], [rect[2], rect[3]]]];
  return shapes.map((points) => {
    const corners = points.map(([x, y]) => view.viewport!.convertToViewportPoint(x, y));
    const xs = corners.map((c) => box.left + c[0]), ys = corners.map((c) => box.top + c[1]);
    return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
  });
}

/** The read-only note under a screen point (a sticky note's icon, or the words an underline marks), with its box. */
export function otherAt(viewer: PDFViewer, others: OtherNote[], x: number, y: number): { id: string; rect: Box } | null {
  for (const other of others) {
    const boxes = screenBoxes(viewer, other.page, other.rect, other.quadPoints);
    if (boxes.some((r) => x >= r.left - 2 && x <= r.right + 2 && y >= r.top - 2 && y <= r.bottom + 2)) {
      return {
        id: other.id,
        rect: {
          left: Math.min(...boxes.map((r) => r.left)), right: Math.max(...boxes.map((r) => r.right)),
          top: Math.min(...boxes.map((r) => r.top)), bottom: Math.max(...boxes.map((r) => r.bottom)),
        },
      };
    }
  }
  return null;
}
