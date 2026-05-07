# shottr - R2-backed Image CDN Worker

A lightweight Cloudflare Worker that proxies a Cloudflare R2 bucket as
an image CDN at `img.mrdemonwolf.com`. It handles serving, uploading,
and deleting images with strict CORS controls, full SigV4 authentication
for writes, and aggressive edge caching for reads. Built for Shottr
screenshot uploads — fast delivery, zero infrastructure overhead.

Keep your screenshots hosted. Keep your CDN simple.

## Features

- **R2 proxying** — Serves objects directly from a bound R2 bucket with
  correct `Content-Type` headers and branded 404 pages.
- **Aggressive caching** — Served objects carry
  `Cache-Control: public, max-age=31536000, immutable` for full edge
  and browser caching.
- **Full SigV4 authentication** — `PUT` and `DELETE` require a valid
  AWS Signature V4 `Authorization` header. `GET` supports presigned
  URLs with expiry and signature verification via Web Crypto.
- **CORS enforcement** — Restricts `Access-Control-Allow-Origin` to
  `mrdemonwolf.com` and `www.mrdemonwolf.com` only.
- **Key normalisation** — Accepts paths with or without the bucket-name
  prefix (`/shottr/foo.png` and `/foo.png` resolve to the same object).
- **S3 compatibility** — Returns S3 XML error responses, a stub
  `ListBucketResult` on `GET /`, and a `LocationConstraint` on
  `GET /?location` so S3 clients pass their connection test.
- **Delete support** — Authenticated `DELETE` requests remove objects
  from R2.

## Getting Started

1. Clone the repository.
   ```bash
   git clone https://github.com/mrdemonwolf/shottr.git
   cd shottr
   ```
2. Install dependencies.
   ```bash
   npm install
   ```
3. Set required secrets.
   ```bash
   npx wrangler secret put S3_ACCESS_KEY_ID
   npx wrangler secret put S3_SECRET_ACCESS_KEY
   ```
4. Deploy.
   ```bash
   npm run deploy
   ```

## Usage

**Serve an image** (public, no auth required):
```
GET https://img.mrdemonwolf.com/screenshot.png
```

**Upload via curl** (SigV4 header required):
```bash
curl -X PUT https://img.mrdemonwolf.com/screenshot.png \
  -H "Authorization: AWS4-HMAC-SHA256 Credential=<key>/..." \
  -H "Content-Type: image/png" \
  --data-binary @screenshot.png
```

**Presigned GET** (time-limited, no credentials in request):
```
GET https://img.mrdemonwolf.com/screenshot.png
  ?X-Amz-Algorithm=AWS4-HMAC-SHA256
  &X-Amz-Credential=...
  &X-Amz-Date=...
  &X-Amz-Expires=3600
  &X-Amz-SignedHeaders=host
  &X-Amz-Signature=...
```

Any S3-compatible client (including Shottr's built-in S3 upload) can
point at `https://img.mrdemonwolf.com` with the configured key pair and
use it as a standard S3 bucket.

## Tech Stack

| Layer      | Technology                      |
| ---------- | ------------------------------- |
| Runtime    | Cloudflare Workers              |
| Storage    | Cloudflare R2                   |
| Language   | TypeScript (strict, ESNext)     |
| Auth       | AWS Signature V4 (Web Crypto)   |
| Deployment | Wrangler CLI                    |
| Testing    | Vitest                          |
| Type defs  | `@cloudflare/workers-types`     |

## Development

### Prerequisites

- Node.js 20+
- Wrangler CLI (`npm install` installs it locally)
- A Cloudflare account with an R2 bucket named `shottr`

### Setup

1. Install dependencies.
   ```bash
   npm install
   ```
2. Set secrets for local dev (write to `.dev.vars`).
   ```bash
   echo "S3_ACCESS_KEY_ID=your_key" >> .dev.vars
   echo "S3_SECRET_ACCESS_KEY=your_secret" >> .dev.vars
   ```
3. Start the local dev server.
   ```bash
   npm run dev
   ```

### Development Scripts

- `npm run dev` — Runs the worker locally via `wrangler dev`.
- `npm run deploy` — Builds and deploys the worker to Cloudflare.
- `npm run typecheck` — Runs `tsc --noEmit` for type checking only.
- `npm run test` — Runs the Vitest test suite.
- `npm run build` — Dry-run deploy to `dist/` without publishing.

### Code Quality

- TypeScript strict mode (`noEmit`, `strict`, `ESNext` target).
- `@cloudflare/workers-types` for accurate R2 and Workers type
  definitions.
- Vitest for unit tests including SigV4 verification logic.

## Project Structure

```
.
├── src/
│   ├── index.ts      # Worker entry point — all HTTP request handling
│   └── sigv4.ts      # SigV4 header + presigned URL verification
├── wrangler.toml     # Cloudflare Worker config, routes, R2 binding
├── tsconfig.json     # TypeScript compiler options
└── package.json      # Scripts and dev dependencies
```

## License

![GitHub license](https://img.shields.io/github/license/mrdemonwolf/shottr.svg?style=for-the-badge&logo=github)

## Contact

For questions or feedback:

- Discord: [Join my server](https://mrdwolf.net/discord)

---

Made with love by [MrDemonWolf, Inc.](https://www.mrdemonwolf.com)
