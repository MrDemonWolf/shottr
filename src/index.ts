/**
 * MrDemonWolf, Inc. — Image CDN Worker
 * Proxies R2 bucket for img.mrdemonwolf.com
 * Verifies S3 SigV4 on uploads (header) and presigned GETs (query string).
 */

import { verifyAuthHeader, verifyPresigned } from "./sigv4";

export interface Env {
  BUCKET: R2Bucket;
  S3_ACCESS_KEY_ID: string;
  S3_SECRET_ACCESS_KEY: string;
  /**
   * Optional. When set, enables `Authorization: Bearer <token>` uploads
   * (PUT only, image extensions only) for clients that can't sign SigV4,
   * e.g. Apple Shortcuts. Unset = the path is disabled.
   */
  SHORTCUTS_UPLOAD_TOKEN?: string;
}

const BUCKET_NAME = "shottr";
const ALLOWED_ORIGINS = [
  "https://mrdemonwolf.com",
  "https://www.mrdemonwolf.com",
];
const MAX_KEY_LENGTH = 1024;

// Bearer-token uploads are limited to plain image types — the token is
// embedded in a shareable .shortcut file, so its blast radius stays small.
const BEARER_UPLOAD_EXTENSIONS = /\.(png|jpe?g|gif|webp|heic)$/i;

// Preflight-only headers; browsers never need these on actual responses.
const PREFLIGHT_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Methods": "GET, HEAD, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, x-amz-content-sha256, x-amz-date, x-amz-acl",
  "Access-Control-Max-Age": "86400",
};

const LOCATION_XML = `<?xml version="1.0" encoding="UTF-8"?><LocationConstraint xmlns="http://s3.amazonaws.com/doc/2006-03-01/">auto</LocationConstraint>`;
const LIST_XML = `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${BUCKET_NAME}</Name><MaxKeys>0</MaxKeys><IsTruncated>false</IsTruncated></ListBucketResult>`;

const NOT_FOUND_HTML = (key: string) => `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>404 · img.mrdemonwolf.com</title>
<style>
 body{font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:#0F172A;color:#F8FAFC;
      display:grid;place-items:center;min-height:100vh;margin:0;padding:24px}
 .card{border:1px solid #6366F1;border-radius:8px;padding:32px 40px;max-width:520px;
       box-shadow:0 0 0 1px rgba(99,102,241,.15),0 24px 64px -24px rgba(99,102,241,.35)}
 h1{margin:0 0 12px;font-size:18px;color:#6366F1;letter-spacing:.02em}
 p{margin:6px 0;color:#CFD4DB}
 code{color:#F8FAFC;background:rgba(99,102,241,.12);padding:2px 6px;border-radius:4px;
      word-break:break-all}
 a{color:#6366F1;text-decoration:none}
 a:hover{text-decoration:underline}
 .brand{margin-top:20px;padding-top:16px;border-top:1px solid rgba(207,212,219,.15);
        font-size:12px;color:#64748B}
 .logo{display:block;width:56px;height:56px;margin-bottom:16px}
</style></head><body>
<div class="card">
  <img class="logo" src="https://www.mrdemonwolf.com/wp-content/uploads/2022/12/cropped-logo-white-border-192x192.png" alt="MrDemonWolf logo">
  <h1>▲ 404 · object not found</h1>
  <p>key: <code>${escapeHtml(key) || "(empty)"}</code></p>
  <p><a href="https://mrdemonwolf.com">← mrdemonwolf.com</a></p>
  <div class="brand">img.mrdemonwolf.com · MrDemonWolf, Inc. CDN</div>
</div></body></html>`;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function wantsHtml(request: Request): boolean {
  return (request.headers.get("Accept") ?? "").includes("text/html");
}

