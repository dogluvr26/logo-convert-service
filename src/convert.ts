// logo-convert-service — PDF / AI / EPS logo files to trimmed SVG.
// Copyright (C) 2026 Strategic Gifting, LLC
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or (at your
// option) any later version. It is distributed WITHOUT ANY WARRANTY; see the
// LICENSE file for details.

/**
 * Converts a vector logo file to an SVG:
 *
 *   EPS / PostScript  → Ghostscript (WASM, unmodified) → PDF
 *   PDF / AI          → MuPDF (WASM, unmodified) → SVG, text drawn as paths
 *
 * Files are recognized by content, not extension: Adobe Stock ".ai" files
 * are sometimes binary EPS, and an AI file saved with PDF compatibility is a
 * PDF. Only the first page (the first artboard) is used, and the SVG is
 * trimmed to its visible artwork (measured from an alpha render).
 *
 * Warnings (never blocking): text that wasn't outlined and whose font isn't
 * in the file, so it had to be drawn with a substitute; spot colors; extra
 * pages/artboards. They're also written into the SVG's
 * <metadata id="kimber-oak-logo-conversion"> as JSON, so they travel with it.
 */

export class LogoConversionError extends Error {}

export type LogoConversion = {
  svg: string;
  warnings: string[];
  /** What the file really was. */
  source: "pdf" | "eps";
  pages: number;
};

/** The <metadata> element's id in converted SVGs (clients read the warnings from it). */
export const CONVERSION_METADATA_ID = "kimber-oak-logo-conversion";

/** Long side of the render used to find the visible artwork. */
const BOUNDS_RENDER_PX = 2048;

const STANDARD_FONTS = /^(Helvetica|Times|Courier|Symbol|ZapfDingbats|Arial|TimesNewRoman)/i;

export function detectVectorFormat(bytes: Uint8Array): "pdf" | "eps" | null {
  const head = Buffer.from(bytes.subarray(0, 1024)).toString("latin1");
  if (head.includes("%PDF-")) return "pdf";
  // DOS EPS binary header (EPS with a TIFF/WMF preview), or plain PostScript.
  if (bytes[0] === 0xc5 && bytes[1] === 0xd0 && bytes[2] === 0xd3 && bytes[3] === 0xc6) return "eps";
  if (head.startsWith("%!")) return "eps";
  return null;
}

/** EPS → PDF with Ghostscript. Returns the PDF and the fonts it had to
 *  substitute ("Substituting font X for Y." on its output). */
async function epsToPdf(eps: Uint8Array): Promise<{ pdf: Uint8Array; substituted: { font: string; with: string }[] }> {
  const { default: loadGhostscript } = await import("@okathira/ghostpdl-wasm");
  const log: string[] = [];
  const gs = await loadGhostscript({ print: (s: string) => log.push(s), printErr: (s: string) => log.push(s) });
  gs.FS.writeFile("/in.eps", eps);
  const code = gs.callMain([
    "-dSAFER",
    "-dBATCH",
    "-dNOPAUSE",
    "-dEPSCrop",
    "-dNOPLATFONTS",
    "-sDEVICE=pdfwrite",
    "-sOutputFile=/out.pdf",
    "/in.eps",
  ]);
  let pdf: Uint8Array | null = null;
  try {
    pdf = gs.FS.readFile("/out.pdf");
  } catch {
    // no output
  }
  if (code !== 0 || !pdf?.length) {
    const detail = log.filter((l) => /error/i.test(l)).slice(-2).join(" ");
    throw new LogoConversionError(`Ghostscript couldn't read this EPS file${detail ? ` (${detail})` : ""}.`);
  }
  const substituted = [...log.join("\n").matchAll(/Substituting font (\S+) for (\S+?)\.?$/gm)].map((m) => ({
    font: m[2],
    with: m[1],
  }));
  return { pdf, substituted };
}

type Mupdf = typeof import("mupdf");
type PDFObject = import("mupdf").PDFObject;

const resolved = (o: PDFObject): PDFObject => (o.isIndirect() ? o.resolve() : o);
const nameOf = (o: PDFObject): string => (o.isName() ? o.asName() : "");
const withoutSubset = (name: string) => name.replace(/^[A-Z]{6}\+/, "");

/** Fonts that aren't in the file and spot colors, from the page's resources
 *  (forms, patterns, shadings and soft masks included). */
function inspectResources(page: PDFObject): { missingFonts: string[]; spots: string[] } {
  const missing = new Set<string>();
  const spots = new Set<string>();
  const seen = new Set<number>();

  function colorSpace(cs: PDFObject) {
    cs = resolved(cs);
    if (!cs.isArray() || cs.length === 0) return;
    const kind = nameOf(resolved(cs.get(0)));
    const addSpot = (n: string) => {
      if (n && n !== "All" && n !== "None") spots.add(n);
    };
    if (kind === "Separation") addSpot(nameOf(resolved(cs.get(1))));
    else if (kind === "DeviceN") resolved(cs.get(1)).forEach((v) => addSpot(nameOf(resolved(v))));
    else if (kind === "Indexed" || (kind === "Pattern" && cs.length > 1)) colorSpace(cs.get(1));
  }

  function font(f: PDFObject) {
    f = resolved(f);
    const subtype = nameOf(f.get("Subtype"));
    if (subtype === "Type3") return; // drawn from the file's own glyph procedures
    let descriptor = resolved(f.get("FontDescriptor"));
    if (subtype === "Type0") {
      const descendants = resolved(f.get("DescendantFonts"));
      if (descendants.isArray() && descendants.length) descriptor = resolved(resolved(descendants.get(0)).get("FontDescriptor"));
    }
    const embedded =
      descriptor.isDictionary() && ["FontFile", "FontFile2", "FontFile3"].some((k) => !descriptor.get(k).isNull());
    if (!embedded) missing.add(withoutSubset(nameOf(f.get("BaseFont")) || "an unnamed font"));
  }

  function resources(res: PDFObject) {
    if (res.isIndirect()) {
      const id = res.asIndirect();
      if (seen.has(id)) return;
      seen.add(id);
    }
    res = resolved(res);
    if (!res.isDictionary()) return;
    resolved(res.get("Font")).forEach((f) => font(f));
    resolved(res.get("ColorSpace")).forEach((cs) => colorSpace(cs));
    resolved(res.get("XObject")).forEach((x) => {
      const xo = resolved(x);
      if (nameOf(xo.get("Subtype")) === "Form") resources(xo.get("Resources"));
      else colorSpace(xo.get("ColorSpace"));
    });
    resolved(res.get("Pattern")).forEach((p) => {
      const pattern = resolved(p);
      resources(pattern.get("Resources"));
      colorSpace(resolved(pattern.get("Shading")).get("ColorSpace"));
    });
    resolved(res.get("Shading")).forEach((s) => colorSpace(resolved(s).get("ColorSpace")));
    resolved(res.get("ExtGState")).forEach((g) => {
      const mask = resolved(resolved(g).get("SMask"));
      if (mask.isDictionary()) resources(resolved(mask.get("G")).get("Resources"));
    });
  }

  resources(page.getInheritable("Resources"));
  return { missingFonts: [...missing], spots: [...spots] };
}

/** The page's visible artwork in page units, from an alpha render, padded
 *  by one render pixel so anti-aliased edges aren't cut. */
function visibleBounds(mupdf: Mupdf, page: import("mupdf").Page): [number, number, number, number] | null {
  const b = page.getBounds();
  const scale = BOUNDS_RENDER_PX / Math.max(b[2] - b[0], b[3] - b[1]);
  const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, true, false);
  const w = pix.getWidth();
  const h = pix.getHeight();
  const n = pix.getStride() / w; // bytes per pixel, alpha last
  const px = pix.getPixels();
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w * n;
    for (let x = 0; x < w; x++) {
      if (px[row + x * n + n - 1] === 0) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;
  const ox = pix.getX();
  const oy = pix.getY();
  return [
    Math.max(b[0], (ox + x0 - 1) / scale),
    Math.max(b[1], (oy + y0 - 1) / scale),
    Math.min(b[2], (ox + x1 + 2) / scale),
    Math.min(b[3], (oy + y1 + 2) / scale),
  ];
}

const list = (names: string[]) =>
  names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

export async function convertVectorLogo(bytes: Uint8Array, fileName: string): Promise<LogoConversion> {
  const source = detectVectorFormat(bytes);
  if (!source) throw new LogoConversionError(`${fileName} isn't a PDF, AI or EPS file that can be read.`);

  let pdfBytes = bytes;
  let substituted: { font: string; with: string }[] = [];
  if (source === "eps") ({ pdf: pdfBytes, substituted } = await epsToPdf(bytes));

  const mupdf = await import("mupdf");
  mupdf.setLog(null);
  let doc: import("mupdf").Document;
  try {
    doc = mupdf.Document.openDocument(pdfBytes, "application/pdf");
  } catch {
    throw new LogoConversionError(`${fileName} couldn't be opened as a PDF.`);
  }
  const pages = doc.countPages();
  if (pages === 0) throw new LogoConversionError(`${fileName} has no pages.`);
  const page = doc.loadPage(0);

  // Illustrator files saved without "Create PDF Compatible File" hold only a
  // placeholder page saying so.
  const text = page.toStructuredText("preserve-whitespace").asText();
  if (/saved without PDF Content/i.test(text)) {
    throw new LogoConversionError(
      `${fileName} was saved without PDF content. Re-save it from Illustrator with "Create PDF Compatible File" turned on, or export a PDF.`
    );
  }

  const bounds = visibleBounds(mupdf, page);
  if (!bounds) throw new LogoConversionError(`The first ${source === "pdf" ? "page or artboard" : "page"} of ${fileName} is empty.`);

  const warnings: string[] = [];
  const pdfPage = (page as import("mupdf").PDFPage).getObject?.();
  const { missingFonts, spots } = pdfPage ? inspectResources(pdfPage) : { missingFonts: [], spots: [] };
  const fonts = new Map<string, string | null>();
  for (const s of substituted) fonts.set(withoutSubset(s.font), s.with);
  for (const f of missingFonts) if (!fonts.has(f)) fonts.set(f, null);
  if (fonts.size) {
    const names = [...fonts.keys()];
    const subs = [...fonts].filter(([, w]) => w).map(([f, w]) => `${w} for ${f}`);
    const standardOnly = names.every((n) => STANDARD_FONTS.test(n));
    warnings.push(
      `Text in ${fileName} wasn't outlined and its font${names.length > 1 ? "s" : ""} (${list(names)}) ${
        names.length > 1 ? "aren't" : "isn't"
      } in the file, so it was drawn with a substitute${subs.length ? ` (${subs.join(", ")})` : ""}${
        standardOnly ? " — a close standard match" : ""
      }. Check the lettering, or outline the text (Illustrator: Type → Create Outlines) and upload again.`
    );
  }
  if (spots.length) {
    warnings.push(
      `${fileName} uses spot color${spots.length > 1 ? "s" : ""} (${list(spots)}), which print${
        spots.length > 1 ? "" : "s"
      } as process CMYK here. If the job needs spot ink, set it up by hand.`
    );
  }
  if (pages > 1) warnings.push(`${fileName} has ${pages} pages or artboards; only the first is used.`);

  // Text is written as paths, so the SVG never depends on fonts.
  const out = new mupdf.Buffer();
  const writer = new mupdf.DocumentWriter(out, "svg", "text=path");
  const device = writer.beginPage(page.getBounds());
  page.run(device, mupdf.Matrix.identity);
  writer.endPage();
  writer.close();
  let svg = out.asString();

  // Trim to the visible artwork: the page's coordinates are the SVG's.
  const [x0, y0, x1, y1] = bounds.map((v) => +v.toFixed(3));
  const w = +(x1 - x0).toFixed(3);
  const h = +(y1 - y0).toFixed(3);
  svg = svg.replace(/<svg\b[^>]*>/, (tag) =>
    tag
      .replace(/\swidth="[^"]*"/, ` width="${w}"`)
      .replace(/\sheight="[^"]*"/, ` height="${h}"`)
      .replace(/\sviewBox="[^"]*"/, ` viewBox="${x0} ${y0} ${w} ${h}"`)
  );
  const meta = JSON.stringify({ source: fileName, format: source, warnings })
    .replace(/&/g, "\\u0026")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e");
  svg = svg.replace(/<svg\b[^>]*>/, (tag) => `${tag}\n<metadata id="${CONVERSION_METADATA_ID}">${meta}</metadata>`);

  return { svg, warnings, source, pages };
}
