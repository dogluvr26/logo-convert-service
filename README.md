# logo-convert-service

A small HTTP service that converts **PDF, AI and EPS** logo files to a
**trimmed SVG**, with warnings a print shop cares about. It runs as a Netlify
function using unmodified MuPDF and Ghostscript compiled to WebAssembly (no
native binaries).

- **EPS / PostScript** → Ghostscript → PDF → MuPDF → SVG
- **PDF / AI** (Illustrator files saved with PDF compatibility) → MuPDF → SVG
- Files are recognized by content, not extension (some ".ai" files are EPS).
- **First page / artboard only**, trimmed to the visible artwork.
- Text is drawn as paths, so the SVG never depends on fonts.
- **Warnings**: text that wasn't outlined and whose font isn't in the file (so
  a substitute was used; Ghostscript's substitute is named), spot colors, and
  extra pages. They're returned, and also stored in the SVG as JSON in
  `<metadata id="kimber-oak-logo-conversion">`.
- Refused with a reason (HTTP 422): not a PDF/AI/EPS, an Illustrator file saved
  without PDF content, an empty first page.

## API

`POST /convert` with `Authorization: Bearer <CONVERT_SECRET>`.

**File in the body** (up to ~6 MB, Netlify's body limit):

```
curl -X POST https://<site>/convert \
  -H "Authorization: Bearer $CONVERT_SECRET" \
  -H "X-File-Name: logo.eps" \
  --data-binary @logo.eps
→ 200 { "svg": "<svg …>", "warnings": [...], "source": "eps", "pages": 1 }
```

**Links** (any size up to 50 MB; nothing large crosses a request body):

```
POST /convert   Content-Type: application/json
{ "sourceUrl": "https://…/original.ai",       // e.g. a short-lived signed link
  "fileName":  "logo.ai",                      // used in warning messages
  "uploadUrl": "https://…/signed-upload?…" }   // optional: PUT the SVG here
→ 200 { "warnings": [...], "source": "pdf", "pages": 1, "svgBytes": 12345 }
```

Without `uploadUrl` the SVG comes back inline as `svg`. The SVG is uploaded
with `PUT` and `Content-Type: image/svg+xml` (a Supabase signed upload URL
works as-is).

Errors: `401` bad secret · `400` bad request · `422` can't convert (message
says why) · `502` a link failed. `GET /convert` returns the license and source
link. Every response carries `X-Source-Code: <this repository>`.

## Configuration (environment variables)

| Name | |
|---|---|
| `CONVERT_SECRET` | **Required.** Shared secret for the `Authorization` header. Without it every request is refused. |
| `ALLOWED_HOSTS` | Optional, comma-separated. Links (`sourceUrl`, `uploadUrl`) must be on these hosts, e.g. your Supabase project host. Links must always be https. |

## Develop

```
npm install
npm test            # conversion + endpoint tests
npx netlify-cli dev # local server on :8888
```

## License

Copyright (C) 2026 Strategic Gifting, LLC.

This program is free software: you can redistribute it and/or modify it under
the terms of the **GNU Affero General Public License** as published by the Free
Software Foundation, either version 3 of the License, or (at your option) any
later version. See [LICENSE](LICENSE). Anyone using the service over a network
can get its source here. Third-party components and their source: [NOTICE.md](NOTICE.md).
