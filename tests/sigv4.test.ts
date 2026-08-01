import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import aws4 from "aws4";
import {
  verifyPresigned,
  verifyAuthHeader,
  timingSafeEqual,
  parseAmzDate,
  rfc3986,
  canonicalUri,
  type SigningCreds,
} from "../src/sigv4";

const HOST = "img.mrdemonwolf.com";
const PATH = "/shottr/SCR-20260501-tgpp.png";
const CREDS: SigningCreds = {
  S3_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
  S3_SECRET_ACCESS_KEY:
    "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY1234abcd5678ef901234abcd",
};

/** Sign a URL with aws4 and return the resulting Request + URL. */
function signUrl(opts?: {
  expires?: number;
  path?: string;
  region?: string;
  service?: string;
}): { request: Request; url: URL } {
  const expires = opts?.expires ?? 3600;
  const region = opts?.region ?? "auto";
  const service = opts?.service ?? "s3";
  const basePath = opts?.path ?? PATH;
  const pathWithExpires = `${basePath}?X-Amz-Expires=${expires}`;
  const signed = aws4.sign(
    {
      service,
      region,
      host: HOST,
      method: "GET",
      path: pathWithExpires,
      signQuery: true,
    },
    {
      accessKeyId: CREDS.S3_ACCESS_KEY_ID,
      secretAccessKey: CREDS.S3_SECRET_ACCESS_KEY,
    },
  );
  const fullUrl = `https://${HOST}${signed.path}`;
  const url = new URL(fullUrl);
  const request = new Request(fullUrl, { method: "GET" });
  return { request, url };
}

