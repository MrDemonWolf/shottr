/**
 * AWS Signature V4 presigned-URL verifier.
 *
 * Pure functions — only depend on Web Crypto, URL, and TextEncoder.
 * Runs in Cloudflare Workers and Node 20+ (vitest).
 *
 * Spec: https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
 */

const enc = new TextEncoder();

export interface SigningCreds {
  S3_ACCESS_KEY_ID: string;
  S3_SECRET_ACCESS_KEY: string;
}

export type VerifyResult =
  | { ok: true; presigned: boolean }
  | { ok: false; code: string; message: string };

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return bytesToHex(new Uint8Array(buf));
}

async function hmac(
  key: ArrayBuffer | Uint8Array | string,
  data: string,
): Promise<Uint8Array> {
  const keyBytes =
    typeof key === "string"
      ? enc.encode(key)
      : key instanceof Uint8Array
        ? key
        : new Uint8Array(key);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(data));
  return new Uint8Array(sig);
}

/** AWS-style URI encoding (RFC 3986). */
export function rfc3986(s: string): string {
  return encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

/** Canonical URI: encode each path segment, keep slashes. */
export function canonicalUri(pathname: string): string {
  return pathname
    .split("/")
    .map((seg) => rfc3986(decodeURIComponent(seg)))
    .join("/");
}

/** Parse `YYYYMMDDTHHMMSSZ` to epoch ms. Returns NaN on bad input. */
export function parseAmzDate(amzDate: string): number {
  if (!/^\d{8}T\d{6}Z$/.test(amzDate)) return NaN;
  const y = +amzDate.slice(0, 4);
  const mo = +amzDate.slice(4, 6) - 1;
  const d = +amzDate.slice(6, 8);
  const h = +amzDate.slice(9, 11);
  const mi = +amzDate.slice(11, 13);
  const s = +amzDate.slice(13, 15);
  return Date.UTC(y, mo, d, h, mi, s);
}

/**
 * Verify a SigV4-presigned request. Unsigned requests pass with
 * `presigned: false`. Returns failure on missing/expired/tampered
 * signatures.
 */
export async function verifyPresigned(
  request: Request,
  url: URL,
  creds: SigningCreds,
): Promise<VerifyResult> {
  const algorithm = url.searchParams.get("X-Amz-Algorithm");
  if (!algorithm) return { ok: true, presigned: false };

  if (algorithm !== "AWS4-HMAC-SHA256") {
    return {
      ok: false,
      code: "InvalidRequest",
      message: "Unsupported signing algorithm.",
    };
  }

  const credential = url.searchParams.get("X-Amz-Credential");
  const amzDate = url.searchParams.get("X-Amz-Date");
  const expires = url.searchParams.get("X-Amz-Expires");
  const signedHeaders = url.searchParams.get("X-Amz-SignedHeaders");
  const signature = url.searchParams.get("X-Amz-Signature");

  if (!credential || !amzDate || !expires || !signedHeaders || !signature) {
    return {
      ok: false,
      code: "AuthorizationQueryParametersError",
      message: "Missing required query parameters.",
    };
  }

  const reqTime = parseAmzDate(amzDate);
  if (!Number.isFinite(reqTime)) {
    return {
      ok: false,
      code: "AuthorizationQueryParametersError",
      message: "Bad X-Amz-Date.",
    };
  }
  const expirySec = parseInt(expires, 10);
  if (!Number.isFinite(expirySec) || expirySec < 1) {
    return {
      ok: false,
      code: "AuthorizationQueryParametersError",
      message: "Bad X-Amz-Expires.",
    };
  }
  if (Date.now() > reqTime + expirySec * 1000) {
    return { ok: false, code: "AccessDenied", message: "Request has expired." };
  }

  const credParts = credential.split("/");
  if (credParts.length !== 5 || credParts[4] !== "aws4_request") {
    return {
      ok: false,
      code: "AuthorizationQueryParametersError",
      message: "Bad credential scope.",
    };
  }
  const [ak, scopeDate, region, service] = credParts;
  if (ak !== creds.S3_ACCESS_KEY_ID) {
    return {
      ok: false,
      code: "InvalidAccessKeyId",
      message: "Unknown access key.",
    };
  }
  if (!creds.S3_SECRET_ACCESS_KEY) {
    return {
      ok: false,
      code: "InternalError",
      message: "Server signing key not configured.",
    };
  }

  const params: [string, string][] = [];
  for (const [k, v] of url.searchParams) {
    if (k === "X-Amz-Signature") continue;
    params.push([k, v]);
  }
  params.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const canonicalQs = params
    .map(([k, v]) => `${rfc3986(k)}=${rfc3986(v)}`)
    .join("&");

  const headerNames = signedHeaders.split(";");
  const canonicalHeaders = headerNames
    .map((h) => {
      const name = h.toLowerCase();
      const val =
        name === "host"
          ? url.host
          : (request.headers.get(name) ?? "").trim().replace(/\s+/g, " ");
      return `${name}:${val}\n`;
    })
    .join("");

  const canonicalRequest = [
    request.method,
    canonicalUri(url.pathname),
    canonicalQs,
    canonicalHeaders,
    signedHeaders,
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const hashedCR = await sha256Hex(canonicalRequest);
  const credentialScope = `${scopeDate}/${region}/${service}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${hashedCR}`;

  const kDate = await hmac(`AWS4${creds.S3_SECRET_ACCESS_KEY}`, scopeDate);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  const kSigning = await hmac(kService, "aws4_request");
  const computed = bytesToHex(await hmac(kSigning, stringToSign));

  if (computed !== signature.toLowerCase()) {
    return {
      ok: false,
      code: "SignatureDoesNotMatch",
      message: "Signature mismatch.",
    };
  }

  return { ok: true, presigned: true };
}

/** Header-form SigV4 access-key match (PUT/DELETE auth gate). */
export function checkSigV4Header(
  request: Request,
  creds: SigningCreds,
): boolean {
  const authz = request.headers.get("Authorization") ?? "";
  const match = authz.match(/^AWS4-HMAC-SHA256\s+Credential=([^/,]+)\//);
  return (
    !!match && !!creds.S3_ACCESS_KEY_ID && match[1] === creds.S3_ACCESS_KEY_ID
  );
}
