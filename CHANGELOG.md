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

## Phase 5 — User Accounts and Auth

### Auth schema (`shared/schema.ts`)
- Added `users` table: `id`, `email`, `passwordHash`, `role` (`user|admin`), `createdAt`
- Added `sessions` table: `id`, `userId` (FK → users, cascade delete), `token`, `expiresAt`, `createdAt`
- Added `userId` (nullable FK → users, set null on delete) to `conversions` table; `visitorId` retained for unauthenticated users
- Exported `USER_ROLES`, `UserRole`, `InsertUser`, `InsertSession`, `User`, `Session` types and insert schemas

### Auth crypto (`server/auth.ts`)
- Password hashing via Node `scrypt` with 16-byte random salt and 64-byte key; format: `scrypt:{salt}:{hash}` (both hex)
- Password verification via `timingSafeEqual` to prevent timing attacks
- Session tokens: 32 bytes of `crypto.randomFill` encoded as base64url
- `createSessionExpiry()` returns `now + 30 days`; `normalizeEmail()` applies trim + toLowerCase before storage

### Auth endpoints (`server/routes.ts`)
- `POST /api/auth/register` — validates email + password (min 8 chars), rejects duplicate email with 409, creates user + session atomically, returns `{ token, user }`
- `POST /api/auth/login` — verifies password with timing-safe comparison, returns `{ token, user }`; same 401 for unknown email vs wrong password (prevents account enumeration)
- `POST /api/auth/logout` — deletes session by token; requires `requireAuth`
- `GET /api/auth/me` — returns serialized user from validated session; requires `requireAuth`
- Rate limiting: `createRateLimiter(10, 15 min)` applied to both register and login; limiter is scoped per-server instance so dev and test environments are isolated

### Auth middleware (`server/middleware/auth.ts`)
- `parseBearerToken` extracts token from `Authorization: Bearer <token>` header
- `attachAuthenticatedUser` loads session → checks expiry (deletes expired session) → loads user → validates `role` value against `USER_ROLES` constant (deletes session if role is unrecognized) → attaches `req.user` and `req.authToken`
- `optionalAuth` — attaches user if valid token present, otherwise continues unauthenticated
- `requireAuth` — rejects with 401 if no valid session
- Extends Express `Request` with `user?: RequestUser` and `authToken?: string`

### Rate limiting middleware (`server/middleware/rateLimit.ts`)
- `createRateLimiter(maxRequests, windowMs, message)` — sliding window, IP-keyed, per-server-instance
- Automatically purges stale entries via `setInterval(...).unref()` to prevent unbounded memory growth
- Respects `X-Forwarded-For` header for deployments behind a proxy
- Returns 429 with `Retry-After` header when limit is exceeded

### Conversion ownership (`server/routes.ts`)
- `getUploadOwner`: authenticated users get `{ userId, visitorId? }`; anonymous requests require a valid visitor ID header
- `getReadOwner`: authenticated users are scoped by `userId`; anonymous requests scoped by `visitorId`
- `canAccessConversion`: user-owned jobs require matching `userId`; visitor-owned jobs require matching `visitorId`; the two scopes are mutually exclusive
- `optionalAuth` applied to `POST /api/convert`, `GET /api/convert/:id`, `GET /api/download/:filename`, `GET /api/conversions`
- `GET /api/conversions` supports pagination (`?page`, `?limit`) and filtering (`?status`, `?format`) for both scopes

### Storage layer
- Added `createUser`, `getUserByEmail`, `getUserById`, `createSession`, `getSessionByToken`, `deleteSessionByToken` to `IStorage` and both `MemStorage` and `DrizzleStorage`
- Added `createUserWithSession(userData, sessionData)` to `IStorage`: atomically creates a user and its first session; `DrizzleStorage` wraps both inserts in a single Drizzle transaction; `MemStorage` performs two sequential operations
- `DrizzleStorage` implements all auth methods against the `users` and `sessions` Drizzle tables

