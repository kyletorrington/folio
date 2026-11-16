import { PDFDocument, PDFName, PDFString, StandardFonts } from "pdf-lib";

// A PDF commented the way Adobe Acrobat does it: a highlight with a note, an author and a pop-up, a reply to it,
// a sticky note, and an underline with a note.
export async function adobeCommentedPdf() {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([480, 520]);
  page.drawText("Rent is due on the first day of each month.", { x: 38, y: 435, size: 16, font });
  page.drawText("The deposit is two months of rent.", { x: 38, y: 395, size: 16, font });
  const ctx = pdf.context;
  const annots = [];
  const add = (dict) => { const ref = ctx.register(ctx.obj(dict)); annots.push(ref); return ref; };
  const w1 = font.widthOfTextAtSize("Rent is due", 16);
  const highlight = add({ Type: "Annot", Subtype: "Highlight", Rect: [38, 430, 38 + w1, 452], F: 4, C: [1, 0.9, 0.2], CA: 1,
    QuadPoints: [38, 452, 38 + w1, 452, 38, 430, 38 + w1, 430],
    Contents: PDFString.of("Check the date with the landlord."), T: PDFString.of("Alex Adobe"), NM: PDFString.of("hl-1") });
  const popup = add({ Type: "Annot", Subtype: "Popup", Rect: [480, 350, 660, 452], F: 28, Open: false, Parent: highlight });
  ctx.lookup(highlight).set(PDFName.of("Popup"), popup);
  add({ Type: "Annot", Subtype: "Text", Rect: [38, 430, 58, 450], F: 28, Name: "Comment", C: [1, 0.9, 0.2],
    Contents: PDFString.of("Agreed, it moved to the 5th."), T: PDFString.of("Sam Reviewer"), IRT: highlight, RT: "R" });
  add({ Type: "Annot", Subtype: "Text", Rect: [420, 470, 440, 490], F: 28, Name: "Comment", C: [1, 0.6, 0],
    Contents: PDFString.of("Who signs for the tenant?"), T: PDFString.of("Sam Reviewer") });
  const w2 = font.widthOfTextAtSize("two months", 16), x2 = 38 + font.widthOfTextAtSize("The deposit is ", 16);
  add({ Type: "Annot", Subtype: "Underline", Rect: [x2, 390, x2 + w2, 412], F: 4, C: [0, 0.4, 1],
    QuadPoints: [x2, 412, x2 + w2, 412, x2, 390, x2 + w2, 390],
    Contents: PDFString.of("Too high for this area."), T: PDFString.of("Jo Lawyer") });
  page.node.set(PDFName.of("Annots"), ctx.obj(annots));
  return pdf.save();
}
