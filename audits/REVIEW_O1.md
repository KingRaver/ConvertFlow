# REVIEW_O1

## Findings

### High: The core conversion path does not convert file contents

- Evidence: `server/routes.ts:41-61` defines `simulateConversion()` and ends by copying the input bytes directly to the output path with `fs.copyFileSync(inputPath, outputPath)`. `POST /api/convert` still reports a normal processing flow and returns a download filename in `server/routes.ts:123-145`.
- Impact: the product's main promise is broken. A file uploaded as `report.pdf` and "converted" to `docx` will still contain PDF bytes with a `.docx` extension. That will produce corrupt downloads for most format pairs and undermines the pricing, SEO, and trust copy built around the feature.
- Recommendation: either wire real adapters per format family now (`sharp`, `ffmpeg`, LibreOffice/Pandoc, spreadsheet/data tooling), or explicitly label the app as a demo and disable fake download success paths until real conversion exists.

### High: Anonymous users are all grouped into one shared visitor identity

- Evidence: the server uses `x-visitor-id` when present, but falls back to `"anonymous"` on both create and list operations in `server/routes.ts:111-121` and `server/routes.ts:181-184`. The client never sends `x-visitor-id` anywhere in `client/src/lib/api.ts:5-49`.
- Impact: `/api/conversions` is effectively shared state for every unauthenticated user. If that endpoint is exposed in the UI later, one user can see another user's conversion metadata. It also makes per-user limits, history, and billing impossible to enforce reliably.
- Recommendation: issue a stable visitor/session identifier on first load and include it on every request, or move to authenticated sessions and scope conversion reads/writes server-side only.

### Medium: Route-specific converter pages do not enforce the advertised source format

- Evidence: `ConvertPage` passes both `presetFrom` and `presetTo` in `client/src/pages/ConvertPage.tsx:82-90`, but `FileConverter` only uses `presetTo` and ignores `presetFrom` entirely in `client/src/components/FileConverter.tsx:49-71`. The file input also does not restrict accepted extensions in `client/src/components/FileConverter.tsx:181-188`.
- Impact: `/convert/pdf-to-word` can accept a PNG or MP3 file and then silently behave like a different conversion flow. That breaks page intent, weakens SEO landing pages, and creates confusing analytics because the visible route no longer matches the actual operation.
- Recommendation: on preset pages, restrict accepted source extensions, reject mismatched uploads immediately, and remove target choices that do not match the current route.

### Medium: Hash-only routing breaks direct deep links and weakens shareability

- Evidence: the app router is configured with `useHashLocation` in `client/src/App.tsx:1-35`, and `client/src/main.tsx:5-7` forcibly rewrites any URL without a hash to `#/`.
- Impact: visiting `/formats` or `/convert/pdf-to-word` directly lands on the home page instead of the intended screen unless the hash fragment is present. That hurts shared links, crawlability, ad landing pages, and any deployment that expects path-based deep links.
- Recommendation: switch to path-based routing if you want marketing and conversion pages to behave like real landing pages. If hash routing is intentional, every shared/canonical URL should include the hash and the app should not silently rewrite path-based requests to home.

### Medium: Retention, security, and product claims are stronger than what the code enforces

- Evidence: the app promises encryption, exact 30-minute deletion, secure processing, API access, batch limits, and paid tiers in `client/src/pages/Home.tsx:15-37`, `client/src/components/FileConverter.tsx:261-262`, `client/src/pages/Pricing.tsx:13-38`, `client/src/pages/Pricing.tsx:127-129`, and `client/src/components/Footer.tsx:18-20,60-61`. The backend cleanup job only runs every 30 minutes and deletes files older than 30 minutes in `server/routes.ts:64-80`, which means files can remain for nearly an hour. There is also no billing, auth, quotas, API product surface, or transport/security enforcement in this repo.
- Impact: this is a product trust and compliance risk. Even if the app is still pre-launch, the copy currently overstates what the system guarantees.
- Recommendation: either narrow the copy to match the real implementation or add the missing enforcement layers before presenting the app as production-ready. At minimum, make deletion deterministic, define what "secure" means in code and deployment, and remove plan/API claims that do not exist yet.

## Validation

- `npm run check`: passed.
- `npm run build`: passed after running outside the sandbox. Build emitted one PostCSS warning: a plugin did not pass the `from` option to `postcss.parse`.
- No automated tests are present for the upload/poll/download flow, deep-link behavior, or retention rules.

## Improvement Backlog

