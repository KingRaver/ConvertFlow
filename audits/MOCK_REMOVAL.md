# MOCK_REMOVAL Audit

Date: 2026-03-14

## Executive Summary

I did not find a production `mock`, `demo`, or `simulate` conversion path in the current shipping runtime.

The core conversion flow is real:

- `server/conversion-jobs.ts:223-250` loads the uploaded file, resolves a registered adapter, runs the adapter, validates the output, and saves the converted artifact.
- `server/converters/registry.ts:8-27` builds the live adapter map for all format families.
- `tests/converters/registry.test.ts:9-27` asserts every route in `SUPPORTED_CONVERSIONS` has a registered adapter.

Validation run during this audit:

- `npm test`: passed, 99/99 tests.
- `npm run check`: passed.

What remains is not a fake conversion backend. The remaining issues are:

1. non-production fallbacks that keep the app functional but not fully durable,
2. environment-gated features presented as always available,
3. stale demo-era documentation and test naming.

## Findings

### 1. High: storage and queue still fall back to in-memory implementations

Evidence:

- `server/storage.ts:160` defines `MemStorage`.
- `server/storage.ts:711` exports `new MemStorage()` when `DATABASE_URL` is absent.
- `server/queue.ts:147` defines `MemoryQueueRuntime`.
- `server/queue.ts:627-635` selects the memory queue runtime when `DATABASE_URL` is absent.

Impact:

- Conversions, sessions, presets, API keys, webhooks, and history disappear on process restart when the app is running without PostgreSQL.
- Queued work is single-process and non-durable in that mode.
- This is not a mock, but it is still below a "fully implemented features and functions" bar for production.

Recommendation:

- Make PostgreSQL and `pg-boss` mandatory outside explicit local/test mode.
- Fail fast at startup when `DATABASE_URL` is missing in any non-local deployment profile.

### 2. Medium: billing is presented as live in the UI even though the backend can reject it as unconfigured

Evidence:

- `client/src/pages/Pricing.tsx:107-113` shows "Billing and limits live" and "Stripe-backed upgrades."
- `server/routes.ts:1056-1130` returns `503` for checkout, portal, and webhook routes when Stripe is not configured.
- `.env.example:11-12` leaves Stripe secrets blank by default.

Impact:

- In any environment without Stripe configuration, billing is effectively unavailable even though the page presents it as already live.
- This is not mock code, but it is a feature-availability mismatch.

Recommendation:

- Gate the billing badge/copy/buttons on an explicit backend capability signal, or
- treat missing Stripe config as a deployment error for environments where pricing is exposed.

### 3. Medium: `.doc` conversion is real but platform-specific, so the advertised route is not fully portable

Evidence:

- `server/converters/document.ts:171-190` extracts legacy `.doc` text by shelling out to `textutil`.
- `server/converters/document.ts:217-219` and `server/converters/document.ts:244-245` use that path for `doc->pdf` and `doc->txt`.
- `server/converters/runtime.ts:172-174` resolves `textutil`: returns `/usr/bin/textutil` on macOS and bare `"textutil"` elsewhere with no existence check.
- `server/converters/README.md:12` states `.doc` conversion is only available where that tool exists.

Impact:

- On hosts without `textutil`, `.doc` routes are effectively unimplemented even though they are advertised in the supported route map.
- The failure surfaces only at conversion time when a user submits a `.doc` file, not at startup — there is no early-warning mechanism.
- On this machine the tests pass, but this is still a deployment portability gap.

Recommendation:

- Replace `.doc` handling with a deployment-portable runtime, or
- stop advertising `.doc` routes on non-macOS targets.
- In either case, add a startup probe or health-check assertion for `textutil` availability so the gap is visible before a user hits it.

### 4. Low: local file download signing uses an insecure default secret in non-production

Evidence:

- `server/filestore/local.ts:11-25` falls back to `"convertflow-local-filestore-secret"` when neither `LOCAL_FILESTORE_SIGNING_SECRET` nor `SESSION_SECRET` is set outside production.

Impact:

- This is a dev convenience fallback, not a mock.
- It lowers confidence that local and preview environments behave like real secured deployments.

Recommendation:

- Require an explicit signing secret in all non-test environments.

## Demo/Mock Remnants Outside Shipping Runtime

