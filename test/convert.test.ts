// npm test
//
// Fixtures: an EPS with un-outlined text in a font that isn't in the file
// (Gotham-Book), standard Helvetica and a PANTONE spot color; PDFs made here
// with PDFKit (Montserrat Medium, SIL OFL 1.1 — see fixtures/Montserrat-OFL.txt).

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import PDFDocument from "pdfkit";

import { CONVERSION_METADATA_ID, LogoConversionError, convertVectorLogo, detectVectorFormat } from "../src/convert";

const FIXTURES = path.join(import.meta.dirname, "fixtures");
const EPS = fs.readFileSync(path.join(FIXTURES, "unoutlined-spot.eps"));

function pdf(draw: (doc: InstanceType<typeof PDFDocument>) => void): Promise<Buffer> {
  const doc = new PDFDocument({ size: "LETTER", margin: 0 });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));
  draw(doc);
  doc.end();
  return done;
}

const viewBox = (svg: string) => /<svg\b[^>]*\sviewBox="([^"]*)"/.exec(svg)![1].split(/\s+/).map(Number);

// ── Conversion ──

test("files are recognized by content, not extension", async () => {
  assert.equal(detectVectorFormat(EPS), "eps");
  assert.equal(detectVectorFormat(Uint8Array.from([0xc5, 0xd0, 0xd3, 0xc6, 0, 0])), "eps", "binary EPS header");
  assert.equal(detectVectorFormat(await pdf((d) => d.rect(0, 0, 10, 10).fill())), "pdf");
  assert.equal(detectVectorFormat(Buffer.from("\x89PNG\r\n")), null);
  await assert.rejects(convertVectorLogo(Buffer.from("\x89PNG\r\n"), "logo.ai"), LogoConversionError);
});

test("EPS: via Ghostscript, trimmed, font substitution and spot colors warned", async () => {
  const out = await convertVectorLogo(EPS, "acme.eps");
  assert.equal(out.source, "eps");
  // Artwork: text from x ≈ 120 and a box to x 380 in a 100–400 bounding box.
  const [x, , w, h] = viewBox(out.svg);
  assert.ok(Math.abs(x - 19.6) < 1.5 && Math.abs(w - 260.6) < 1.5, `trimmed to the artwork: ${viewBox(out.svg)}`);
  assert.ok(h < 150 - 30, "trimmed vertically too");
  const fonts = out.warnings.find((m) => m.includes("wasn't outlined"));
  assert.ok(fonts?.includes("Gotham-Book") && fonts.includes("Helvetica"), fonts);
  assert.ok(fonts?.includes("for Gotham-Book"), "names Ghostscript's substitute");
  assert.ok(out.warnings.some((m) => m.includes("PANTONE 186 C")), out.warnings.join(" | "));
  assert.equal(/<text\b/.test(out.svg), false, "text is drawn as paths");
  const meta = JSON.parse(new RegExp(`<metadata id="${CONVERSION_METADATA_ID}">([^<]*)</metadata>`).exec(out.svg)![1]);
  assert.deepEqual(meta.warnings, out.warnings, "warnings travel in the SVG");
  assert.ok(/fill="#e41838"/i.test(out.svg), "the spot color keeps its process look as a plain fill");
});

test("PDF with embedded fonts: no warnings, first page only, trimmed", async () => {
  const font = fs.readFileSync(path.join(FIXTURES, "Montserrat-Medium.ttf"));
  const file = await pdf((d) => {
    d.registerFont("M", font);
    d.font("M").fontSize(40).fillColor("#1F2A44").text("Acme", 200, 300, { lineBreak: false });
    d.circle(420, 320, 30).fill("#B08D57");
    d.addPage();
    d.rect(0, 0, 100, 100).fill("#FF0000");
  });
  const out = await convertVectorLogo(file, "acme.pdf");
  assert.deepEqual(out.warnings, ["acme.pdf has 2 pages or artboards; only the first is used."]);
  const [x, y, w, h] = viewBox(out.svg);
  assert.ok(Math.abs(x - 200) < 5 && Math.abs(x + w - 450) < 2, `x trimmed: ${[x, y, w, h]}`);
  assert.ok(y > 280 && y + h < 360, `y trimmed: ${[x, y, w, h]}`);
  assert.equal(out.svg.toLowerCase().includes("#ff0000"), false, "page 2 isn't included");
});

