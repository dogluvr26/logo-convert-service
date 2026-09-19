// logo-convert-service — PDF / AI / EPS logo files to trimmed SVG.
// Copyright (C) 2026 Strategic Gifting, LLC
// Licensed under the GNU Affero General Public License v3 or later; see LICENSE.

import type { Config } from "@netlify/functions";
import { timingSafeEqual } from "node:crypto";

import { LogoConversionError, convertVectorLogo } from "../../src/convert";

/**
 * POST /convert — converts a PDF, AI or EPS file to a trimmed SVG.
 *
 * Auth: `Authorization: Bearer <CONVERT_SECRET>`.
 *
 * Two ways to send the file:
 *   1. The file itself as the body (any non-JSON Content-Type), with its
 *      name in `X-File-Name`. Answers { svg, warnings, source, pages }.
 *      Netlify limits bodies to ~6 MB, so this suits small files.
 *   2. JSON { sourceUrl, fileName, uploadUrl? }: the service downloads the
 *      file from sourceUrl (e.g. a short-lived signed link). With uploadUrl,
 *      it PUTs the SVG there (Content-Type image/svg+xml) and answers
 *      { warnings, source, pages, svgBytes }; without, the SVG is inline.
 *      Large files never pass through a request or response body.
 *
 * Errors: 401 bad secret, 400 bad request, 422 the file can't be converted
 * (the message says why), 502 the source or upload link failed.
 */

const SOURCE_URL = "https://github.com/dogluvr26/logo-convert-service";
const MAX_SOURCE_BYTES = 50 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;

const headers = { "X-Source-Code": SOURCE_URL };
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers });

function authorized(req: Request): boolean {
  const secret = process.env.CONVERT_SECRET;
  if (!secret) return false; // fail closed until configured
  const given = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Links must be https, and on an allowed host when ALLOWED_HOSTS is set
 *  (comma-separated), so the service can't be pointed at arbitrary URLs. */
function allowedUrl(value: unknown): URL | null {
  if (typeof value !== "string") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const hosts = (process.env.ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  return hosts.length === 0 || hosts.includes(url.hostname.toLowerCase()) ? url : null;
}

const cleanName = (name: unknown) =>
  typeof name === "string" && name.trim() ? name.trim().replace(/[^\w.\- ]+/g, "_").slice(0, 200) : "logo";

async function download(url: URL): Promise<Uint8Array> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`the source link answered HTTP ${res.status}`);
  const length = Number(res.headers.get("content-length") ?? 0);
  if (length > MAX_SOURCE_BYTES) throw new Error("the file is over 50 MB");
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > MAX_SOURCE_BYTES) throw new Error("the file is over 50 MB");
  return bytes;
}

export default async (req: Request) => {
  if (req.method === "GET") {
    return reply({ service: "logo-convert-service", license: "AGPL-3.0-or-later", source: SOURCE_URL });
  }
  if (req.method !== "POST") return reply({ error: "Method not allowed" }, 405);
  if (!authorized(req)) return reply({ error: "Unauthorized" }, 401);

  let bytes: Uint8Array;
  let fileName: string;
  let uploadUrl: URL | null = null;
  const isJson = (req.headers.get("content-type") ?? "").includes("application/json");
  try {
    if (isJson) {
      const body = (await req.json().catch(() => null)) as { sourceUrl?: unknown; fileName?: unknown; uploadUrl?: unknown } | null;
      const sourceUrl = allowedUrl(body?.sourceUrl);
      if (!sourceUrl) return reply({ error: "sourceUrl must be an allowed https link" }, 400);
      if (body?.uploadUrl !== undefined) {
        uploadUrl = allowedUrl(body.uploadUrl);
        if (!uploadUrl) return reply({ error: "uploadUrl must be an allowed https link" }, 400);
      }
      fileName = cleanName(body?.fileName);
      bytes = await download(sourceUrl);
    } else {
      fileName = cleanName(req.headers.get("x-file-name"));
      bytes = new Uint8Array(await req.arrayBuffer());
      if (bytes.length === 0) return reply({ error: "Empty body" }, 400);
    }
  } catch (err) {
    return reply({ error: `Couldn't read the file: ${err instanceof Error ? err.message : String(err)}` }, 502);
  }

  let result;
  try {
    result = await convertVectorLogo(bytes, fileName);
  } catch (err) {
    if (err instanceof LogoConversionError) return reply({ error: err.message }, 422);
    console.error("convert: failed", err);
    return reply({ error: err instanceof Error ? err.message : String(err) }, 500);
  }

  const { svg, warnings, source, pages } = result;
  if (!uploadUrl) return reply({ svg, warnings, source, pages });

  const put = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": "image/svg+xml" },
    body: svg,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  }).catch((err: unknown) => err as Error);
  if (put instanceof Error || !put.ok) {
    const detail = put instanceof Error ? put.message : `HTTP ${put.status} ${await put.text().catch(() => "")}`.trim();
    return reply({ error: `Couldn't upload the SVG: ${detail}` }, 502);
  }
  return reply({ warnings, source, pages, svgBytes: Buffer.byteLength(svg) });
};

export const config: Config = {
  path: "/convert",
};