describe("verifyPresigned", () => {
  beforeEach(() => {
    // Pin clock to a stable point so signature dates are predictable.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("accepts a freshly signed URL", async () => {
    const { request, url } = signUrl();
    const result = await verifyPresigned(request, url, CREDS);
    expect(result).toEqual({ ok: true, presigned: true });
  });

  it("rejects an expired URL", async () => {
    const { request, url } = signUrl({ expires: 60 });
    // Jump 2 hours past signing time.
    vi.setSystemTime(new Date("2026-05-01T14:00:00Z"));
    const result = await verifyPresigned(request, url, CREDS);
    expect(result).toEqual({
      ok: false,
      code: "AccessDenied",
      message: "Request has expired.",
    });
  });

  it("rejects a tampered X-Amz-Date", async () => {
    const { url } = signUrl();
    // Shift forward 60s — still inside the 3600s expiry window so the expiry
    // gate doesn't fire first; signature should now mismatch.
    url.searchParams.set("X-Amz-Date", "20260501T120100Z");
    const request = new Request(url.toString(), { method: "GET" });
    const result = await verifyPresigned(request, url, CREDS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("SignatureDoesNotMatch");
    }
  });

  it("rejects a tampered path", async () => {
    const { url } = signUrl();
    // Build a new URL with a different pathname but the same query.
    const tampered = new URL(url.toString());
    tampered.pathname = "/shottr/different.png";
    const request = new Request(tampered.toString(), { method: "GET" });
    const result = await verifyPresigned(request, tampered, CREDS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("SignatureDoesNotMatch");
    }
  });

  it("rejects a wrong access key in the credential scope", async () => {
    const { request, url } = signUrl();
    const result = await verifyPresigned(request, url, {
      ...CREDS,
      S3_ACCESS_KEY_ID: "AKIA_WRONG_KEY",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("InvalidAccessKeyId");
    }
  });

  it("rejects when X-Amz-Signature is missing", async () => {
    const { url } = signUrl();
    url.searchParams.delete("X-Amz-Signature");
    const request = new Request(url.toString(), { method: "GET" });
    const result = await verifyPresigned(request, url, CREDS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("AuthorizationQueryParametersError");
    }
  });

  it("rejects when X-Amz-Date is missing", async () => {
    const { url } = signUrl();
    url.searchParams.delete("X-Amz-Date");
    const request = new Request(url.toString(), { method: "GET" });
    const result = await verifyPresigned(request, url, CREDS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("AuthorizationQueryParametersError");
    }
  });

  it("rejects when X-Amz-Expires is malformed", async () => {
    const { url } = signUrl();
    url.searchParams.set("X-Amz-Expires", "abc");
    const request = new Request(url.toString(), { method: "GET" });
    const result = await verifyPresigned(request, url, CREDS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("AuthorizationQueryParametersError");
    }
  });

  it("rejects an unsupported algorithm", async () => {
    const { url } = signUrl();
    url.searchParams.set("X-Amz-Algorithm", "AWS4-HMAC-SHA512");
    const request = new Request(url.toString(), { method: "GET" });
    const result = await verifyPresigned(request, url, CREDS);
    expect(result).toEqual({
      ok: false,
      code: "InvalidRequest",
      message: "Unsupported signing algorithm.",
    });
  });

  it("passes through unsigned URLs (no X-Amz-Algorithm)", async () => {
    const url = new URL(`https://${HOST}${PATH}`);
    const request = new Request(url.toString(), { method: "GET" });
    const result = await verifyPresigned(request, url, CREDS);
    expect(result).toEqual({ ok: true, presigned: false });
  });

  it("rejects when secret is not configured server-side", async () => {
    const { request, url } = signUrl();
    const result = await verifyPresigned(request, url, {
      ...CREDS,
      S3_SECRET_ACCESS_KEY: "",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("InternalError");
    }
  });

  it("rejects a malformed credential scope", async () => {
    const { url } = signUrl();
    url.searchParams.set("X-Amz-Credential", "AKIA/2026/auto/aws4_request"); // 4 parts not 5
    const request = new Request(url.toString(), { method: "GET" });
    const result = await verifyPresigned(request, url, CREDS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("AuthorizationQueryParametersError");
    }
  });
});

/** Sign a header-auth request with aws4 and return the Request + URL. */
function signHeaderRequest(opts?: {
  method?: string;
  path?: string;
  contentSha?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  mutateHeaders?: (headers: Headers) => void;
  requestPath?: string;
}): { request: Request; url: URL } {
  const method = opts?.method ?? "PUT";
  const path = opts?.path ?? PATH;
  const signed = aws4.sign(
    {
      service: "s3",
      region: "auto",
      host: HOST,
      method,
      path,
      headers: {
        "Content-Type": "image/png",
        "X-Amz-Content-Sha256": opts?.contentSha ?? "UNSIGNED-PAYLOAD",
      },
    },
    {
      accessKeyId: opts?.accessKeyId ?? CREDS.S3_ACCESS_KEY_ID,
      secretAccessKey: opts?.secretAccessKey ?? CREDS.S3_SECRET_ACCESS_KEY,
    },
  );
  const headers = new Headers();
  for (const [k, v] of Object.entries(
    signed.headers as Record<string, string>,
  )) {
    if (k.toLowerCase() === "host") continue; // fetch derives Host from the URL
    headers.set(k, v);
  }
  opts?.mutateHeaders?.(headers);
  const fullUrl = `https://${HOST}${opts?.requestPath ?? path}`;
  const url = new URL(fullUrl);
  const request = new Request(fullUrl, { method, headers });
  return { request, url };
}

describe("verifyAuthHeader", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("accepts a signed PUT with UNSIGNED-PAYLOAD", async () => {
    const { request, url } = signHeaderRequest();
    const result = await verifyAuthHeader(request, url, CREDS);
    expect(result).toEqual({ ok: true, presigned: false });
  });

  it("accepts a signed PUT with a declared payload hash", async () => {
    // The declared hash is used verbatim in the canonical request — the body
    // itself is not verified (streaming uploads are never buffered).
    const { request, url } = signHeaderRequest({
      contentSha:
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    });
    const result = await verifyAuthHeader(request, url, CREDS);
    expect(result).toEqual({ ok: true, presigned: false });
  });

  it("accepts a signed DELETE", async () => {
    const { request, url } = signHeaderRequest({ method: "DELETE" });
    const result = await verifyAuthHeader(request, url, CREDS);
    expect(result).toEqual({ ok: true, presigned: false });
  });

  it("verifies repeat requests via the memoized signing key", async () => {
    const first = signHeaderRequest();
    const second = signHeaderRequest({ method: "DELETE" });
    expect((await verifyAuthHeader(first.request, first.url, CREDS)).ok).toBe(
      true,
    );
    expect((await verifyAuthHeader(second.request, second.url, CREDS)).ok).toBe(
      true,
    );
  });

  it("rejects a missing Authorization header", async () => {
    const url = new URL(`https://${HOST}${PATH}`);
    const request = new Request(url.toString(), { method: "PUT" });
    const result = await verifyAuthHeader(request, url, CREDS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("AccessDenied");
  });

  it("rejects a Bearer header", async () => {
    const url = new URL(`https://${HOST}${PATH}`);
    const request = new Request(url.toString(), {
      method: "PUT",
      headers: { Authorization: "Bearer some-token" },
    });
    const result = await verifyAuthHeader(request, url, CREDS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("AuthorizationHeaderMalformed");
  });

  it("rejects a wrong access key", async () => {
    const { request, url } = signHeaderRequest();
    const result = await verifyAuthHeader(request, url, {
      ...CREDS,
      S3_ACCESS_KEY_ID: "AKIA_WRONG_KEY",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("InvalidAccessKeyId");
  });

  it("rejects a signature made with the wrong secret", async () => {
    const { request, url } = signHeaderRequest({
      secretAccessKey: "not-the-real-secret-not-the-real-secret1234",
    });
    const result = await verifyAuthHeader(request, url, CREDS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SignatureDoesNotMatch");
  });

  it("rejects a tampered path", async () => {
    const { request, url } = signHeaderRequest({
      requestPath: "/shottr/other.png",
    });
    const result = await verifyAuthHeader(request, url, CREDS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SignatureDoesNotMatch");
  });

  it("rejects a tampered signed header", async () => {
    const { request, url } = signHeaderRequest({
      mutateHeaders: (h) => h.set("Content-Type", "text/html"),
    });
    const result = await verifyAuthHeader(request, url, CREDS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SignatureDoesNotMatch");
  });

  it("rejects a tampered query string", async () => {
    const { request } = signHeaderRequest();
    const url = new URL(`https://${HOST}${PATH}?attacker=1`);
    const result = await verifyAuthHeader(request, url, CREDS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SignatureDoesNotMatch");
  });

  it("rejects a tampered declared payload hash", async () => {
    const { request, url } = signHeaderRequest({
      mutateHeaders: (h) =>
        h.set(
          "X-Amz-Content-Sha256",
          "0000000000000000000000000000000000000000000000000000000000000000",
        ),
    });
    const result = await verifyAuthHeader(request, url, CREDS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SignatureDoesNotMatch");
  });

  it("rejects a request outside the clock-skew window", async () => {
    const { request, url } = signHeaderRequest();
    vi.setSystemTime(new Date("2026-05-01T12:16:01Z"));
    const result = await verifyAuthHeader(request, url, CREDS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("RequestTimeTooSkewed");
  });

  it("rejects a missing x-amz-date header", async () => {
    const { request: signedReq, url } = signHeaderRequest();
    const headers = new Headers(signedReq.headers);
    headers.delete("X-Amz-Date");
    const request = new Request(url.toString(), { method: "PUT", headers });
    const result = await verifyAuthHeader(request, url, CREDS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("InvalidRequest");
  });

  it("rejects a missing x-amz-content-sha256 header", async () => {
    const { request: signedReq, url } = signHeaderRequest();
    const headers = new Headers(signedReq.headers);
    headers.delete("X-Amz-Content-Sha256");
    const request = new Request(url.toString(), { method: "PUT", headers });
    const result = await verifyAuthHeader(request, url, CREDS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("InvalidRequest");
  });

  it("rejects when secret is not configured server-side", async () => {
    const { request, url } = signHeaderRequest();
    const result = await verifyAuthHeader(request, url, {
      ...CREDS,
      S3_SECRET_ACCESS_KEY: "",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("InternalError");
  });
});

describe("timingSafeEqual", () => {
  it("returns true for equal strings", () => {
    expect(timingSafeEqual("deadbeef", "deadbeef")).toBe(true);
  });

  it("returns false for different strings of equal length", () => {
    expect(timingSafeEqual("deadbeef", "deadbeee")).toBe(false);
  });

  it("returns false on length mismatch", () => {
    expect(timingSafeEqual("deadbeef", "deadbee")).toBe(false);
  });
});

describe("parseAmzDate", () => {
  it("parses a valid AWS basic format date", () => {
    expect(parseAmzDate("20260502T012957Z")).toBe(
      Date.UTC(2026, 4, 2, 1, 29, 57),
    );
  });

  it("returns NaN for malformed input", () => {
    expect(parseAmzDate("2026-05-02T01:29:57Z")).toBeNaN();
    expect(parseAmzDate("nope")).toBeNaN();
    expect(parseAmzDate("")).toBeNaN();
  });
});

describe("rfc3986", () => {
  it("encodes reserved characters per AWS rules", () => {
    expect(rfc3986("hello world")).toBe("hello%20world");
    expect(rfc3986("a!b'c(d)e*f")).toBe("a%21b%27c%28d%29e%2Af");
    expect(rfc3986("a/b")).toBe("a%2Fb");
  });
});

describe("canonicalUri", () => {
  it("preserves slashes and encodes segments", () => {
    expect(canonicalUri("/shottr/SCR 001.png")).toBe(
      "/shottr/SCR%20001.png",
    );
  });

  it("handles empty path", () => {
    expect(canonicalUri("/")).toBe("/");
  });
});