### Frontend auth (`client/src/`)
- `client/src/lib/auth.ts` — localStorage helpers: `getStoredAuthToken`, `setStoredAuthToken`, `clearStoredAuthToken`
- `client/src/lib/api.ts` — `buildHeaders()` injects `Authorization: Bearer <token>` when a token is present; added `registerUser`, `loginUser`, `logoutUser`, `getCurrentUser` API functions
- `client/src/context/AuthContext.tsx` — `AuthProvider` wraps the app; validates stored token on mount via `GET /api/auth/me`; exposes `user`, `isAuthenticated`, `isLoading`, `login`, `register`, `logout`
- `client/src/pages/Login.tsx` — email + password form, redirects to `/history` if already authenticated, shows error on failure
- `client/src/pages/Register.tsx` — same shape as Login; uses `autoComplete="new-password"`
- `client/src/pages/History.tsx` — protected page; shows paginated, filterable conversion history for the authenticated user; supports re-download of completed jobs
- `client/src/components/Header.tsx` — conditionally shows History link and logout button for authenticated users
- `client/src/App.tsx` — `AuthProvider` added at root; `/login`, `/register`, `/history` routes wired

### Dependency cleanup
- Removed unused dependencies: `passport`, `passport-local`, `express-session`, `memorystore`, `connect-pg-simple`
- Removed corresponding dev type packages: `@types/passport`, `@types/passport-local`, `@types/express-session`, `@types/connect-pg-simple`

### Tests (`tests/serverRoutes.test.ts`)
- `auth endpoints create, resolve, and revoke account sessions` — register → login → `/auth/me` → logout → `/auth/me` returns 401
- `register rejects duplicate email with 409`
- `register rejects missing or invalid fields with 400` — missing password, missing email, password too short, invalid email format
- `login rejects wrong password with 401`
- `login rejects unknown email with 401`
- `authenticated routes reject missing or invalid tokens with 401` — no token, bad token, malformed Authorization scheme
- `authenticated users can create account-owned jobs and query paginated filtered history` — upload two jobs, wait for completion, assert paginated + filtered history; assert anonymous access returns 404

## Phase 6 — Metering, Limits, and Billing

### Schema and storage
- Added `plan`, `stripeCustomerId`, and `stripeSubscriptionId` to `users` in `shared/schema.ts`
- Added `usage_events` table plus `InsertUsageEvent`, `UsageEvent`, `USER_PLANS`, and `USAGE_EVENT_TYPES` exports
- Extended `IStorage`, `MemStorage`, and `DrizzleStorage` with `updateUser`, `createUsageEvent`, `countUsageEventsSince`, and `countVisitorConversionsSince`

### Limits and metering
- Added `server/limits.ts` with authoritative per-plan rules:
  - `free`: 10 conversions/day, 10MB uploads, 1-hour retention
  - `pro`: 500 conversions/day, 100MB uploads, 7-day retention
  - `business`: unlimited conversions, 500MB uploads, 30-day retention
- `POST /api/convert` now resolves the effective plan before Multer runs, rejects over-limit users with 429, and builds a per-request Multer instance so file-size caps are enforced dynamically instead of with a global 50MB ceiling
- Conversion expiry is now derived from the uploader's plan at intake rather than a single fixed TTL
- `processQueuedConversion` records a `conversion` usage event for successful account-owned jobs

### Billing (`server/billing.ts`, `server/routes.ts`)
- Installed `stripe` and added a Stripe-backed billing adapter with:
  - `POST /api/billing/checkout` for paid-plan upgrades
  - `POST /api/billing/portal` for Stripe customer portal access
  - `POST /api/billing/webhook` to sync `customer.subscription.updated` / `customer.subscription.deleted` back onto the local user record
- Checkout sessions attach `plan` and `userId` metadata to subscriptions so webhook sync can deterministically set the local `plan`
- `.env.example` now includes `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`

### Auth and client updates
- Auth serialization now includes `plan`; `RequestUser`, `/api/auth/register`, `/api/auth/login`, and `/api/auth/me` all carry plan-aware state
- `client/src/lib/api.ts` added `createBillingCheckout()` and `createBillingPortal()`
- Replaced the old “Current Access” page with a live pricing/billing page that reflects real plan limits and launches Stripe checkout or portal flows
- Header and footer now expose pricing/billing language and show the authenticated user’s current plan

