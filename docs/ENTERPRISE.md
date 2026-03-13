# ConvertFlow Build Checklist

Phased implementation plan for turning the current demo into a real file conversion platform. Each item is tied to specific files and functions in the existing codebase.

---

## Phase 1: Real Conversion Engine

**Goal:** Replace `runDemoConversion()` with real output files. The download endpoint already exists — it just needs actual files to serve.

### 1.1 Converter adapter layer

- [x] Create `server/converters/` directory
- [x] Define `ConverterAdapter` interface in `server/converters/index.ts`:
  ```ts
  interface ConverterAdapter {
    convert(inputPath: string, outputPath: string): Promise<void>;
  }
  ```
- [x] Create one file per format family:
  - `server/converters/image.ts` — handles all image→image routes
  - `server/converters/document.ts` — handles PDF/DOCX/DOC/TXT routes
  - `server/converters/data.ts` — handles CSV/XLSX/JSON routes
  - `server/converters/audio.ts` — handles MP3/WAV/OGG routes
  - `server/converters/video.ts` — handles MP4/GIF routes
- [x] Create `server/converters/registry.ts` that maps `sourceFormat→targetFormat` to the correct adapter
- [x] Replace `runDemoConversion()` in `server/routes.ts` with a call to `registry.getAdapter(sourceFormat, targetFormat).convert(inputPath, outputPath)`

### 1.2 Image conversions (sharp)

- [x] Install `sharp`
- [x] Implement `server/converters/image.ts` using `sharp`
- [x] Cover routes: `png→jpg`, `png→webp`, `jpg→png`, `jpg→webp`, `webp→png`, `webp→jpg`, `svg→png`, `svg→jpg`, `bmp→png`, `bmp→jpg`, `tiff→png`, `tiff→jpg`, `gif→png`, `gif→jpg`
- [x] For `image→pdf` routes (`png→pdf`, `jpg→pdf`): embed image in a PDF using `pdf-lib`

### 1.3 Document conversions

- [x] Install the document conversion stack: `pdf-parse`, `mammoth`, `docx`, and `pdfkit`
- [x] Implement `server/converters/document.ts`:
  - `docx→pdf` via `mammoth` text extraction + `pdfkit`
  - `doc→pdf` and `doc→txt` via `textutil` fallback
  - `pdf→txt` via `pdf-parse`
  - `pdf→jpg` and `pdf→png` via `pdf-parse` screenshots
  - `pdf→docx` via `pdf-parse` + `docx` builder
  - `txt→pdf` via `pdfkit`
  - `txt→docx` via `docx`
  - `docx→txt` via `mammoth`
- [x] Document the document-conversion runtime in `server/converters/README.md`, including the current `textutil` dependency for `.doc`

### 1.4 Data conversions

- [x] Install `csv-parse`, `csv-stringify`, `xlsx`
- [ ] Audit `xlsx` v0.18.5 CVEs before production — this is the last public npm release of SheetJS Community Edition and has known prototype pollution and memory exhaustion vulnerabilities on malformed input; evaluate `exceljs` as a replacement if untrusted files are a concern
- [x] Implement `server/converters/data.ts`:
  - `csv→xlsx`: parse CSV with `csv-parse`, write with `xlsx`
  - `csv→json`: parse CSV, serialize to JSON file
  - `xlsx→csv`: read with `xlsx`, stringify with `csv-stringify`
  - `xlsx→json`: read with `xlsx`, serialize to JSON file

### 1.5 Audio conversions (ffmpeg)

- [x] Install `ffmpeg-static` (converters call the binary directly via `runCommand` — `fluent-ffmpeg` is not needed)
- [x] Implement `server/converters/audio.ts`:
  - `mp3→wav`, `mp3→ogg`, `wav→mp3`, `wav→ogg`
- [x] Confirm `ffmpeg-static` binary path is resolved correctly on the target OS

### 1.6 Video conversions (ffmpeg)

- [x] Implement `server/converters/video.ts` using the ffmpeg runtime:
  - `mp4→gif`: extract frames and encode as GIF with configurable FPS and palette
  - `mp4→mp3`: extract audio stream
  - `mp4→wav`: extract audio stream as WAV
  - `gif→mp4`: encode GIF frames as MP4

