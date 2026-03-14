# ConvertFlow Deployment Guide

This document describes the current runtime, deployment requirements, and release checks for ConvertFlow. It replaces the older phased plan that referred to demo-era conversion code.

## Current Runtime

ConvertFlow ships a real conversion pipeline:

- `server/converters/` contains the adapter families for document, image, audio, video, and data routes.
- `server/conversion-jobs.ts` runs queued conversions, validates outputs, stores artifacts, and updates job records.
- `server/queue.ts` uses `pg-boss` when PostgreSQL is configured and only falls back to the in-memory queue when `ALLOW_MEMORY_STORAGE=true` is explicitly set.
- `server/storage.ts` uses PostgreSQL-backed `DrizzleStorage` when `DATABASE_URL` is configured and only falls back to in-memory storage with the same explicit opt-in.
- `server/filestore/` supports `local` and `s3` object storage backends.
- Auth, API keys, presets, webhooks, quotas, and billing hooks are all part of the live server surface.

## Deployment Requirements

### Durable runtime

- `DATABASE_URL` is required for any deployable environment.
- `ALLOW_MEMORY_STORAGE=true` is a local-only escape hatch for isolated development and tests.
- The API embeds conversion workers by default. Only set `EMBEDDED_CONVERSION_WORKER=false` when a standalone worker process is definitely running.
- A standalone worker (`npm run worker`) requires PostgreSQL. The worker does not start in memory mode.
- `/api/health` exposes the active storage runtime, queue runtime, and file-store driver so deployment mistakes are visible immediately.

### File storage signing

- If `STORAGE_DRIVER=local`, you must set `LOCAL_FILESTORE_SIGNING_SECRET` or `SESSION_SECRET`.
- Local download signing no longer falls back to an insecure default.
- `STORAGE_DRIVER=s3` does not require the local signing secret, but it does require the usual AWS credentials and bucket settings.

### Billing capability

- Stripe billing is optional.
- When Stripe is not configured, the backend keeps returning explicit `503` responses for checkout and portal routes.
- The pricing UI reads backend capability data and disables upgrade actions when billing is unavailable instead of presenting checkout as live.

### Legacy `.doc` handling

- `.doc` adapters still exist internally behind the legacy `textutil` runtime.
- `.doc` is no longer advertised in `SUPPORTED_CONVERSIONS`, route pages, or the public format map because the runtime is not deployment-portable.
- If `.doc` must return to the public product surface, replace the `textutil` dependency with a portable converter or gate the route by deployment target.

### Queue infrastructure

- Redis is not used.
- Queueing is implemented with `pg-boss` on top of PostgreSQL.

## Environment Variables

Core runtime:

```env
NODE_ENV=development
PORT=3000
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/convertflow
ALLOW_MEMORY_STORAGE=false
EMBEDDED_CONVERSION_WORKER=true
```

Filestore:

```env
STORAGE_DRIVER=local
LOCAL_FILESTORE_SIGNING_SECRET=replace-with-a-random-64-char-secret

# S3 mode
AWS_BUCKET=
AWS_REGION=
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
```

Billing:

```env
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
```

Observability:

```env
LOG_LEVEL=info
MONITORING_TOKEN=
SENTRY_DSN=
```

## Local Development

### Durable local setup

1. Start PostgreSQL.
2. Set `DATABASE_URL`.
3. Set `LOCAL_FILESTORE_SIGNING_SECRET`.
4. Run `npm run dev`.

This matches the production architecture most closely.

### Lightweight local setup

1. Leave `DATABASE_URL` unset.
2. Set `ALLOW_MEMORY_STORAGE=true`.
3. Set `LOCAL_FILESTORE_SIGNING_SECRET`.
4. Run `npm run dev`.

This mode is intentionally non-durable. Jobs, sessions, history, presets, API keys, and queued work disappear on restart.

## Release Checks

Before shipping a deployment:

1. Run `npm run check`, `npm test`, and the production build.
2. Confirm `/api/health` reports the expected storage and queue runtimes.
3. Verify that pricing and upgrade copy match the deployment's actual Stripe configuration.
4. Review user-facing docs and OpenAPI descriptions for capability claims that depend on runtime configuration.

## Historical Context

Older docs in this repository referred to phased work such as replacing `runDemoConversion()` and adding a queue or durable storage. Those milestones are already complete. For current hardening work, use [audits/MOCK_REMOVAL.md](/Users/jeffspirlock/ConvertFlow/audits/MOCK_REMOVAL.md).