### Tests
- Added `tests/billing.test.ts` for webhook-driven upgrade and downgrade sync
- Added route coverage for:
  - free-tier daily quota enforcement
  - free-tier 10MB upload cap enforcement
  - pro-tier retention windows and usage metering after successful conversion

---

## Phase 7 — Public API and Developer Access

### Schema and storage
- Added `api_keys`, `webhooks`, and `idempotency_keys` tables in `shared/schema.ts`
- Extended `IStorage`, `MemStorage`, and `DrizzleStorage` with API key, webhook, and idempotency record operations
- Startup maintenance now purges expired idempotency records alongside expired conversions

### API keys and auth
- Added `POST /api/keys`, `GET /api/keys`, and `DELETE /api/keys/:id`
- API keys are issued as `cf_...` bearer tokens, stored only as SHA-256 hashes, and expose the raw token once at creation time
- `server/middleware/auth.ts` now supports session-only auth for account management and API-key-or-session auth for `/api/convert`, `/api/convert/:id`, `/api/download/:filename`, and `/api/conversions`
- Invalid bearer tokens now return `401` instead of silently degrading into anonymous access

### Webhooks and idempotency
- Added `POST /api/webhooks` and `DELETE /api/webhooks/:id`
- Conversion completions and failures now enqueue signed outbound webhook deliveries with per-webhook HMAC headers:
  - `x-convertflow-event`
  - `x-convertflow-timestamp`
  - `x-convertflow-signature`
- Added retry queue support for failed webhook deliveries with 3 backoff attempts in both memory and `pg-boss` runtimes
- `POST /api/convert` now accepts `Idempotency-Key`; matching requests within 24 hours return the original `201` response without enqueuing a duplicate job

### Docs and build
- Added `docs/openapi.yaml` covering the public auth, conversion, API key, webhook, and docs endpoints
- Added `GET /api/openapi.yaml` and `GET /api/docs` (Redoc)
- `script/build.ts` now copies the OpenAPI spec into `dist/docs/openapi.yaml` for production builds

### Tests
- Added `tests/publicApi.test.ts` covering:
  - API key management plus auth on conversion, history, and download routes
  - idempotent conversion creation
  - signed webhook delivery with retry after failure
  - docs/spec endpoints

### Hardening
- **SSRF protection**: `isPrivateUrl()` added in `server/routes.ts`; webhook URL validation rejects localhost, `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16` link-local, and IPv6 loopback — prevents server-side request forgery via attacker-controlled webhook destinations
- **Custom webhook secrets**: `POST /api/webhooks` accepts an optional `secret` field (min 32 chars); if omitted, a 32-byte random secret is auto-generated — allows callers to rotate secrets without re-registering endpoints
- **Content-addressed idempotency**: The idempotency record hash covers the SHA-256 of the uploaded file contents, source/target formats, and file size in addition to the caller-supplied `Idempotency-Key` header — prevents a key replay attack where a different file is submitted under the same key
- **API key last-used tracking**: `storage.touchApiKeyLastUsed` fires on every successful API key authentication, recording the timestamp without blocking the request

### Post-review fixes
- **Webhook retry classification**: `processWebhookDelivery` now distinguishes 4xx (permanent client-side failure, no retry) from 5xx and network errors (retryable) — previously all non-ok responses were retried, causing invalid webhook URLs to exhaust all retry slots unnecessarily
- **Webhook delivery ID header**: Each outbound webhook delivery now includes a `x-convertflow-delivery-id` UUID header, giving receivers a stable identifier to detect duplicates and correlate retries to their original delivery
- **API key auth fallback removed**: A `cf_`-prefixed bearer token that fails API key lookup now returns `401` immediately instead of falling through to session auth — eliminates an ambiguous dual-path where an invalid API key could accidentally match a session token
- **Cross-user API key revocation test**: Added assertion that `DELETE /api/keys/:id` returns 404 when the authenticated user does not own the target key and that the key remains usable afterward
- **4xx no-retry test**: Added assertion that a webhook endpoint returning 400 receives exactly one delivery attempt with no subsequent retries

---
