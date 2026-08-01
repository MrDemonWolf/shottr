# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Cloudflare Worker that proxies a Cloudflare R2 bucket (`shottr`) as an image CDN at `img.mrdemonwolf.com`. The single worker handles GET/HEAD (serve), PUT (upload), DELETE, and OPTIONS (CORS preflight). Used with the Shottr screenshot app's S3-compatible uploader. The full from-scratch setup walkthrough lives in README.md ("Getting Started").

## Commands

```bash
bun run dev        # Local dev via wrangler dev (local R2 simulation)
bun run deploy     # Deploy via scripts/deploy.mjs (auto-drops [limits] on Free plan)
bun run typecheck  # tsc --noEmit
bun run test       # Vitest suite (tests/), uses aws4 as signing oracle
bun run build      # wrangler deploy --dry-run --outdir=dist
```

CI (`.github/workflows/ci.yml`) runs typecheck, test, and dry-run build with Bun.

## Key details

- **Entry point:** `src/index.ts`; SigV4 logic in `src/sigv4.ts` (Web Crypto only, zero runtime deps — keep it that way).
- **R2 binding:** `env.BUCKET` → bucket `shottr`
- **Auth (writes):** PUT/DELETE require a fully verified AWS SigV4 `Authorization` header — signature, ±15 min clock skew, and scope date are checked (`verifyAuthHeader`). The declared `x-amz-content-sha256` is signature-covered but the body is not hashed (streaming preserved). Secrets: `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`, both required, set via `npx wrangler secret put …` (locally: `.dev.vars`).
- **Auth (reads):** public. Presigned GETs (`X-Amz-Algorithm` query) are verified with expiry; unsigned GETs pass through.
- **Auth (Shortcuts):** optional `Authorization: Bearer <SHORTCUTS_UPLOAD_TOKEN>` path — PUT only, image extensions only, timing-safe digest compare (`verifyUploadToken`). Disabled when the secret is unset. Exists because Apple Shortcuts cannot compute SigV4.
- **S3 compatibility:** Errors return S3 XML (`<Error><Code/>...</Error>`); `GET /` returns empty `ListBucketResult`; `GET /?location` returns `LocationConstraint`. Lets S3 clients (e.g. Shottr) pass their connection test.
- **CORS:** Reads/errors send `Access-Control-Allow-Origin: *`. OPTIONS preflight allows only `ALLOWED_ORIGINS` (mrdemonwolf.com), which gates browser-based writes.
- **Key resolution:** `resolveKey()` strips a leading `shottr/` prefix and returns `null` on malformed percent-escapes (→ 400 `InvalidURI`).
- **Serving:** conditional requests (`onlyIf` → 304), `Range` (→ 206), `writeHttpMetadata` for full R2 metadata, `nosniff` + CSP on all object responses.
- **Cache:** unsigned range-less GETs go through `caches.default` (edge cache, purged on PUT/DELETE overwrite); responses carry `public, max-age=31536000, immutable`. Presigned responses: `private, max-age=60`, never edge-cached.
- **Config:** `wrangler.toml` sets `[limits] cpu_ms = 50` (requires Workers Standard paid plan), `[observability]` on, `minify`, `workers_dev = false`. Wrangler v4.
- **TypeScript:** Strict mode, targets ESNext, uses `@cloudflare/workers-types` — no emit (wrangler handles bundling). `tsconfig` includes `src/` only; tests are not typechecked.
