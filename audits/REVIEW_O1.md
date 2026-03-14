# REVIEW_O1

This file is historical context for an earlier pre-adapter review. It no longer describes the current shipping runtime.

## Current Status

- The live server uses registered converter adapters in `server/converters/` instead of the older fake conversion path discussed in the original review.
- Visitor scoping, path routing, auth, quotas, API keys, billing hooks, and observability have all changed substantially since that review was written.
- For the current hardening backlog, use [MOCK_REMOVAL.md](/Users/jeffspirlock/ConvertFlow/audits/MOCK_REMOVAL.md).

## What To Read Instead

- [docs/ENTERPRISE.md](/Users/jeffspirlock/ConvertFlow/docs/ENTERPRISE.md) for the current deployment requirements.
- [docs/openapi.yaml](/Users/jeffspirlock/ConvertFlow/docs/openapi.yaml) for the public API surface.
- `CHANGELOG.md` for the implementation history of the real conversion pipeline.

## Archived Note

The original review was accurate for the repo state at the time, but keeping it as active guidance now is misleading because it described demo-mode behavior that has already been removed.