### 1.7 Wire output files into job lifecycle

- [x] In `server/routes.ts`, generate `outputFilename` before calling the converter:
  ```ts
  const outputFilename = `${uuidv4()}.${targetFormat}`;
  const outputPath = path.join(OUTPUT_DIR, outputFilename);
  ```
- [x] After successful conversion, update the job with `outputFilename` and `convertedSize` (from `fs.statSync(outputPath).size`)
- [x] Update `scheduleConversionExpiry` to include `outputPath` in `filesToDelete`
- [x] Confirm `GET /api/download/:filename` in `server/routes.ts` serves the real file (it already will once `outputPath` exists)

### 1.8 Output validation

- [x] After conversion, verify the output file:
  - Exists on disk
  - Size is greater than zero
  - For images: readable by `sharp` without error
  - For documents: readable by the relevant parser
- [x] If validation fails, mark job as `failed` with a specific `resultMessage`

### 1.9 Error handling and retries

- [x] Catch converter-specific errors and map them to meaningful `resultMessage` strings
- [x] Add a `processingStartedAt` field to track when conversion began
- [x] Add a conversion timeout: if a converter takes longer than 60 seconds, kill it and mark as failed

### 1.10 Tests

- [x] Add integration tests in `tests/converters/` that run each adapter against a real fixture file
- [x] Add fixture files in `tests/fixtures/` and generate the remaining binary fixtures during the test run
- [x] Assert: output file exists, size > 0, correct extension, passes format-specific validation
- [x] Add `tests/converters/registry.test.ts` that verifies every route in `SUPPORTED_CONVERSIONS` has a registered adapter — catches schema/adapter gaps at test time rather than runtime

---

## Phase 2: Durable Job Storage

**Goal:** Replace `MemStorage` with PostgreSQL so jobs survive restarts.

### 2.1 Connect Drizzle to PostgreSQL

- [x] Add `DATABASE_URL` to `.env` and `.env.example`
- [x] Create `server/db.ts` that initializes `drizzle(pool)` using `pg` and `DATABASE_URL`
- [ ] Run `npm run db:push` to create the `conversions` table (schema already defined in `shared/schema.ts`)

### 2.2 Implement DrizzleStorage

- [x] Create `server/storage/drizzle.ts` that implements the existing `IStorage` interface from `server/storage.ts`
- [x] Implement all five methods using Drizzle queries against the `conversions` table
- [x] Export a `DrizzleStorage` class alongside the existing `MemStorage`

### 2.3 Swap storage at startup

- [x] In `server/storage.ts`, check for `DATABASE_URL` at module init:
  - If present, export a `DrizzleStorage` instance
  - If absent, export the existing `MemStorage` instance (keeps dev/test simple)
- [x] No changes needed to `server/routes.ts` — it imports `storage` and calls the interface

### 2.4 Job expiry with durable storage

- [x] Replace the `setTimeout`-based expiry in `server/routes.ts` with a database-driven approach:
  - Add a `GET /api/convert/:id` check: if `expiresAt < now`, delete and return 404 (already partially done)
  - Add a cleanup job (see Phase 3) that periodically hard-deletes expired rows and their files

### 2.5 Add missing fields to schema

- [x] Add `processingStartedAt: timestamp` to `conversions` table in `shared/schema.ts`
- [x] Add `engineUsed: text` to record which converter adapter handled the job
- [ ] Run migration

### 2.6 Stuck job recovery on startup

- [x] On server startup, run: `UPDATE conversions SET status = 'failed', result_message = 'Server restarted during processing.' WHERE status = 'processing' AND processing_started_at < now() - interval '5 minutes'`
- [x] This handles jobs that were in-flight when the process was killed — with in-memory storage they disappear on restart, but with PostgreSQL they would remain stuck in `processing` indefinitely without this recovery step

---

## Phase 3: Background Job Queue

**Goal:** Move conversion out of the HTTP request handler so uploads return immediately and workers process jobs independently.

### 3.1 Choose and install a queue

- [ ] Install `bullmq` and `ioredis` (requires Redis), or `pg-boss` (uses existing PostgreSQL, no new infra)
- [ ] If using `pg-boss`: add to `server/db.ts`, schedule starts alongside the Express server
- [ ] If using `bullmq`: add Redis connection config to `.env`