test("an Illustrator file saved without PDF content is refused with a fix", async () => {
  const file = await pdf((d) =>
    d.fontSize(12).text("This is an Adobe® Illustrator® File that was saved without PDF Content.", 50, 50)
  );
  await assert.rejects(convertVectorLogo(file, "old.ai"), /Create PDF Compatible File/);
});

test("an empty first page is refused", async () => {
  await assert.rejects(convertVectorLogo(await pdf(() => {}), "blank.pdf"), /empty/);
});

// ── HTTP endpoint ──

const SECRET = "test-secret-0123456789";
process.env.CONVERT_SECRET = SECRET;
const { default: handler } = await import("../netlify/functions/convert.mts");

/** The endpoint only accepts https links, so link-mode tests stub fetch
 *  for these made-up hosts. */
function withFetchStub(routes: Record<string, (init?: RequestInit) => Response | Promise<Response>>, run: () => Promise<void>) {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const route = routes[url];
    return route ? route(init) : real(input, init);
  }) as typeof fetch;
  return run().finally(() => {
    globalThis.fetch = real;
  });
}

const post = (body: BodyInit, headers: Record<string, string>) =>
  handler(new Request("https://svc.test/convert", { method: "POST", body, headers }));

test("endpoint: the shared secret is required", async () => {
  assert.equal((await post(EPS, { "X-File-Name": "a.eps" })).status, 401);
  assert.equal((await post(EPS, { Authorization: "Bearer wrong", "X-File-Name": "a.eps" })).status, 401);
});

test("endpoint: a file in the body comes back as SVG + warnings", async () => {
  const res = await post(EPS, { Authorization: `Bearer ${SECRET}`, "X-File-Name": "acme.eps" });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-source-code"), "https://github.com/dogluvr26/logo-convert-service");
  const body = (await res.json()) as { svg: string; warnings: string[]; source: string };
  assert.ok(body.svg.startsWith("<svg") || body.svg.includes("<svg"));
  assert.equal(body.source, "eps");
  assert.ok(body.warnings.some((w) => w.includes("PANTONE 186 C")));
});

test("endpoint: unreadable files are a 422 with the reason", async () => {
  const res = await post(Buffer.from("hello"), { Authorization: `Bearer ${SECRET}`, "X-File-Name": "x.pdf" });
  assert.equal(res.status, 422);
  assert.match(((await res.json()) as { error: string }).error, /isn't a PDF, AI or EPS/);
});

test("endpoint: links mode downloads the source and PUTs the SVG", async () => {
  let uploaded: { body: string; type: string | null } | null = null;
  await withFetchStub(
    {
      "https://store.test/original.eps": () => new Response(EPS),
      "https://store.test/upload?token=t": (init) => {
        uploaded = { body: String(init?.body), type: new Headers(init?.headers).get("content-type") };
        return new Response("{}", { status: 200 });
      },
    },
    async () => {
      const res = await post(
        JSON.stringify({
          sourceUrl: "https://store.test/original.eps",
          fileName: "acme.eps",
          uploadUrl: "https://store.test/upload?token=t",
        }),
        { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" }
      );
      assert.equal(res.status, 200);
      const body = (await res.json()) as { svg?: string; warnings: string[]; svgBytes: number };
      assert.equal(body.svg, undefined, "the SVG went to the upload link, not the response");
      assert.ok(body.warnings.length === 2 && body.svgBytes > 100);
    }
  );
  assert.ok(uploaded && (uploaded as { body: string }).body.includes("<svg"));
  assert.equal((uploaded as unknown as { type: string }).type, "image/svg+xml");
});

test("endpoint: links must be https and on ALLOWED_HOSTS when set", async () => {
  const auth = { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" };
  const send = (sourceUrl: string) => post(JSON.stringify({ sourceUrl, fileName: "a.eps" }), auth);
  assert.equal((await send("http://store.test/a.eps")).status, 400);
  process.env.ALLOWED_HOSTS = "store.test";
  try {
    assert.equal((await send("https://elsewhere.test/a.eps")).status, 400);
  } finally {
    delete process.env.ALLOWED_HOSTS;
  }
});
