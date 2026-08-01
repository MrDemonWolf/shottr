/**
 * AWS Signature V4 verification — presigned URLs (query string) and
 * Authorization-header requests.
 *
 * Pure functions — only depend on Web Crypto, URL, and TextEncoder.
 * Runs in Cloudflare Workers and Node 20+ (vitest).
 *
 * Spec: https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-authenticating-requests.html
 */

const enc = new TextEncoder();

/** Maximum tolerated clock skew for header-signed requests. */
const MAX_SKEW_MS = 15 * 60 * 1000;

const AUTH_HEADER_RE =
  /^AWS4-HMAC-SHA256\s+Credential=([^,\s]+),\s*SignedHeaders=([^,\s]+),\s*Signature=([0-9a-f]{64})$/i;

export interface SigningCreds {
  S3_ACCESS_KEY_ID: string;
  S3_SECRET_ACCESS_KEY: string;
}

export type VerifyResult =
  | { ok: true; presigned: boolean }
  | { ok: false; code: string; message: string };

function fail(code: string, message: string): VerifyResult {
  return { ok: false, code, message };
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Constant-time string comparison. Length mismatch returns early — the
 * lengths of hex signatures are public, only their contents are secret.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return bytesToHex(new Uint8Array(buf));
}

function importHmacKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    raw,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

async function hmac(
  key: Uint8Array | string,
  data: string,
): Promise<Uint8Array> {
  const keyBytes = typeof key === "string" ? enc.encode(key) : key;
  const cryptoKey = await importHmacKey(keyBytes);
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(data));
  return new Uint8Array(sig);
}

/**
 * Signing-key cache. The derived key is stable per (secret, date, region,
 * service) — one entry suffices since all four are fixed per deployment and
 * the date rolls daily. A warm request does 1 HMAC instead of 9 crypto ops.
 */
let signingKeyCache: { scope: string; key: CryptoKey } | null = null;

async function getSigningKey(
  secret: string,
  scopeDate: string,
  region: string,
  service: string,
): Promise<CryptoKey> {
  const scope = `${secret}\0${scopeDate}/${region}/${service}`;
  if (signingKeyCache?.scope === scope) return signingKeyCache.key;
  const kDate = await hmac(`AWS4${secret}`, scopeDate);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  const kSigning = await hmac(kService, "aws4_request");
  const key = await importHmacKey(kSigning);
  signingKeyCache = { scope, key };
  return key;
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

/** Canonical query string: sorted, RFC 3986-encoded pairs. */
function canonicalQueryString(url: URL, omit?: string): string {
  const params: [string, string][] = [];
  for (const [k, v] of url.searchParams) {
    if (k === omit) continue;
    params.push([k, v]);
  }
  params.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return params.map(([k, v]) => `${rfc3986(k)}=${rfc3986(v)}`).join("&");
}

/** Canonical headers block for the given signed-header names. */
function buildCanonicalHeaders(
  names: string[],
  url: URL,
  headers: Headers,
): string {
  return names
    .map((h) => {
      const name = h.toLowerCase();
      const val =
        name === "host"
          ? url.host
          : (headers.get(name) ?? "").trim().replace(/\s+/g, " ");
      return `${name}:${val}\n`;
    })
    .join("");
}

async function computeSignature(
  secret: string,
  scopeDate: string,
  region: string,
  service: string,
  amzDate: string,
  canonicalRequest: string,
): Promise<string> {
  const hashedCR = await sha256Hex(canonicalRequest);
  const credentialScope = `${scopeDate}/${region}/${service}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${hashedCR}`;
  const key = await getSigningKey(secret, scopeDate, region, service);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(stringToSign));
  return bytesToHex(new Uint8Array(sig));
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
    return fail("InvalidRequest", "Unsupported signing algorithm.");
  }

  const credential = url.searchParams.get("X-Amz-Credential");
  const amzDate = url.searchParams.get("X-Amz-Date");
  const expires = url.searchParams.get("X-Amz-Expires");
  const signedHeaders = url.searchParams.get("X-Amz-SignedHeaders");
  const signature = url.searchParams.get("X-Amz-Signature");

  if (!credential || !amzDate || !expires || !signedHeaders || !signature) {
    return fail(
      "AuthorizationQueryParametersError",
      "Missing required query parameters.",
    );
  }

  const reqTime = parseAmzDate(amzDate);
  if (!Number.isFinite(reqTime)) {
    return fail("AuthorizationQueryParametersError", "Bad X-Amz-Date.");
  }
  const expirySec = parseInt(expires, 10);
  if (!Number.isFinite(expirySec) || expirySec < 1) {
    return fail("AuthorizationQueryParametersError", "Bad X-Amz-Expires.");
  }
  if (Date.now() > reqTime + expirySec * 1000) {
    return fail("AccessDenied", "Request has expired.");
  }

  const credParts = credential.split("/");
  if (credParts.length !== 5 || credParts[4] !== "aws4_request") {
    return fail("AuthorizationQueryParametersError", "Bad credential scope.");
  }
  const [ak, scopeDate, region, service] = credParts;
  if (ak !== creds.S3_ACCESS_KEY_ID) {
    return fail("InvalidAccessKeyId", "Unknown access key.");
  }
  if (!creds.S3_SECRET_ACCESS_KEY) {
    return fail("InternalError", "Server signing key not configured.");
  }

  const canonicalRequest = [
    request.method,
    canonicalUri(url.pathname),
    canonicalQueryString(url, "X-Amz-Signature"),
    buildCanonicalHeaders(signedHeaders.split(";"), url, request.headers),
    signedHeaders,
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const computed = await computeSignature(
    creds.S3_SECRET_ACCESS_KEY,
    scopeDate,
    region,
    service,
    amzDate,
    canonicalRequest,
  );

  if (!timingSafeEqual(computed, signature.toLowerCase())) {
    return fail("SignatureDoesNotMatch", "Signature mismatch.");
  }

  return { ok: true, presigned: true };
}

