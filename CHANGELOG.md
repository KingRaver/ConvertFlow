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

## Phase 3 — Background Job Queue

### Queue adapter layer (`server/queue.ts`)
- Defined `QueueRuntime` interface with `startServer`, `startWorker`, `enqueueConversionJob`, `scheduleExpiryJob`, and `stop` methods
- Implemented `MemoryQueueRuntime` — in-process fallback used when `DATABASE_URL` is absent; supports per-queue concurrency limits, delayed job scheduling via `setTimeout`, and a recurring expiry sweep via `setInterval`
- Implemented `PgBossQueueRuntime` — production backend backed by `pg-boss` on the existing PostgreSQL connection; no additional infra required
- Singleton `queueRuntime` selected at module load: `PgBossQueueRuntime` when `DATABASE_URL` is present, `MemoryQueueRuntime` otherwise
- Exported `startQueueServerRuntime` (server entrypoint), `startQueueWorkerRuntime` (standalone worker entrypoint), `enqueueConversionJob`, and `scheduleConversionExpiryJob`

### Conversion worker (`server/conversion-jobs.ts`)
- Extracted `processQueuedConversion` from `server/routes.ts` into a standalone async function that runs in the worker context
- Worker flow: load conversion record → guard expired/completed/failed → set status `processing` → convert → upload output → delete input → update record `completed`
- `expireConversionRecord` deletes the stored output object then hard-deletes the database row
- `expireConversionById` performs a guarded expiry callable from both queue worker and maintenance sweep

### Queue routing and concurrency
- Five format-family queues: `conversion-image` (4 concurrent), `conversion-audio` (2), `conversion-data` (2), `conversion-document` (2), `conversion-video` (1)
- Job timeout at queue level matches the per-converter `CONVERTER_TIMEOUT_MS` constant; `retryLimit: 0` on all jobs
- Queue records auto-deleted after 1 hour via `deleteAfterSeconds`

### Expiry and maintenance
- Dedicated `conversion-expiry` queue handles per-job scheduled expiry; deduplicated by `id: conversion-expiry-{id}` to prevent double-firing
- Recurring `conversion-expiry-sweep` queue runs every 10 minutes via cron (`*/10 * * * *` on pg-boss, `setInterval` on memory runtime) to catch any jobs missed by the per-job expiry
- `server/maintenance.ts` updated: `cleanupExpiredConversions` now delegates to `expireConversionRecord` which handles object storage cleanup before row deletion; `sweepDirectory(UPLOAD_TMP_DIR)` clears stale temp uploads on each pass

### Routes integration (`server/routes.ts`)
- `POST /api/convert` now creates a job with `status: "pending"` and returns 201 immediately after enqueueing — no longer awaits conversion inline
- `scheduleConversionExpiryJob` called with the job's `expiresAt` immediately after enqueue
- `EMBEDDED_CONVERSION_WORKER` env var controls whether the server process also runs workers; defaults to `true` in dev and when no database is configured

### Environment config
- Added `EMBEDDED_CONVERSION_WORKER=true` to `.env.example` with `true` as the dev default

### Tests
- `tests/conversionJobs.test.ts` — covers `processQueuedConversion`: successful txt→docx conversion, missing input file, already-expired job, completed/failed early-exit guard
- `tests/serverRoutes.test.ts` — updated: upload route returns `status: "pending"` immediately; status poll eventually resolves to `completed`; download redirect returns signed URL; expired jobs return 404

---

## Phase 4 — Object Storage

### Storage adapter interface (`server/filestore/index.ts`)
- Defined `FileStore` interface: `save(localPath, key)`, `get(key, localPath)`, `delete(key)`, `getDownloadUrl(key, filename)`
- Helper functions: `getUploadObjectKey(filename)` → `uploads/{filename}`, `getOutputObjectKey(filename)` → `outputs/{filename}`, `getDownloadFilename(originalName, targetFormat)` → clean `{base}.{ext}` output filename
- Singleton `filestore` selected at module load based on `STORAGE_DRIVER` env var (`local` default, `s3` for production)
- Logs active driver at startup: `[filestore] Storage driver: {driver}`

### Local file store (`server/filestore/local.ts`)
- `LocalFileStore` wraps local disk; keys are validated via `normalizeStorageKey()` to prevent path traversal (blocks `..`, absolute paths, and keys outside `uploads/` or `outputs/` prefixes)
- HMAC-SHA256 signed download URLs with 15-minute expiry; `crypto.timingSafeEqual` prevents timing attacks on signature comparison
- `parseLocalDownloadParams` validates expiry timestamp, hex-format signature, and key prefix before serving files
- `getLocalSigningSecret()` throws at startup in `NODE_ENV=production` if neither `LOCAL_FILESTORE_SIGNING_SECRET` nor `SESSION_SECRET` is configured; warns in development and falls back to an insecure default
- Structured logging on all operations: save, get, delete, getDownloadUrl

### S3 file store (`server/filestore/s3.ts`)
- `S3FileStore` uses `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner`; all four AWS credential env vars are validated at construction via `getRequiredEnv()`
- Pre-signed download URLs use `GetObjectCommand` with `ResponseContentDisposition` set to RFC 5987 encoded `attachment; filename=` header; 15-minute expiry
- All S3 operations wrapped in try/catch with descriptive error messages (`"S3 upload failed for {key}: ..."`, `"S3 download failed..."`, etc.) to surface credential and network failures clearly in logs
- Structured logging on all operations

### Upload and worker flow integration
- `POST /api/convert`: Multer writes temp file → `filestore.save(file.path, inputKey)` → `safeUnlink(file.path)` → create conversion record → enqueue worker; on any failure, `filestore.delete(inputKey)` cleans up the stored object
- Worker (`processQueuedConversion`): `filestore.get(inputKey, workspace.inputPath)` → convert locally → `filestore.save(workspace.outputPath, outputKey)` → `safeDeleteStoredFile(inputKey)`; temp workspace cleaned in `finally` block only (removed redundant `safeUnlink` calls from `catch`)
- `outputFilename` in the worker reuses the existing database value if present (`conversion.outputFilename ?? uuidv4()...`), making the worker idempotent if retries are ever introduced

### Download flow
- `GET /api/download/:filename` now calls `filestore.getDownloadUrl(outputKey, downloadFilename)` and redirects; no longer serves local files directly
- Local driver redirects to `GET /api/download/local?key=...&expires=...&signature=...`; S3 driver redirects to an AWS SigV4 pre-signed URL
- `expireConversionRecord` deletes the output object from the filestore before deleting the database row

### Environment config
- Added `STORAGE_DRIVER`, `AWS_BUCKET`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `LOCAL_FILESTORE_SIGNING_SECRET` to `.env.example`
- `LOCAL_FILESTORE_SIGNING_SECRET` entry includes generation command: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

### Dependencies
- Added `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner`

---
