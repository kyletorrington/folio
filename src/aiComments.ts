// Comments the AI asks Folio to add: it ends an answer with a ```folio-comments block (see electron/ai-prompt.cjs),
// and each entry becomes a highlight on the quoted words with the comment as its note, like one added by hand.
import type { PDFDocumentProxy } from "./pdf";
import type { PDFViewer } from "./viewer";
import type { MarkupController } from "./markup";

export interface AiComment {
  /** One-based page the AI quoted from. */
  page: number;
  quote: string;
  comment: string;
}

export interface PlacedComment extends AiComment {
  /** The highlight it became, or absent when Folio couldn't find the quoted words. */
  markId?: string;
}

const FENCE = /```folio-comments[^\n]*\n([\s\S]*?)(?:```|$)/g;
const MAX_COMMENTS = 60;

/** Splits an answer into the text to show and the comments it asks for. `pending` while the block is still streaming. */
export function splitComments(answer: string): { text: string; comments: AiComment[]; pending: boolean } {
  const comments: AiComment[] = [];
  let pending = false;
  const text = answer.replace(FENCE, (block, body: string) => {
    if (!/```\s*$/.test(block.slice(3))) pending = true;
    else comments.push(...parseComments(body));
    return "";
  }).trim();
  return { text, comments: comments.slice(0, MAX_COMMENTS), pending };
}

function parseComments(body: string): AiComment[] {
  let list: unknown;
  try { list = JSON.parse(body); } catch { return []; }
  if (!Array.isArray(list)) return [];
  return list.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const { page, quote, comment } = item as Record<string, unknown>;
    if (typeof quote !== "string" || typeof comment !== "string" || !quote.trim() || !comment.trim()) return [];
    return [{ page: Number.isInteger(page) ? page as number : 0, quote: quote.trim().slice(0, 1000), comment: comment.trim().slice(0, 4000) }];
  });
}

// ── Finding the quoted words ─────────────────────────────────────────────────────────────
// Matching ignores case, spacing, line breaks, punctuation (so hyphenation and curly quotes too), soft hyphens and ligatures: the
// text the AI read joins lines with spaces, while a page's text layer often doesn't, and AIs drift on commas.
const SKIP = /[\s\p{P}\p{S}\p{Cf}]/u;
const STRIP = /[\s\p{P}\p{S}\p{Cf}]/gu;
const fold = (ch: string) => ch.normalize("NFKC").toLowerCase();
export function normalize(text: string) {
  let out = "";
  for (const ch of text) if (!SKIP.test(ch)) out += fold(ch).replace(STRIP, "");
  return out;
}

/** The candidate strings to look for: the whole quote, then its first half when the AI paraphrased the end. */
function needles(quote: string) {
  const whole = normalize(quote);
  const words = quote.split(/\s+/);
  const half = normalize(words.slice(0, Math.ceil(words.length / 2)).join(" "));
  return half.length >= 15 && half !== whole ? [whole, half] : [whole];
}

/** A DOM range over the quoted words in a rendered page's text layer. */
export function findInTextLayer(layer: HTMLElement, quote: string): Range | null {
  const chars: { node: Text; offset: number }[] = [];
  let haystack = "";
  const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const value = node.data;
    for (let i = 0; i < value.length; i++) {
      if (SKIP.test(value[i])) continue;
      const folded = fold(value[i]).replace(STRIP, "");
      for (let k = 0; k < folded.length; k++) chars.push({ node, offset: i });
      haystack += folded;
    }
  }
  for (const needle of needles(quote)) {
    if (!needle) continue;
    const at = haystack.indexOf(needle);
    if (at < 0) continue;
    const first = chars[at], last = chars[at + needle.length - 1];
    const range = document.createRange();
    range.setStart(first.node, first.offset);
    range.setEnd(last.node, last.offset + 1);
    return range;
  }
  return null;
}

const pageTexts = new WeakMap<PDFDocumentProxy, Map<number, Promise<string>>>();
function pageText(pdf: PDFDocumentProxy, n: number) {
  let cache = pageTexts.get(pdf);
  if (!cache) pageTexts.set(pdf, cache = new Map());
  let text = cache.get(n);
  if (!text) {
    text = pdf.getPage(n).then((p) => p.getTextContent())
      .then((c) => normalize(c.items.map((item) => ("str" in item ? item.str : "")).join("")));
    cache.set(n, text);
  }
  return text;
}

/** The page holding the quote: the one the AI named, then its neighbours, then any page. 0 if none. */
async function locate(pdf: PDFDocumentProxy, comment: AiComment) {
  const wanted = needles(comment.quote);
  const named = comment.page;
  const order = [named, named - 1, named + 1, ...Array.from({ length: pdf.numPages }, (_, i) => i + 1)]
    .filter((n, i, all) => n >= 1 && n <= pdf.numPages && all.indexOf(n) === i);
  for (const needle of wanted) {
    for (const n of order) if ((await pageText(pdf, n)).includes(needle)) return n;
  }
  return 0;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Scrolls a page into view and waits until pdf.js has drawn its text. */
async function renderedTextLayer(viewer: PDFViewer, n: number): Promise<HTMLElement | null> {
  viewer.currentPageNumber = n;
  for (let i = 0; i < 200; i++) {
    const div = (viewer.getPageView(n - 1) as unknown as { div?: HTMLElement } | undefined)?.div;
    const layer = div?.querySelector<HTMLElement>(".textLayer");
    if (layer?.querySelector(".endOfContent")) return layer;
    await sleep(25);
  }
  return null;
}

/**
 * Highlights each quote and attaches its comment, one at a time (pdf.js highlights a live text selection).
 * Returns every comment, with the highlight it became when its words were found. Stops early when `stillOpen` fails.
 */
export async function placeComments(viewer: PDFViewer, markup: MarkupController, comments: AiComment[], color: string,
  stillOpen: () => boolean): Promise<PlacedComment[]> {
  const pdf = viewer.pdfDocument as PDFDocumentProxy | null;
  const placed: PlacedComment[] = comments.map((c) => ({ ...c }));
  if (!pdf) return placed;
  (document.activeElement as HTMLElement | null)?.blur?.();
  for (const entry of placed) {
    if (!stillOpen()) break;
    const page = await locate(pdf, entry).catch(() => 0);
    if (!page || !stillOpen()) continue;
    const layer = await renderedTextLayer(viewer, page);
    const range = layer && findInTextLayer(layer, entry.quote);
    if (!range || !stillOpen()) continue;
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    const markId = await markup.highlightSelection(color).catch(() => null);
    if (!markId || !stillOpen()) continue;
    markup.setNote(markId, entry.comment);
    entry.page = page;
    entry.markId = markId;
  }
  document.getSelection()?.removeAllRanges();
  return placed;
}