### 3.2 Queue producer

- [ ] In `server/routes.ts` `POST /api/convert` handler:
  - Create the job record with `status: "pending"` (not `"processing"`)
  - Enqueue a job with payload `{ conversionId, inputPath, sourceFormat, targetFormat }`
  - Return 201 immediately without `await`ing conversion

### 3.3 Queue worker

- [ ] Create `server/worker.ts` as a separate entry point
- [ ] Worker subscribes to the conversion queue
- [ ] On each job:
  1. Load conversion record from storage
  2. Set `status: "processing"`, `processingStartedAt: now`
  3. Call `registry.getAdapter(sourceFormat, targetFormat).convert(inputPath, outputPath)`
  4. On success: update `status: "completed"`, `outputFilename`, `convertedSize`, `engineUsed`
  5. On failure: update `status: "failed"`, `resultMessage` with error detail
  6. Delete input file
  7. Schedule output file deletion at `expiresAt`
- [ ] Add worker startup to `package.json` scripts: `"worker": "tsx server/worker.ts"`

### 3.4 Expiry worker

- [ ] Add a recurring job (every 10 minutes) that:
  - Queries conversions where `expiresAt < now`
  - Deletes output files from disk
  - Hard-deletes conversion records
- [ ] This replaces the `setInterval` sweep in `server/routes.ts`

### 3.5 Concurrency and limits

- [ ] Set worker concurrency per format family (image jobs can run 4 parallel; document jobs 2; video jobs 1)
- [ ] Add a job timeout at the queue level matching the per-converter timeout

---

## Phase 4: Object Storage

**Goal:** Move uploaded and output files off local disk so the app is stateless and horizontally scalable.

### 4.1 Storage adapter interface

- [ ] Create `server/filestore/index.ts` with interface:
  ```ts
  interface FileStore {
    save(localPath: string, key: string): Promise<void>;
    get(key: string, localPath: string): Promise<void>;
    delete(key: string): Promise<void>;
    getDownloadUrl(key: string, filename: string): Promise<string>;
  }
  ```
- [ ] Implement `server/filestore/local.ts` — wraps existing local disk behavior (used in dev/test)
- [ ] Implement `server/filestore/s3.ts` — uses `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner`

### 4.2 Upload flow with object storage

- [ ] After Multer writes the file to `/uploads`, upload to object storage with key `uploads/{uuid}.{ext}`
- [ ] Delete the local temp file after upload
- [ ] Worker downloads the file from object storage to a temp path before converting
- [ ] Worker uploads the output to object storage with key `outputs/{uuid}.{targetFormat}`
- [ ] Worker deletes the input key from object storage

### 4.3 Download flow with object storage

- [ ] `GET /api/download/:filename` generates a pre-signed URL (15-minute expiry) and redirects to it
- [ ] Remove local `OUTPUT_DIR` file serving

### 4.4 Environment config