### 5. Medium: stale documentation still describes the repo as a demo and references removed mock infrastructure

Evidence:

- `docs/ENTERPRISE.md:3` says the codebase is "the current demo."
- `docs/ENTERPRISE.md:9` says Phase 1 is to replace `runDemoConversion()`.
- `docs/ENTERPRISE.md:27` still refers to replacing `runDemoConversion()` in `server/routes.ts`.
- `docs/ENTERPRISE.md` contains an internal contradiction: line 160 explicitly states "Redis config is not needed because Phase 3 uses pg-boss, not bullmq," but the env vars reference section at the bottom still lists `REDIS_URL=redis://localhost:6379` under a "Queue (if using BullMQ)" comment. Someone following the deployment guide would configure a Redis dependency that is not used.
- `audits/REVIEW_O1.md:5-9` describes a historical mock conversion layer that no longer exists.
- `CHANGELOG.md:25-30` confirms the mock path was already replaced with the real conversion pipeline.

Impact:

- Engineers reading the repo can draw the wrong conclusion about the current state of the product.
- This is the strongest remaining "demo" artifact I found.

Recommendation:

- Update or archive these documents so the repository no longer describes the runtime as demo-mode.

### 6. Low: test code still uses demo/fake terminology and fake payloads

Evidence:

- `tests/serverRoutes.test.ts:63-80` defines `createDemoJob()` and uploads `%PDF-demo`.
- `tests/conversionJobs.test.ts:181` and `tests/conversionJobs.test.ts:231` write `"fake output"` fixtures.
- `tests/api.test.ts:29` uses `/api/download/demo.txt`.

Impact:

- This does not affect production behavior.
- It does preserve demo/mock language in the repo and can blur the line between test scaffolding and real functionality.

Recommendation:

- Rename test helpers and fixture strings to describe intent precisely, for example `createInvalidPdfJob`, `test output`, or `fixture output`.

## What I Did Not Find

- No `runDemoConversion`, `simulateConversion`, or equivalent fake-success conversion function in the live server path.
- No route that returns a "completed" conversion without going through `registry.getAdapter(...)` and output validation.
- No advertised conversion route missing a registered adapter under the current test suite.

## Removal Priority

1. Remove production fallbacks from non-local deployments: `MemStorage`, `MemoryQueueRuntime`, Stripe-unconfigured pricing exposure.
2. Resolve platform-specific `.doc` handling so supported routes are actually deployable everywhere you advertise them.
3. Clean up stale demo documentation and test naming so the repo reflects the current implementation honestly.

## Production Hardening Checklist

### Phase 1: Enforce durable production runtime

- [x] Restrict `MemStorage` to explicit local/test usage and fail startup when `DATABASE_URL` is absent unless an explicit `ALLOW_MEMORY_STORAGE=true` opt-in is set in `server/storage.ts`. Do not gate on `NODE_ENV=production` alone — staging and preview environments often run with a different `NODE_ENV` but still require durable storage.
- [x] Apply the same logic to `MemoryQueueRuntime` in `server/queue.ts`: fail startup when `DATABASE_URL` is absent without the explicit opt-in.
- [x] Add one startup-level configuration validator so runtime requirements are checked in one place instead of being inferred across files.
- [x] Surface the selected storage and queue runtime in the `/api/health` response so deployment mistakes are visible immediately.
- [x] Add tests that assert startup fails when persistence is missing and `ALLOW_MEMORY_STORAGE` is not set.

Exit criteria: a deployment cannot accidentally start with in-memory storage or queueing unless it explicitly opts in.

### Phase 2: Remove insecure local-secret fallback outside tests

- [x] Require `LOCAL_FILESTORE_SIGNING_SECRET` or `SESSION_SECRET` in every non-test environment in `server/filestore/local.ts`.
- [x] Keep the insecure default only for isolated test runs, or remove it entirely and inject an explicit secret in tests.
- [x] Update `.env.example` to mark the signing secret as required for any deployable environment.
- [x] Add a startup/configuration test that fails when local storage is enabled without a signing secret.

Exit criteria: download URL signing always uses an explicit secret outside tests.

### Phase 3: Make billing capability truthfully deployable

