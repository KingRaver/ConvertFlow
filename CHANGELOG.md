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

## Phase 2 — Durable Job Storage

### Database bootstrap
- Added `.env` and `.env.example` entries for `DATABASE_URL`; `.env` is now gitignored while `.env.example` remains tracked
- Added `server/db.ts` to initialize `pg` + Drizzle when `DATABASE_URL` is configured
- `drizzle.config.ts` now loads `.env` before resolving `DATABASE_URL`

### Storage and lifecycle
- Added `server/storage/drizzle.ts` with a full `DrizzleStorage` implementation of the app storage contract
- `server/storage.ts` now selects `DrizzleStorage` when `DATABASE_URL` is present and falls back to `MemStorage` otherwise
- Extended storage support for expired-job queries and stale-processing recovery
- Added `engineUsed` to `shared/schema.ts` and persisted the selected converter engine on each job

### Maintenance
- Replaced per-job `setTimeout` expiry scheduling in `server/routes.ts` with expiry checks backed by durable storage
- Added `server/maintenance.ts` for startup recovery of stuck processing jobs and periodic cleanup of expired rows/files
- `server/index.ts` now runs startup maintenance before serving traffic and starts the recurring cleanup worker

### Tests
- Added `tests/maintenance.test.ts` for expired cleanup and stale-job recovery behavior
- Updated route coverage to assert `engineUsed` is exposed on completed jobs

### Patch — post-review fixes
- `DrizzleStorage.getExpiredConversions`: fixed sort order from `desc` to `asc` to match `MemStorage` behavior (oldest expiry processed first)
- Railway PostgreSQL provisioned as production database; `conversions` table created via `db:push` against public TCP proxy (`shuttle.proxy.rlwy.net`)
- Confirmed Phase 2 fully integrated end-to-end
- `server/index.ts`, `server/db.ts`, `drizzle.config.ts`: wrapped `process.loadEnvFile()` in try/catch — Railway injects env vars directly so no `.env` file exists in production; bare call crashed the server on every deploy

### Security patch
- Replaced `xlsx@0.18.5` (SheetJS Community Edition, EOL) with `exceljs` across `server/converters/data.ts` and `server/converters/validation.ts` — eliminates known prototype pollution and memory exhaustion CVEs on malformed untrusted input
- Updated `engineName` from `xlsx+csv` to `exceljs+csv` to reflect the new runtime

### New conversion route
- `pdf→csv` added to `SUPPORTED_CONVERSIONS` in `shared/schema.ts`
- Adapter implemented in `server/converters/document.ts` (`pdf-parse+csv-stringify`): extracts PDF text, splits lines into columns on multi-space/tab boundaries, serializes to CSV

### Build fixes
- `vite.config.ts`: removed `import.meta.url` and `fileURLToPath` — replaced with `path.resolve()` relative strings; file always runs from project root so cwd-relative paths are equivalent and work correctly in both ESM and CJS contexts, eliminating all `import.meta` build warnings
- `script/build.ts`: replaced stale `xlsx` entry in the server bundle allowlist with `exceljs`

---