- [ ] Add to `.env`: `STORAGE_DRIVER=local|s3`, `AWS_BUCKET`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`
- [ ] Export `filestore` singleton from `server/filestore/index.ts` based on `STORAGE_DRIVER`

---

## Phase 5: User Accounts and Auth

**Goal:** Replace anonymous visitor scoping with real user accounts.

### 5.1 Auth schema

- [ ] Add to `shared/schema.ts`:
  - `users` table: `id`, `email`, `passwordHash`, `createdAt`, `role` (`user|admin`)
  - `sessions` table: `id`, `userId`, `token`, `expiresAt`, `createdAt`
- [ ] Add `userId` (nullable) to `conversions` table — keep `visitorId` for unauthenticated users
- [ ] Run migrations

### 5.2 Auth endpoints

- [ ] `POST /api/auth/register` — hash password with `bcrypt`, create user, return session token
- [ ] `POST /api/auth/login` — verify password, create session, return token
- [ ] `POST /api/auth/logout` — delete session
- [ ] `GET /api/auth/me` — return current user from session token

### 5.3 Auth middleware

- [ ] Create `server/middleware/auth.ts`:
  - `requireAuth` — validates `Authorization: Bearer <token>` header, attaches `req.user`
  - `optionalAuth` — same but does not reject unauthenticated requests
- [ ] Apply `optionalAuth` to `POST /api/convert` — if user is authenticated, attach `userId` to the job
- [ ] Apply `requireAuth` to any account-specific routes

### 5.4 Conversion history per user

- [ ] `GET /api/conversions` — if authenticated, return by `userId`; if not, return by `visitorId` (existing behavior)
- [ ] Add pagination: `?page=1&limit=20`
- [ ] Add filtering: `?status=completed`, `?format=pdf`

### 5.5 Frontend auth

- [ ] Add login and register pages in `client/src/pages/`
- [ ] Add auth state to a React context (`client/src/context/AuthContext.tsx`)
- [ ] Store session token in `localStorage`
- [ ] Send `Authorization` header in `client/src/lib/api.ts` when token is present
- [ ] Show conversion history in a protected `/history` page

---

## Phase 6: Metering, Limits, and Billing

**Goal:** Enforce usage limits so the free tier is sustainable and paid tiers are differentiated.

### 6.1 Usage tracking schema

- [ ] Add `plan` field to `users`: `free|pro|business`
- [ ] Add `usageEvents` table: `userId`, `eventType` (`conversion`), `format`, `fileSize`, `createdAt`
- [ ] Record a usage event on every successful conversion

### 6.2 Limit enforcement

- [ ] Create `server/limits.ts` defining per-plan limits:
  - `free`: 10 conversions/day, 10MB max file size, 1-hour retention
  - `pro`: 500 conversions/day, 100MB max file size, 7-day retention
  - `business`: unlimited conversions, 500MB max file size, 30-day retention
- [ ] In `POST /api/convert`: check today's usage count before accepting upload; reject with 429 if over limit
- [ ] Enforce file size limit per plan (override Multer's global 50MB limit dynamically)

### 6.3 Stripe integration

- [ ] Install `stripe`
- [ ] Add `stripeCustomerId` and `stripeSubscriptionId` to `users` table
- [ ] `POST /api/billing/checkout` — create Stripe Checkout session for plan upgrade
- [ ] `POST /api/billing/portal` — create Stripe customer portal session for plan management
- [ ] `POST /api/billing/webhook` — handle `customer.subscription.updated` and `customer.subscription.deleted` to sync `plan` field
- [ ] Add `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` to `.env`

---

## Phase 7: Public API and Developer Access

**Goal:** Make conversions programmable so developers and other products can use ConvertFlow as infrastructure.

### 7.1 API key schema

- [ ] Add `apiKeys` table: `id`, `userId`, `keyHash`, `name`, `lastUsedAt`, `createdAt`, `revokedAt`
- [ ] Store only the hash; show the raw key once at creation time

### 7.2 API key management endpoints

- [ ] `GET /api/keys` — list user's API keys (names and last used, never raw keys)
- [ ] `POST /api/keys` — generate a new key, return raw value once
- [ ] `DELETE /api/keys/:id` — revoke a key

### 7.3 API key authentication middleware

- [ ] Update `server/middleware/auth.ts` to also accept `Authorization: Bearer cf_<key>` format
- [ ] Look up key by hash; attach user; record `lastUsedAt`
- [ ] Apply to all `/api/convert`, `/api/download`, `/api/conversions` routes

### 7.4 Webhook support

- [ ] Add `webhooks` table: `id`, `userId`, `url`, `events` (array), `secret`, `createdAt`
- [ ] `POST /api/webhooks` — register a webhook URL
- [ ] `DELETE /api/webhooks/:id` — remove a webhook
- [ ] On job completion or failure: POST to registered webhook URLs with `{ event: "conversion.completed", job: {...} }` signed with HMAC
- [ ] Use a retry queue for failed webhook deliveries (3 retries with backoff)

### 7.5 Idempotency

- [ ] Accept `Idempotency-Key` header on `POST /api/convert`
- [ ] Store idempotency keys in a short-lived table (24h TTL)
- [ ] If same key is reused, return the original response without re-processing

### 7.6 OpenAPI spec

- [ ] Create `docs/openapi.yaml` documenting all public endpoints
- [ ] Add `GET /api/docs` that serves Swagger UI or Redoc

---

## Phase 8: Batch Jobs and Workflow Features

**Goal:** Support multi-file and automated conversion workflows.

### 8.1 Multi-file upload

- [ ] Change Multer config in `server/routes.ts` to accept `upload.array("files", 20)`
- [ ] Create a `batches` table: `id`, `userId`, `status`, `totalJobs`, `completedJobs`, `failedJobs`, `createdAt`
- [ ] `POST /api/batch` accepts multiple files, creates a batch record, enqueues all conversion jobs
- [ ] `GET /api/batch/:id` returns batch status and individual job statuses
- [ ] `GET /api/batch/:id/download` returns a ZIP of all completed output files

### 8.2 Saved conversion presets

- [ ] Add `presets` table: `id`, `userId`, `name`, `sourceFormat`, `targetFormat`, `options` (JSON), `createdAt`
- [ ] `POST /api/presets` — save a preset
- [ ] `GET /api/presets` — list user's presets
- [ ] `DELETE /api/presets/:id` — delete a preset
- [ ] Accept `presetId` on `POST /api/convert` to apply saved options

### 8.3 Job re-run

- [ ] `POST /api/convert/:id/retry` — re-enqueue a failed job using the original input file
- [ ] Only available while input file has not been deleted (within retention window)

### 8.4 Conversion options

- [ ] Extend `SUPPORTED_CONVERSIONS` in `shared/schema.ts` to include per-route options schema (e.g., image quality, PDF page range, audio bitrate)
- [ ] Accept `options` JSON field on `POST /api/convert`
- [ ] Pass options through to converter adapters
- [ ] Validate options against per-route schema on intake

---

## Phase 9: Observability

**Goal:** Know exactly what is happening in production at all times.

### 9.1 Structured logging

- [ ] Install `pino` and `pino-http`
- [ ] Replace all `console.log`/`console.error` with structured `logger` calls
- [ ] Log fields: `conversionId`, `visitorId`/`userId`, `sourceFormat`, `targetFormat`, `fileSize`, `durationMs`, `engineUsed`, `status`
- [ ] Add request logging middleware to Express

### 9.2 Metrics

- [ ] Install `prom-client`
- [ ] Instrument: conversion count by route and status, processing duration histogram by route, queue depth, active worker count, file sizes
- [ ] Expose `GET /metrics` endpoint (restricted to internal/monitoring access)

### 9.3 Health checks

- [ ] `GET /api/health` — returns `{ status: "ok", db: "ok"|"error", queue: "ok"|"error", storage: "ok"|"error" }`
- [ ] Used by load balancers and uptime monitors

### 9.4 Error tracking

- [ ] Install `@sentry/node`
- [ ] Initialize in `server/index.ts` with `SENTRY_DSN` from env
- [ ] Capture unhandled exceptions, unhandled rejections, and converter errors with conversion context

---

## Environment Variables Reference

All variables that will be needed across phases:

```
# Core
NODE_ENV=development|production
PORT=3000
DATABASE_URL=postgresql://...

# Storage
STORAGE_DRIVER=local|s3
AWS_BUCKET=
AWS_REGION=
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=

# Queue (if using BullMQ)
REDIS_URL=redis://localhost:6379

# Auth
SESSION_SECRET=

# Billing
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=

# Observability
SENTRY_DSN=
```

---

## Dependency Install Reference

```bash
# Phase 1 — converters
npm install sharp pdf-lib pdf-parse pdfkit mammoth docx libreoffice-convert
npm install fluent-ffmpeg ffmpeg-static
npm install csv-parse csv-stringify xlsx

# Phase 2 — database
npm install pg drizzle-orm
npm install -D drizzle-kit

# Phase 3 — queue (pick one)
npm install pg-boss           # postgres-based, no new infra
npm install bullmq ioredis    # redis-based

# Phase 4 — object storage
npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner

# Phase 5 — auth
npm install bcrypt jsonwebtoken
npm install -D @types/bcrypt @types/jsonwebtoken

# Phase 6 — billing
npm install stripe

# Phase 9 — observability
npm install pino pino-http prom-client @sentry/node
```