/**
 * Verify a header-form SigV4 request (`Authorization: AWS4-HMAC-SHA256 …`),
 * used to gate PUT/DELETE.
 *
 * The payload hash (`x-amz-content-sha256`) is included in the canonical
 * request exactly as declared by the client — the body is never buffered, so
 * streaming uploads stay streaming. The declared value is signature-covered,
 * so it cannot be forged without the secret key.
 */
export async function verifyAuthHeader(
  request: Request,
  url: URL,
  creds: SigningCreds,
): Promise<VerifyResult> {
  const authz = request.headers.get("Authorization");
  if (!authz) {
    return fail("AccessDenied", "Missing Authorization header.");
  }
  const match = authz.match(AUTH_HEADER_RE);
  if (!match) {
    return fail(
      "AuthorizationHeaderMalformed",
      "Authorization header is not a valid AWS4-HMAC-SHA256 credential.",
    );
  }
  const [, credential, signedHeaders, signature] = match;

  const credParts = credential.split("/");
  if (credParts.length !== 5 || credParts[4] !== "aws4_request") {
    return fail("AuthorizationHeaderMalformed", "Bad credential scope.");
  }
  const [ak, scopeDate, region, service] = credParts;
  if (ak !== creds.S3_ACCESS_KEY_ID) {
    return fail("InvalidAccessKeyId", "Unknown access key.");
  }
  if (!creds.S3_SECRET_ACCESS_KEY) {
    return fail("InternalError", "Server signing key not configured.");
  }

  const amzDate = request.headers.get("x-amz-date");
  if (!amzDate) {
    return fail("InvalidRequest", "Missing x-amz-date header.");
  }
  const reqTime = parseAmzDate(amzDate);
  if (!Number.isFinite(reqTime)) {
    return fail("InvalidRequest", "Bad x-amz-date header.");
  }
  if (Math.abs(Date.now() - reqTime) > MAX_SKEW_MS) {
    return fail(
      "RequestTimeTooSkewed",
      "The difference between the request time and the server's time is too large.",
    );
  }
  if (amzDate.slice(0, 8) !== scopeDate) {
    return fail(
      "AuthorizationHeaderMalformed",
      "Credential scope date does not match x-amz-date.",
    );
  }

  const contentSha = request.headers.get("x-amz-content-sha256");
  if (!contentSha) {
    return fail("InvalidRequest", "Missing x-amz-content-sha256 header.");
  }

  const headerNames = signedHeaders.toLowerCase().split(";");
  for (const required of ["host", "x-amz-content-sha256", "x-amz-date"]) {
    if (!headerNames.includes(required)) {
      return fail("InvalidRequest", `Header ${required} must be signed.`);
    }
  }

  const canonicalRequest = [
    request.method,
    canonicalUri(url.pathname),
    canonicalQueryString(url),
    buildCanonicalHeaders(headerNames, url, request.headers),
    headerNames.join(";"),
    contentSha,
  ].join("\n");

  const computed = await computeSignature(
    creds.S3_SECRET_ACCESS_KEY,
    scopeDate,
    region,
    service,
    amzDate,
    canonicalRequest,
  );

  if (!timingSafeEqual(computed, signature.toLowerCase())) {
    return fail("SignatureDoesNotMatch", "Signature mismatch.");
  }

  return { ok: true, presigned: false };
}