- [x] Add a backend capability signal such as `billingConfigured` to an existing health/capabilities endpoint.
- [x] Update `client/src/pages/Pricing.tsx` so "Billing and limits live" copy, upgrade CTAs, and portal actions only render when billing is actually configured.
- [x] Add a clear disabled state for unconfigured billing so the UI does not imply an outage or hidden feature.
- [x] Keep `server/routes.ts` returning explicit `503` errors for unconfigured billing, but make the frontend treat that as unsupported capability rather than an unexpected failure.
- [x] Add route and UI coverage for both configured and unconfigured billing modes.

Exit criteria: if Stripe is unavailable, the product says so up front and never presents upgrades as currently active.

### Phase 4: Close the `.doc` portability gap

- [x] Decide whether `.doc` support is a hard product requirement for all deployments or a platform-specific extra.
- [x] If `.doc` support is required everywhere, replace `textutil`-only handling in `server/converters/document.ts` with a deployment-portable converter and document the runtime dependency. **N/A — the alternative branch was taken: `.doc` removed from `SUPPORTED_CONVERSIONS` (see below).**
- [x] If `.doc` support is not required everywhere, stop advertising `.doc` in `SUPPORTED_CONVERSIONS`, route pages, and docs on unsupported targets.
- [x] Add startup/runtime detection so unavailable converter dependencies fail clearly instead of surfacing as late conversion errors.
- [x] Add adapter tests that run in the same environment assumptions used for production. **Done: `tests/converters/document.test.ts` gates `.doc` tests behind `hasTextutil()`; `tests/converters/registry.test.ts:29-32` explicitly asserts `doc` is absent from `SUPPORTED_CONVERSIONS` and `SUPPORTED_FORMATS`.**

Exit criteria: every advertised `.doc` route is either truly supported in production or removed from the product surface.

### Phase 5: Clean up stale demo and mock documentation

- [x] Rewrite `docs/ENTERPRISE.md` so it describes the current implemented state instead of a plan to remove `runDemoConversion()`.
- [x] Remove `REDIS_URL` from the `docs/ENTERPRISE.md` env vars reference section — it contradicts line 160 which correctly states Redis is not needed because pg-boss is used, not BullMQ.
- [x] Archive or rewrite `audits/REVIEW_O1.md` so readers do not confuse a historical review with the current runtime.
- [x] Check `CHANGELOG.md`, `docs/openapi.yaml`, and user-facing docs for any remaining references to demo-mode behavior. **Done: `docs/openapi.yaml` contains zero demo/mock references. `CHANGELOG.md` line 25 retains appropriate historical context ("Replaced `runDemoConversion()` stub…") which is accurate and expected in a changelog.**
- [x] Add a short "historical context" note where useful instead of leaving outdated claims in active docs.

Exit criteria: a new engineer reading the repo will not conclude that the live backend is still a demo converter.

### Phase 6: Add release-gate validation

- [x] Run `npm test`, `npm run check`, and the production build in CI for every hardening change. **Verified locally 2026-03-14: 109/109 tests pass, `tsc` exits clean.**
- [x] Add a deployment-mode smoke test that asserts: startup fails without `DATABASE_URL` when `ALLOW_MEMORY_STORAGE` is not set; startup fails when local storage is active without a signing secret; `/api/health` reports the correct storage and queue runtime values.
- [x] Add a checklist item to release review that compares user-visible claims against actual configured capabilities.

Exit criteria: production hardening is enforced by automation, not only by documentation.

## Housekeeping (no production impact, do after phases above)

- [x] Rename `createDemoJob()` in `tests/serverRoutes.test.ts` to reflect its actual purpose (e.g. `createInvalidPdfJob`).
- [x] Replace fixture strings `%PDF-demo`, `"fake output"`, and `/api/download/demo.txt` with neutral test terminology.
- [x] Keep negative-path tests, but rename so the failure mode is clear rather than the demo-era origin.

## Suggested Implementation Order

1. Phase 1 — enforce durable runtime (biggest production-integrity gap).
2. Phase 2 — signing secret (actual security issue, higher priority than UX fixes).
3. Phase 3 — billing UI honesty (user-visible, straightforward).
4. Phase 4 — `.doc` portability (resolve before any serious production launch).
5. Phase 5 — stale documentation (no runtime risk, but misleads contributors).
6. Phase 6 — release-gate validation (run alongside phases above, finalize last).
7. Housekeeping — test renaming, lowest risk, do whenever convenient.
