/**
 * MrDemonWolf, Inc. — Image CDN Worker
 * Proxies R2 bucket for img.mrdemonwolf.com
 * Validates S3 SigV4 on uploads (header) and presigned GETs (query string).
 */

import { checkSigV4Header, verifyPresigned } from "./sigv4";

export interface Env {
  BUCKET: R2Bucket;
  S3_ACCESS_KEY_ID: string;
  S3_SECRET_ACCESS_KEY: string;
}

const BUCKET_NAME = "shottr";
const ALLOWED_ORIGINS = [
  "https://mrdemonwolf.com",
  "https://www.mrdemonwolf.com",
];

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
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, x-amz-content-sha256, x-amz-date, x-amz-acl",
    "Access-Control-Max-Age": "86400",
  };
  if (ALLOWED_ORIGINS.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function s3Error(
  code: string,
  message: string,
  status: number,
  request: Request,
): Response {
  const body = `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`;
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "application/xml",
      "Cache-Control": "no-store",
      ...corsHeaders(request),
    },
  });
}

function resolveKey(url: URL): string {
  let key = decodeURIComponent(url.pathname.slice(1));
  if (key.startsWith(`${BUCKET_NAME}/`)) {
    key = key.slice(`${BUCKET_NAME}/`.length);
  }
  return key;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const key = resolveKey(url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    if (request.method === "PUT" || request.method === "DELETE") {
      if (!checkSigV4Header(request, env)) {
        return s3Error(
          "InvalidAccessKeyId",
          "The AWS access key ID you provided does not exist in our records.",
          403,
          request,
        );
      }
    }

    if (request.method === "PUT") {
      const obj = await env.BUCKET.put(key, request.body, {
        httpMetadata: {
          contentType:
            request.headers.get("Content-Type") ?? "application/octet-stream",
        },
      });
      return new Response(null, {
        status: 200,
        headers: {
          ETag: obj?.etag ? `"${obj.etag}"` : "",
          ...corsHeaders(request),
        },
      });
    }

    // GET /?location — S3 bucket location probe
    if (
      request.method === "GET" &&
      key === "" &&
      url.searchParams.has("location")
    ) {
      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?><LocationConstraint xmlns="http://s3.amazonaws.com/doc/2006-03-01/">auto</LocationConstraint>`,
        {
          headers: {
            "Content-Type": "application/xml",
            ...corsHeaders(request),
          },
        },
      );
    }

    // GET / — list (empty) so S3 clients accept the connection test
    if (request.method === "GET" && key === "") {
      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${BUCKET_NAME}</Name><MaxKeys>0</MaxKeys><IsTruncated>false</IsTruncated></ListBucketResult>`,
        {
          headers: {
            "Content-Type": "application/xml",
            ...corsHeaders(request),
          },
        },
      );
    }

    if (request.method === "GET" || request.method === "HEAD") {
      const verify = await verifyPresigned(request, url, env);
      if (!verify.ok) {
        return s3Error(verify.code, verify.message, 403, request);
      }

      const obj = await env.BUCKET.get(key);
      if (!obj) {
        // Browser navigation gets the branded HTML 404; S3 clients get XML.
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
        return s3Error(
          "NoSuchKey",
          "The specified key does not exist.",
          404,
          request,
        );
      }

      // Presigned responses: short cache so expiry is honored at edge.
      // Unsigned responses: long-lived immutable cache (public CDN behavior).
      const cacheControl = verify.presigned
        ? "private, max-age=60"
        : "public, max-age=31536000, immutable";

      const headers = new Headers({
        "Content-Type":
          obj.httpMetadata?.contentType ?? "application/octet-stream",
        ETag: `"${obj.etag}"`,
        "Cache-Control": cacheControl,
        ...corsHeaders(request),
      });

      return new Response(request.method === "HEAD" ? null : obj.body, {
        headers,
      });
    }

    if (request.method === "DELETE") {
      await env.BUCKET.delete(key);
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request),
      });
    }

    return s3Error(
      "MethodNotAllowed",
      "The specified method is not allowed.",
      405,
      request,
    );
  },
} satisfies ExportedHandler<Env>;
