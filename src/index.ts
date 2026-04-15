/**
 * MrDemonWolf, Inc. — Image CDN Worker
 * Proxies R2 bucket for img.mrdemonwolf.com
 */

export interface Env {
  BUCKET: R2Bucket;
  AUTH_TOKEN: string;
}

const BUCKET_NAME = "shottr";
const ALLOWED_ORIGINS = [
  "https://mrdemonwolf.com",
  "https://www.mrdemonwolf.com",
];

/** Constant-time string comparison to prevent timing attacks on token check. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/** Extract bearer token. Returns null unless header is exactly `Bearer <token>`. */
function extractBearer(header: string | null): string | null {
  if (!header || !header.startsWith("Bearer ")) return null;
  return header.slice(7);
}

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
</style></head><body>
<div class="card">
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

function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("Origin") ?? "";
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, HEAD, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };

  if (ALLOWED_ORIGINS.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }

  return headers;
}

function resolveKey(url: URL): string {
  let key = decodeURIComponent(url.pathname.slice(1));

  // Strip bucket prefix if present
  if (key.startsWith(`${BUCKET_NAME}/`)) {
    key = key.slice(`${BUCKET_NAME}/`.length);
  }

  return key;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const key = resolveKey(url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request),
      });
    }

    // Auth gate for mutating requests
    if (request.method === "PUT" || request.method === "DELETE") {
      const token = extractBearer(request.headers.get("Authorization"));
      if (!env.AUTH_TOKEN || !token || !timingSafeEqual(token, env.AUTH_TOKEN)) {
        return new Response("Unauthorized", {
          status: 401,
          headers: corsHeaders(request),
        });
      }
    }

    // Upload
    if (request.method === "PUT") {
      await env.BUCKET.put(key, request.body, {
        httpMetadata: {
          contentType:
            request.headers.get("Content-Type") ?? "application/octet-stream",
        },
      });

      return new Response(null, {
        status: 200,
        headers: corsHeaders(request),
      });
    }

    // List (empty response for bucket root)
    if (request.method === "GET" && key === "") {
      return new Response(
        `<?xml version="1.0"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${BUCKET_NAME}</Name><MaxKeys>0</MaxKeys><IsTruncated>false</IsTruncated></ListBucketResult>`,
        {
          headers: {
            "Content-Type": "application/xml",
            ...corsHeaders(request),
          },
        },
      );
    }

    // Retrieve
    if (request.method === "GET" || request.method === "HEAD") {
      const obj = await env.BUCKET.get(key);

      if (!obj) {
        if (request.method === "GET" && wantsHtml(request)) {
          return new Response(NOT_FOUND_HTML(key), {
            status: 404,
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "no-store",
              ...corsHeaders(request),
            },
          });
        }
        return new Response("Not Found", {
          status: 404,
          headers: corsHeaders(request),
        });
      }

      const headers = new Headers({
        "Content-Type":
          obj.httpMetadata?.contentType ?? "application/octet-stream",
        ETag: obj.etag,
        "Cache-Control": "public, max-age=31536000, immutable",
        ...corsHeaders(request),
      });

      return new Response(request.method === "HEAD" ? null : obj.body, {
        headers,
      });
    }

    // Delete
    if (request.method === "DELETE") {
      await env.BUCKET.delete(key);
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request),
      });
    }

    return new Response("Method Not Allowed", {
      status: 405,
      headers: corsHeaders(request),
    });
  },
} satisfies ExportedHandler<Env>;
