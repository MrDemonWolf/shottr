# GEMINI.md - MrDemonWolf Image CDN

## Project Overview
This project is a Cloudflare Worker that serves as an image CDN for `img.mrdemonwolf.com`. It acts as a proxy for a Cloudflare R2 bucket named `mrdemonwolf-images`.

### Core Features:
- **Image Serving:** Proxies GET and HEAD requests to retrieve images from the R2 bucket.
- **CORS Support:** Configured to allow requests from `https://mrdemonwolf.com` and `https://www.mrdemonwolf.com`.
- **Upload/Delete Support:** Supports PUT requests for uploading images and DELETE requests for removing them.
- **Cache Management:** Sets `Cache-Control: public, max-age=31536000, immutable` for retrieved images to leverage Cloudflare's edge caching.
- **Compatibility:** Provides a basic XML response for bucket root GET requests to mimic AWS S3 listing behavior.

## Technical Stack
- **Language:** TypeScript
- **Runtime:** Cloudflare Workers
- **Storage:** Cloudflare R2
- **Deployment Tool:** Wrangler

## Commands

### Development
```bash
npm run dev # Runs wrangler dev for local testing
```

### Deployment
```bash
npm run deploy # Deploys the worker to Cloudflare using wrangler deploy
```

## Project Structure
- `src/index.ts`: The main entry point containing the Worker's `fetch` handler.
- `wrangler.toml`: Configuration file for the Cloudflare Worker, including R2 bucket bindings and custom routes.
- `package.json`: Contains project dependencies and scripts.
- `tsconfig.json`: TypeScript configuration for the project.

## Development Conventions
- **Environment Variables:** Bucket binding is named `BUCKET` in `wrangler.toml` and accessed via `env.BUCKET`.
- **Allowed Origins:** Origins are hardcoded in `src/index.ts` within the `ALLOWED_ORIGINS` array.
- **Key Resolution:** The `resolveKey` function in `src/index.ts` handles mapping URL paths to R2 bucket keys, including stripping the bucket name prefix if present.
