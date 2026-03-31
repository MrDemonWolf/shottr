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
      const token = request.headers.get("Authorization")?.replace("Bearer ", "");
      if (!env.AUTH_TOKEN || token !== env.AUTH_TOKEN) {
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
