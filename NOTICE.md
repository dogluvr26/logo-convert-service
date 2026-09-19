# Third-party software

This service runs the following programs **unmodified**, as published on npm.
Both are licensed under the GNU Affero General Public License, version 3 or
later (the same license as this service; full text in [LICENSE](LICENSE)).

| Component | Version | Used for | License | Source |
|---|---|---|---|---|
| **MuPDF.js** (`mupdf`) — MuPDF compiled to WebAssembly, © Artifex Software, Inc. | 1.28.1 | PDF / AI → SVG, rendering for trimming, PDF inspection | AGPL-3.0-or-later | MuPDF.js: <https://github.com/ArtifexSoftware/mupdf.js> · MuPDF: <https://git.ghostscript.com/?p=mupdf.git> (mirror <https://github.com/ArtifexSoftware/mupdf>) · releases: <https://mupdf.com/releases> |
| **GhostPDL / Ghostscript** compiled to WebAssembly (`@okathira/ghostpdl-wasm`), Ghostscript © Artifex Software, Inc.; WASM build by okathira | 1.1.0 (Ghostscript 10.06.0) | EPS / PostScript → PDF | AGPL-3.0-or-later | Build: <https://github.com/okathira/ghostpdl-wasm> · Ghostscript: <https://git.ghostscript.com/?p=ghostpdl.git> (mirror <https://github.com/ArtifexSoftware/ghostpdl>) · releases: <https://ghostscript.com/releases/> |

The exact versions deployed are pinned in `package.json` / `package-lock.json`;
each package's own license and notices ship inside it under `node_modules/`.

Test fixture only (not deployed): **Montserrat Medium**, © The Montserrat
Project Authors, SIL Open Font License 1.1 — `test/fixtures/Montserrat-OFL.txt`.