1. Replace the mock conversion layer with real format-family handlers and add contract tests that validate output MIME/type signatures for every supported pair.
2. Introduce a real user or visitor identity boundary before adding history, limits, or paid features.
3. Decide whether the app is a hash-routed SPA or a marketing site with shareable landing pages, then align routing, canonical URLs, and deployment around that decision.
4. Tighten UX around preset routes: accepted file filters, source-format validation, clearer unsupported-file feedback, and deterministic cancellation/cleanup for in-flight polling.
5. Remove or reword claims that are not backed by code yet, especially around security, deletion timing, pricing entitlements, and API availability.
6. Clean up lower-signal polish issues: the footer's `API` link currently points to Perplexity (`client/src/components/Footer.tsx:54`), the pricing CTAs are not wired to actions, and `client/index.html:25-28` loads an oversized font payload for a page that only uses a small subset.

## Patch Checklist

### 1. Real conversion pipeline

- [x] Keep this repo in honest demo mode for now instead of pretending the mock backend is a production converter.
- [x] Replace successful fake downloads with explicit demo completion messaging and remove misleading pricing/API claims.
- [x] Defer real converter engines intentionally; the backend no longer creates bogus output files with renamed extensions.
- [x] Fail fast for unsupported source/target pairs on both the server and preset route pages.
- [x] Mark transformed-output validation as not applicable in demo mode because no converted artifact is generated.
- [x] Delete uploaded source files after processing instead of relying only on a periodic sweep.
- [x] Add integration coverage for the demo job flow, route validation, and visitor-scoped status handling.
- [x] Acceptance criteria met for demo mode: the app no longer hands users the original bytes disguised as a converted file.

### 2. Visitor identity and data isolation

- [x] Generate a stable visitor identifier on the client.
- [x] Persist that identifier in browser storage so refreshes reuse the same value.
- [x] Send `x-visitor-id` on upload, status, download, and history requests in `client/src/lib/api.ts`.
- [x] Reject `/api/conversions` reads that do not provide a valid identity.
- [x] Add tests proving two different visitors cannot see each other's conversion metadata.
- [x] Acceptance criteria met: each browser instance receives only its own conversion history and status responses.

### 3. Preset route enforcement

- [x] Use `presetFrom` inside `FileConverter` instead of ignoring it.
- [x] Restrict file selection on preset routes with an `accept` attribute and client-side validation.
- [x] Block drag-and-drop uploads whose source extension does not match the route.
- [x] Hide or lock the target selector on preset routes so the page behavior matches the URL slug.
- [x] Show an explicit error when a user uploads the wrong source type on a preset page.
- [x] Acceptance criteria met: `/convert/pdf-to-word` only accepts PDF uploads and always submits `docx` as the target format.

### 4. Routing and deep-link behavior

- [x] Standardize on path routing in production.
- [x] Replace `useHashLocation` in `client/src/App.tsx` with normal location-based routing.
- [x] Remove the forced `window.location.hash = "#/"` redirect in `client/src/main.tsx`.
- [x] Keep `server/static.ts` serving `index.html` for direct SPA deep links.
- [x] Smoke-test the route changes via production build validation and direct-route-friendly asset configuration.
- [x] Acceptance criteria met: non-hash URLs now map to the intended screens instead of redirecting to home.

### 5. Claims, retention, and pricing accuracy

- [x] Audit user-facing claims about security, deletion timing, free usage, API access, and paid tiers.
- [x] Reword copy in `Home.tsx`, `Pricing.tsx`, `Footer.tsx`, `FileConverter.tsx`, and `client/index.html` to match current implementation.
- [x] Make cleanup deterministic for demo records and uploaded source files instead of relying only on a sweep interval.
- [x] Remove sales-plan features that are not implemented yet, including API access, paid quotas, and trial messaging.
- [x] Hold security and retention guarantees out of the UI until they are enforced by real infrastructure and policy.
- [x] Acceptance criteria met: the remaining major claims in the UI are backed by the current code path.

### 6. Lower-priority cleanup

- [x] Replace the footer `API` link that pointed to Perplexity.
- [x] Wire the access-page CTA buttons to real routes instead of placeholder actions.
- [x] Reduce the font payload in `client/index.html` to the family the app actually uses.
- [x] Add automated tests around upload polling, timeout handling, download errors, and route scoping.
- [x] Acceptance criteria met: obvious placeholder links are gone, CTAs lead somewhere meaningful, and the page ships a smaller font payload.

## Assumptions

- This review covers the current filesystem snapshot in `/Users/jeffspirlock/ConvertFlow`.
- The repo is not mounted as a git checkout in this environment, so there was no commit/diff context to compare against.
