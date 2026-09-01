![MrDemonWolf logo](assets/logo.png)

# shottr - R2-backed Image CDN Worker

A lightweight Cloudflare Worker that proxies a Cloudflare R2 bucket as
an image CDN at `img.mrdemonwolf.com`. It handles serving, uploading,
and deleting images with full SigV4 authentication for writes and
aggressive edge caching for reads. Built for Shottr screenshot
uploads — fast delivery, zero infrastructure overhead.

Keep your screenshots hosted. Keep your CDN simple.

## Features

- **R2 proxying** — Serves objects directly from a bound R2 bucket with
  full HTTP metadata (`Content-Type`, `Content-Encoding`, `ETag`,
  `Last-Modified`), conditional requests (`If-None-Match` to `304`),
  `Range` requests (`206`), and branded 404 pages.
- **Edge caching** — Cache-hit `GET`s are answered from Cloudflare's
  edge cache without touching R2; responses carry
  `Cache-Control: public, max-age=31536000, immutable` for browsers.
  Overwrites and deletes purge the cached copy.
- **Full SigV4 authentication** — `PUT` and `DELETE` require a valid
  AWS Signature V4 `Authorization` header; the signature, timestamp
  (15 minute skew window), and credential scope are all verified with
  Web Crypto. `GET` additionally supports presigned URLs with expiry
  and signature verification. Zero runtime dependencies.
- **Security headers** — Served objects carry
  `X-Content-Type-Options: nosniff` and a locked-down
  `Content-Security-Policy`, so uploaded SVG/HTML can't run scripts on
  the CDN origin.
- **CORS model** — Public reads answer any origin (`*`); browser-based
  writes are limited to `mrdemonwolf.com` origins at preflight.
- **Key normalisation** — Accepts paths with or without the bucket-name
  prefix (`/shottr/foo.png` and `/foo.png` resolve to the same object).
- **S3 compatibility** — Returns S3 XML error responses, a stub
  `ListBucketResult` on `GET /`, and a `LocationConstraint` on
  `GET /?location` so S3 clients pass their connection test.
- **Hard CPU cap with auto-fallback** — `[limits] cpu_ms = 50` in
  `wrangler.toml` caps per-request CPU on the Workers Standard plan.
  The deploy script detects the Free plan and automatically retries
  without the cap, so deploys never fail over it. Observability
  (Workers Logs) is enabled and the deployed bundle is minified.
- **Apple Shortcuts uploads (optional)** — a Bearer-token upload path
  (PUT only, image extensions only) for clients that can't sign
  SigV4, so a one-tap iPhone/Mac Shortcut can upload screenshots too.
  Disabled unless the `SHORTCUTS_UPLOAD_TOKEN` secret is set.

## Getting Started

