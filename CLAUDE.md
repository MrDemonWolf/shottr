# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Cloudflare Worker that proxies a Cloudflare R2 bucket (`shottr`) as an image CDN at `img.mrdemonwolf.com`. The single worker handles GET/HEAD (serve), PUT (upload), DELETE, and OPTIONS (CORS preflight).

## Commands

```bash
npm run dev      # Local dev via wrangler dev
npm run deploy   # Deploy to Cloudflare Workers
```

No test runner is configured.

## Key details

- **Entry point:** `src/index.ts`
- **R2 binding:** `env.BUCKET` → bucket `shottr`
- **CORS:** Only `https://mrdemonwolf.com` and `https://www.mrdemonwolf.com` receive `Access-Control-Allow-Origin`; all other origins get CORS headers without the allow-origin header.
- **Key resolution:** `resolveKey()` strips a leading `shottr/` prefix from the URL path so both `/image.png` and `/shottr/image.png` resolve to the same object.
- **Cache:** Served objects get `Cache-Control: public, max-age=31536000, immutable`.
- **TypeScript:** Strict mode, targets ESNext, uses `@cloudflare/workers-types` — no emit (wrangler handles bundling).
