# shottr - R2-backed Image CDN Worker

A lightweight Cloudflare Worker that proxies a Cloudflare R2 bucket as
an image CDN at `img.mrdemonwolf.com`. It handles serving, uploading,
and deleting images with strict CORS controls and aggressive caching.
Built to keep image delivery fast and infrastructure simple.

## Features

- **R2 proxying** — Serves objects directly from a bound R2 bucket with
  correct `Content-Type` headers.
- **Aggressive caching** — All served objects carry
  `Cache-Control: public, max-age=31536000, immutable` for edge and
  browser caching.
- **CORS enforcement** — Restricts `Access-Control-Allow-Origin` to
  `mrdemonwolf.com` and `www.mrdemonwolf.com` only.
- **Upload support** — `PUT` requests write objects to R2 and preserve
  the incoming `Content-Type`.
- **Key normalisation** — Accepts paths with or without the bucket-name
  prefix (`/shottr/foo.png` and `/foo.png` both resolve to the same
  object).
- **Delete support** — `DELETE` requests remove objects from R2.

## Getting Started

1. Install dependencies:
   ```bash
   npm install
   ```
2. Authenticate with Cloudflare:
   ```bash
   npx wrangler login
   ```
3. Start the local dev server:
   ```bash
   npm run dev
   ```

## Tech Stack

| Layer    | Technology          |
| -------- | ------------------- |
| Runtime  | Cloudflare Workers  |
| Storage  | Cloudflare R2       |
| Language | TypeScript (ESNext) |
| Tooling  | Wrangler v3         |

## Development

### Prerequisites

- Node.js 18 or later
- A Cloudflare account with R2 enabled
- Wrangler v3 (`npm install` pulls it as a dev dependency)

### Setup

1. Clone the repository and install dependencies:
   ```bash
   npm install
   ```
2. Confirm the R2 bucket binding in `wrangler.toml` matches your
   Cloudflare account:
   ```toml
   [[r2_buckets]]
   binding = "BUCKET"
   bucket_name = "shottr"
   ```
3. Start local development:
   ```bash
   npm run dev
   ```
4. Deploy to production:
   ```bash
   npm run deploy
   ```

### Development Scripts

- `npm run dev` — Runs the worker locally via `wrangler dev`.
- `npm run deploy` — Builds and deploys the worker to Cloudflare.

### Code Quality

- TypeScript strict mode enabled (`noEmit`, `strict`, `ESNext` target).
- `@cloudflare/workers-types` for accurate R2 and Workers type
  definitions.

## Project Structure

```
.
├── src/
│   └── index.ts      # Worker entry point (all request handling)
├── wrangler.toml     # Cloudflare Worker config, routes, and R2 binding
├── tsconfig.json     # TypeScript compiler options
└── package.json      # Scripts and dev dependencies
```

## License

![GitHub license](https://img.shields.io/github/license/mrdemonwolf/shottr.svg?style=for-the-badge&logo=github)

## Contact

Questions or feedback? [Join my server](https://mrdwolf.net/discord)

---

Made with love by [MrDemonWolf, Inc.](https://www.mrdemonwolf.com)
