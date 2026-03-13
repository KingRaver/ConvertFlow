# Changelog

---

## Phase 1 — Real Conversion Engine

### Converter adapter layer
- Created `server/converters/` directory with a `ConverterAdapter` interface and `RegisteredConverterAdapter` type
- Defined typed error hierarchy: `ConversionError`, `MissingToolError`, `ConversionTimeoutError`, `OutputValidationError`
- Built `server/converters/registry.ts` — maps `sourceFormat→targetFormat` route keys to adapters; throws `ConversionError` with code `unsupported_route` for unknown pairs
- Built `server/converters/runtime.ts` — `runCommand` subprocess wrapper with SIGTERM→SIGKILL timeout escalation; `withTimeout` for pure-JS operations; `resolveFfmpegBinary` and `resolveTextutilBinary` helpers

### Converters implemented
- **Image** (`server/converters/image.ts`): all image↔image routes via `sharp`; `png→pdf` and `jpg→pdf` via `pdf-lib`; `bmp→png/jpg` via ffmpeg; GIF handled as static frame
- **Document** (`server/converters/document.ts`): `pdf→txt/docx` via `pdf-parse`; `pdf→png/jpg` via `pdf-parse` screenshot + `sharp`; `docx→pdf/txt` via `mammoth` + `pdfkit`; `txt→pdf` via `pdfkit`; `txt→docx` via `docx`; `doc→pdf/txt` via `textutil` (macOS/fallback)
- **Data** (`server/converters/data.ts`): `csv↔xlsx`, `csv→json`, `xlsx→json` via `csv-parse`, `csv-stringify`, `xlsx`
- **Audio** (`server/converters/audio.ts`): `mp3↔wav`, `mp3→ogg`, `wav→ogg` via ffmpeg
- **Video** (`server/converters/video.ts`): `mp4→gif` with palette optimization, `mp4→mp3/wav`, `gif→mp4` via ffmpeg

### Output validation (`server/converters/validation.ts`)
- Per-format validators: images via `sharp.metadata()`, PDFs via `pdf-parse`, DOCX via `mammoth`, JSON via `JSON.parse`, CSV via `csv-parse`, XLSX via `xlsx.readFile`, media via ffmpeg null decode
- All validators run after conversion before marking job complete

### Routes integration (`server/routes.ts`)
- Replaced `runDemoConversion()` stub with real `processConversion()` that calls the adapter registry
- `outputFilename` and `outputPath` generated before conversion; `convertedSize` recorded on success
- `processingStartedAt` added to job record at intake
- `scheduleConversionExpiry` correctly replaces its timer on job completion — input file deleted immediately, output file scheduled for TTL expiry
- `serializeConversion` helper added for consistent date serialization across all endpoints
- Download endpoint now serves real output files

### Schema changes (`shared/schema.ts`)
- Added `processingStartedAt: timestamp` field to `conversions` table and `MemStorage`

### Tests
- `tests/converters/image.test.ts` — 16 image conversion cases
- `tests/converters/document.test.ts` — 8 base cases + 2 `textutil`-gated doc cases
- `tests/converters/data.test.ts` — 4 data conversion cases
- `tests/converters/media.test.ts` — 8 audio/video cases
- `tests/converters/registry.test.ts` — asserts every route in `SUPPORTED_CONVERSIONS` has a registered adapter
- `tests/converters/helpers.ts` — programmatic fixture generation for all formats (no binary files checked in)

### Patch — post-review fixes
- `hasTextutil()`: fixed — was calling `which /usr/bin/textutil` (always false); now calls the binary directly with `--help`
- `createImageToPdfAdapter`: fixed — was reading format from `path.extname(inputPath)`; now uses `normalizeFormat(sourceFormat)` directly
- `validateTextFile`: removed over-strict empty-content check; `assertOutputExists` size guard is sufficient
- `writeTextPdf`: replaced nested Promise-inside-`.then()` with clean `createWriteStream(outputPath)` pattern
- Removed unused dependencies: `fluent-ffmpeg`, `pdfjs-dist`, `@napi-rs/canvas` (8 transitive packages also removed)
- Added `withTimeout` comment documenting that pure-JS work is not cancellable on timeout
- `docs/ENTERPRISE.md`: corrected 1.5, added xlsx CVE audit item, added registry test to 1.10, added Phase 2.6 stuck job recovery item

---
