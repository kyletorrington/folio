// A small note icon at the end of every highlight that has a note, drawn on the page itself (like a PDF editor's
// comment icon), so notes can be found while reading and not only in the Notes tab. Hovering it shows the note.
import type { PDFViewer } from "./viewer";
import type { Mark } from "./markup";

interface PageView {
  div?: HTMLElement;
  viewport?: { width: number; height: number; convertToViewportPoint(x: number, y: number): number[] };
}

const ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
  + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 4.5h14a1 1 0 0 1 1 1V15l-5 4.5H5a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1Z" />'
  + '<path d="M15 19.5V15h5M8 9h8M8 12.5h5" /></svg>';

export const hasNote = (mark: Mark) => mark.type === "highlight" && !!mark.note.trim();

/**
 * Redraws the icons on every drawn page. pdf.js clears a page's extra layers when it redraws the page (zoom, rotation),
 * so this runs again after each page render. Positions are in percent of the page, so they follow zooming.
 */
export function drawNoteMarkers(viewer: PDFViewer, marks: Mark[]) {
  for (let i = 0; i < viewer.pagesCount; i++) {
    const view = viewer.getPageView(i) as unknown as PageView | undefined;
    const div = view?.div, viewport = view?.viewport;
    if (!div || !viewport) continue;
    const noted = marks.filter((m) => m.page === i && hasNote(m) && Array.isArray(m.data.rect));
    let layer = div.querySelector<HTMLElement>(":scope > .folio-note-layer");
    if (!noted.length) {
      layer?.remove();
      continue;
    }
    if (!layer) {
      layer = document.createElement("div");
      layer.className = "folio-note-layer";
      div.append(layer);
    }
    layer.replaceChildren(...noted.map((mark) => {
      const [x1, y1, x2, y2] = mark.data.rect as number[];
      // The corner that is top right on screen, whatever the page rotation.
      const corners = [[x1, y1], [x2, y1], [x1, y2], [x2, y2]].map(([x, y]) => viewport.convertToViewportPoint(x, y));
      const right = Math.max(...corners.map((c) => c[0]));
      const top = Math.min(...corners.map((c) => c[1]));
      const button = document.createElement("button");
      button.type = "button";
      button.className = "folio-note-marker";
      button.dataset.mark = mark.id;
      button.style.left = `${(100 * right) / viewport.width}%`;
      button.style.top = `${(100 * top) / viewport.height}%`;
      button.style.setProperty("--mark", mark.color);
      button.setAttribute("aria-label", "Note: " + (mark.note.length > 120 ? mark.note.slice(0, 120) + "…" : mark.note));
      button.innerHTML = ICON;
      return button;
    }));
  }
}