function preflightHeaders(request: Request): Headers {
  const headers = new Headers(PREFLIGHT_HEADERS);
  const origin = request.headers.get("Origin") ?? "";
  if (ALLOWED_ORIGINS.includes(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
  }
  return headers;
}

function s3Error(code: string, message: string, status: number): Response {
  const body = `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`;
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "application/xml",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function xmlResponse(body: string, isHead: boolean): Response {
  return new Response(isHead ? null : body, {
    headers: {
      "Content-Type": "application/xml",
      "Access-Control-Allow-Origin": "*",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function notFound(request: Request, key: string): Response {
  // Browser navigation gets the branded HTML 404; S3 clients get XML.
  if (request.method === "GET" && wantsHtml(request)) {
    return new Response(NOT_FOUND_HTML(key), {
      status: 404,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; img-src https://www.mrdemonwolf.com",
      },
    });
  }
  return s3Error("NoSuchKey", "The specified key does not exist.", 404);
}

/**
 * Resolve the object key from the URL path, stripping an optional
 * `<bucket>/` prefix so path-style S3 clients and bare CDN URLs agree.
 * Returns null when the path contains malformed percent-escapes.
 */
export function resolveKey(url: URL): string | null {
  let key: string;
  try {
    key = decodeURIComponent(url.pathname.slice(1));
  } catch {
    return null;
  }
  if (key.startsWith(`${BUCKET_NAME}/`)) {
    key = key.slice(`${BUCKET_NAME}/`.length);
  }
  return key;
}

/**
 * Timing-safe check of a Bearer upload token. Both sides are hashed
 * first so the comparison length never depends on the real token.
 */
export async function verifyUploadToken(
  presented: string,
  expected: string | undefined,
): Promise<boolean> {
  if (!expected) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(presented)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  const av = new Uint8Array(a);
  const bv = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < av.length; i++) diff |= av[i] ^ bv[i];
  return diff === 0;
}

/** Normalized edge-cache key: object key only, no query string. */
function cacheKeyFor(url: URL, key: string): Request {
  const path = key.split("/").map(encodeURIComponent).join("/");
  return new Request(`https://${url.host}/${path}`, { method: "GET" });
}

function objectHeaders(obj: R2Object, presigned: boolean): Headers {
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/octet-stream");
  }
  headers.set("ETag", obj.httpEtag);
  headers.set("Last-Modified", obj.uploaded.toUTCString());
  headers.set("Content-Length", String(obj.size));
  headers.set("Accept-Ranges", "bytes");
  // Presigned responses: short private cache so expiry means something.
  // Unsigned responses: long-lived immutable cache (public CDN behavior).
  headers.set(
    "Cache-Control",
    presigned ? "private, max-age=60" : "public, max-age=31536000, immutable",
  );
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Content-Security-Policy", "default-src 'none'; sandbox");
  return headers;
}

function contentRange(range: R2Range, size: number): { start: number; end: number } {
  if ("suffix" in range) {
    return { start: size - range.suffix, end: size - 1 };
  }
  const start = range.offset ?? 0;
  const end =
    range.length !== undefined ? start + range.length - 1 : size - 1;
  return { start, end };
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: preflightHeaders(request),
      });
    }

    if (request.method === "PUT" || request.method === "DELETE") {
      const authz = request.headers.get("Authorization") ?? "";
      const bearer = authz.startsWith("Bearer ");

      if (bearer) {
        // Apple Shortcuts path: static token, uploads only — never DELETE.
        if (request.method !== "PUT") {
          return s3Error(
            "AccessDenied",
            "Bearer tokens may only upload objects.",
            403,
          );
        }
        const ok = await verifyUploadToken(
          authz.slice("Bearer ".length),
          env.SHORTCUTS_UPLOAD_TOKEN,
        );
        if (!ok) {
          return s3Error("InvalidAccessKeyId", "Invalid upload token.", 403);
        }
      } else {
        const verify = await verifyAuthHeader(request, url, env);
        if (!verify.ok) {
          return s3Error(verify.code, verify.message, 403);
        }
      }

      const key = resolveKey(url);
      if (key === null) {
        return s3Error("InvalidURI", "Couldn't parse the specified URI.", 400);
      }
      if (key === "" || key.length > MAX_KEY_LENGTH) {
        return s3Error("InvalidRequest", "Missing or invalid object key.", 400);
      }
      if (bearer && !BEARER_UPLOAD_EXTENSIONS.test(key)) {
        return s3Error(
          "InvalidRequest",
          "Upload token only accepts image files.",
          400,
        );
      }

      if (request.method === "PUT") {
        const obj = await env.BUCKET.put(key, request.body, {
          httpMetadata: {
            contentType:
              request.headers.get("Content-Type") ?? "application/octet-stream",
          },
        });
        // Drop any stale cached copy on overwrite.
        ctx.waitUntil(caches.default.delete(cacheKeyFor(url, key)));
        const headers = new Headers({ "Access-Control-Allow-Origin": "*" });
        if (obj?.httpEtag) headers.set("ETag", obj.httpEtag);
        return new Response(null, { status: 200, headers });
      }

      await env.BUCKET.delete(key);
      ctx.waitUntil(caches.default.delete(cacheKeyFor(url, key)));
      return new Response(null, {
        status: 204,
        headers: { "Access-Control-Allow-Origin": "*" },
      });
    }

    if (request.method === "GET" || request.method === "HEAD") {
      const verify = await verifyPresigned(request, url, env);
      if (!verify.ok) {
        return s3Error(verify.code, verify.message, 403);
      }

      const key = resolveKey(url);
      if (key === null) {
        return s3Error("InvalidURI", "Couldn't parse the specified URI.", 400);
      }

      // S3 client connection probes against the bucket root.
      if (key === "") {
        const isHead = request.method === "HEAD";
        return url.searchParams.has("location")
          ? xmlResponse(LOCATION_XML, isHead)
          : xmlResponse(LIST_XML, isHead);
      }

      if (request.method === "HEAD") {
        const head = await env.BUCKET.head(key);
        if (!head) return notFound(request, key);
        return new Response(null, {
          headers: objectHeaders(head, verify.presigned),
        });
      }

      const cacheable = !verify.presigned && !request.headers.has("Range");
      const cacheKey = cacheKeyFor(url, key);

      if (cacheable) {
        const hit = await caches.default.match(cacheKey);
        if (hit) {
          const inm = request.headers.get("If-None-Match");
          const etag = hit.headers.get("ETag");
          if (inm && etag && inm.includes(etag)) {
            const headers = new Headers(hit.headers);
            headers.delete("Content-Length");
            return new Response(null, { status: 304, headers });
          }
          return hit;
        }
      }

      let obj: R2ObjectBody | R2Object | null;
      try {
        obj = await env.BUCKET.get(key, {
          onlyIf: request.headers,
          range: request.headers.has("Range") ? request.headers : undefined,
        });
      } catch {
        // Only a Range request can legitimately fail with 416; anything
        // else that throws here is an R2/runtime failure, not client error.
        if (request.headers.has("Range")) {
          return s3Error(
            "InvalidRange",
            "The requested range is not satisfiable.",
            416,
          );
        }
        return s3Error("InternalError", "Failed to read the object.", 500);
      }
      if (!obj) return notFound(request, key);

      const headers = objectHeaders(obj, verify.presigned);

      // Precondition triggered (e.g. If-None-Match matched): body is absent.
      if (!("body" in obj)) {
        headers.delete("Content-Length");
        // If-None-Match / If-Modified-Since are conditional-GET validators:
        // an unmet condition means "not modified". If-Match and
        // If-Unmodified-Since are guards: an unmet condition is a failure.
        const notModified =
          request.headers.has("If-None-Match") ||
          request.headers.has("If-Modified-Since");
        return new Response(null, { status: notModified ? 304 : 412, headers });
      }

      if (obj.range) {
        const { start, end } = contentRange(obj.range, obj.size);
        headers.set("Content-Range", `bytes ${start}-${end}/${obj.size}`);
        headers.set("Content-Length", String(end - start + 1));
        return new Response(obj.body, { status: 206, headers });
      }

      const response = new Response(obj.body, { headers });
      if (cacheable) {
        ctx.waitUntil(caches.default.put(cacheKey, response.clone()));
      }
      return response;
    }

    return s3Error("MethodNotAllowed", "The specified method is not allowed.", 405);
  },
} satisfies ExportedHandler<Env>;