This section takes you from a bare Cloudflare account to a working
image CDN that [Shottr](https://shottr.cc) uploads to directly. When
you're done, screenshots land in your own R2 bucket and serve from
your own domain — no third-party image host, no egress fees.

```
Shottr --(SigV4-signed PUT)--> Worker --> R2 bucket
Browser <--(cached GET)------- Worker <-- R2 bucket
```

The Worker is the only thing in front of the bucket. It verifies AWS
Signature V4 on uploads and deletes, serves objects publicly with
long-lived edge caching, and speaks just enough S3 XML for Shottr's
connection test to pass.

### Prerequisites

- A [Cloudflare account](https://dash.cloudflare.com/sign-up) with a
  domain added to it (the CDN serves from a subdomain of it).
- R2 enabled on the account (Dashboard, then R2 — it needs a payment
  method on file, but has a generous free tier and zero egress fees).
- [Bun](https://bun.sh) (or Node.js 20+ with npm — swap `bun`/`bunx`
  for `npm`/`npx` below).
- The [Shottr](https://shottr.cc) app (macOS).
- Optional: the paid Workers Standard plan for the hard
  `[limits] cpu_ms = 50` CPU cap. On the Free plan the deploy script
  automatically drops the cap and Cloudflare's built-in 10 ms limit
  applies instead — no action needed either way.

### 1. Fork, clone, install

```bash
git clone https://github.com/mrdemonwolf/shottr.git
cd shottr
bun install
```

Log Wrangler into your Cloudflare account:

```bash
bunx wrangler login
```

### 2. Create the R2 bucket

```bash
bunx wrangler r2 bucket create shottr
```

Use any bucket name you like — just keep it consistent in step 4.

### 3. Create the S3 credentials (R2 API token)

This is the pair of keys that does double duty: Shottr signs uploads
with it, and the Worker verifies those signatures against it. It is
not an AWS credential — R2 issues its own S3-compatible keys.

1. Dashboard, then R2, then Manage R2 API Tokens, then
   Create API Token.
2. Permissions: Object Read & Write, scoped to just your bucket.
3. Copy the Access Key ID and Secret Access Key — the secret is shown
   only once.

Store them as Worker secrets (paste each value when prompted):

```bash
bunx wrangler secret put S3_ACCESS_KEY_ID
bunx wrangler secret put S3_SECRET_ACCESS_KEY
```

Both are required — uploads are rejected and presigned reads fail
without them. For local dev, put the same pair in a `.dev.vars` file
(gitignored):

```
S3_ACCESS_KEY_ID=your_key
S3_SECRET_ACCESS_KEY=your_secret
```

The Worker never forwards these keys to R2 — it talks to the bucket
through its binding. The keys exist purely so signatures can be
verified at the edge.

### 4. Fork checklist — values to change

Everything branded or hardcoded in one list:

| File           | What to change                                                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `wrangler.toml` | `name` (your worker name), `routes` pattern + `zone_name` (your domain), `bucket_name` (from step 2)                                                  |
| `src/index.ts`  | `BUCKET_NAME` (must match `bucket_name`), `ALLOWED_ORIGINS` (origins allowed to preflight writes), the domain and links inside `NOT_FOUND_HTML`       |
| `README.md`     | Domain references, if you care                                                                                                                        |

### 5. Point DNS at the Worker

Two options:

Easiest (recommended for forks): replace the `routes` entry in
`wrangler.toml` with a custom domain — Cloudflare creates the DNS
record and certificate for you on deploy:

```toml
routes = [
  { pattern = "img.yourdomain.com", custom_domain = true }
]
```

Zone route (what this repo uses): keep the
`{ pattern = "img.yourdomain.com/*", zone_name = "yourdomain.com" }`
form, and create a proxied (orange-cloud) DNS record for `img`
yourself: Dashboard, your zone, DNS, Add record — type `AAAA`, name
`img`, value `100::`, proxied. The Worker intercepts all traffic on
the route, so the record's target is a placeholder.

### 6. Deploy and smoke-test

```bash
bun run deploy
```

The deploy script tries the full config first; if Cloudflare rejects
the `[limits]` CPU cap (Free plan), it automatically retries without
it. Then check the basics:

```bash
curl -sI https://img.yourdomain.com/anything.png
```

Expect a `404` with S3-style XML (nothing uploaded yet) — that means
the Worker is live. An unsigned write must be rejected:

```bash
curl -si -X PUT https://img.yourdomain.com/test.png --data-binary @/dev/null
```

Expect `403` with `<Code>AccessDenied</Code>`. A properly signed
upload (for example via the AWS CLI pointed at your domain) returns
`200` with an `ETag`:

```bash
aws s3 cp screenshot.png s3://shottr/screenshot.png \
  --endpoint-url https://img.yourdomain.com
```

### 7. Configure Shottr

Shottr, then Preferences, then Cloud, then choose S3-compatible:

| Field                  | Value                                                                                                 |
| ---------------------- | ----------------------------------------------------------------------------------------------------- |
| Endpoint / Server      | `https://img.yourdomain.com`                                                                          |
| Bucket                 | your bucket name (for example `shottr`)                                                               |
| Region                 | `auto`                                                                                                |
| Access Key ID          | from step 3                                                                                           |
| Secret Access Key      | from step 3                                                                                           |
| Path-style addressing  | On (the Worker also strips the `bucket/` path prefix, so either style resolves)                       |
| Public / custom URL    | `https://img.yourdomain.com/`                                                                         |

Hit Shottr's Test / Check button — the Worker answers the S3
connection probes (`GET /`, `GET /?location`) with stub XML so the
test passes. Take a screenshot, upload, and the returned URL should
serve instantly from the edge.

### 8. Optional: upload from Apple Shortcuts

Shortcuts has no HMAC/SHA-256 actions, so it can't sign SigV4. The
Worker instead offers an opt-in Bearer-token path — PUT only (the
token can never delete), image extensions only, disabled until you
set the secret:

```bash
openssl rand -base64 32   # generate a token, save it somewhere safe
bunx wrangler secret put SHORTCUTS_UPLOAD_TOKEN
```

Then build this shortcut (iOS and macOS, one shortcut). In the
shortcut's settings enable Show in Share Sheet with Images (add Files
too so macOS Finder Quick Actions work):

1. If — `Shortcut Input` has any value; Otherwise — `Select Photos`;
   End If. Use the If Result as the image.
2. Optional: Convert Image to PNG (normalizes HEIC photo shares;
   screenshots are already PNG).
3. Format Date — Current Date, custom format `yyyyMMdd-HHmmss`.
4. Text — `ss-[Formatted Date].png`. This is the object key; keep it
   URL-safe (no spaces).
5. Get Contents of URL:
   - URL: `https://img.yourdomain.com/[Text]`
   - Method: PUT
   - Header: `Authorization` = `Bearer YOUR-TOKEN`
   - Request Body: File — the image from step 1/2. (Leave
     Content-Type alone; Shortcuts sets it from the file type.)
6. Text — `https://img.yourdomain.com/[Text from step 4]`
7. Copy to Clipboard (the Text from step 6).
8. Show Notification — "Uploaded, URL copied".

Flow in practice — iPhone: screenshot, tap the thumbnail, share,
pick the shortcut, URL lands on the clipboard. Mac: right-click a
file, Quick Actions, or the share menu.

Keep the token private: anyone you share the `.shortcut` file with
gets it. If it leaks, rotate it with
`bunx wrangler secret put SHORTCUTS_UPLOAD_TOKEN` — the old token
stops working immediately.

macOS-only alternative with zero Worker changes: system `curl` can
sign real SigV4 in a Run Shell Script action:

```bash
curl -T screenshot.png --user "$KEY:$SECRET" \
  --aws-sigv4 "aws:amz:auto:s3" \
  https://img.yourdomain.com/screenshot.png
```

### Troubleshooting

| Symptom                                    | Cause / fix                                                                                                       |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `403 InvalidAccessKeyId`                   | Access Key ID in Shottr doesn't match the `S3_ACCESS_KEY_ID` secret. Re-check step 3.                             |
| `403 SignatureDoesNotMatch`                | Secret key mismatch, or the endpoint/bucket/path in Shottr doesn't match what was signed.                         |
| `403 RequestTimeTooSkewed`                 | Your machine's clock is more than 15 minutes off. Sync it.                                                        |
| `403 AccessDenied` on upload               | No `Authorization` header reached the Worker — client not signing, or a proxy stripped it.                        |
| `403 InvalidAccessKeyId` from a Shortcut   | Bearer token doesn't match `SHORTCUTS_UPLOAD_TOKEN`, or the secret was never set.                                 |
| `400 InvalidRequest` from a Shortcut       | Bearer uploads only accept image extensions (`png`, `jpg`, `jpeg`, `gif`, `webp`, `heic`).                        |
| `400 InvalidURI`                           | Malformed percent-encoding in the URL path.                                                                       |
| Deploy fails on the route                  | The zone in `zone_name` isn't on your account, or there's no proxied DNS record for the subdomain — see step 5.   |
| Images 404 in browser but exist in R2      | Key mismatch — check the `bucket/` prefix and that `BUCKET_NAME` in `src/index.ts` matches your bucket.           |

## Usage

Serve an image (public, no auth required):

```
GET https://img.mrdemonwolf.com/screenshot.png
```

Upload via curl (SigV4 header required):

```bash
curl -X PUT https://img.mrdemonwolf.com/screenshot.png \
  -H "Authorization: AWS4-HMAC-SHA256 Credential=<key>/..." \
  -H "Content-Type: image/png" \
  --data-binary @screenshot.png
```

Presigned GET (time-limited, no credentials in request):

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

- Bun (or Node.js 20+)
- Wrangler CLI (`bun install` installs it locally)
- A Cloudflare account with an R2 bucket (see Getting Started to
  create one)

### Setup

1. Install dependencies.
   ```bash
   bun install
   ```
2. Set secrets for local dev (write to `.dev.vars`).
   ```bash
   echo "S3_ACCESS_KEY_ID=your_key" >> .dev.vars
   echo "S3_SECRET_ACCESS_KEY=your_secret" >> .dev.vars
   ```
3. Start the local dev server.
   ```bash
   bun run dev
   ```

### Development Scripts

- `bun run dev` — Runs the worker locally via `wrangler dev` with a
  local R2 simulation.
- `bun run deploy` — Deploys via `scripts/deploy.mjs`; automatically
  retries without the `[limits]` CPU cap on the Free plan.
- `bun run typecheck` — Runs `tsc --noEmit` for type checking only.
- `bun run test` — Runs the Vitest test suite.
- `bun run build` — Dry-run deploy to `dist/` without publishing.

### Code Quality

- TypeScript strict mode (`noEmit`, `strict`, `ESNext` target).
- `@cloudflare/workers-types` for accurate R2 and Workers type
  definitions.
- Vitest for unit tests including full SigV4 verification logic,
  using `aws4` as the signing oracle.

## Project Structure

```
.
├── assets/
│   └── logo.png      # MrDemonWolf brand mark (used in this README)
├── src/
│   ├── index.ts      # Worker entry point — all HTTP request handling
│   └── sigv4.ts      # SigV4 header + presigned URL verification
├── tests/
│   ├── index.test.ts # Key-resolution unit tests
│   └── sigv4.test.ts # SigV4 verification tests (aws4 as oracle)
├── scripts/
│   └── deploy.mjs    # Deploy wrapper with CPU-limit auto-fallback
├── wrangler.toml     # Worker config, routes, R2 binding, CPU limits
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
