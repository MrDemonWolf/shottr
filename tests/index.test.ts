import { describe, it, expect } from "vitest";
import { resolveKey, verifyUploadToken } from "../src/index";

const BASE = "https://img.mrdemonwolf.com";

describe("resolveKey", () => {
  it("resolves a plain key", () => {
    expect(resolveKey(new URL(`${BASE}/image.png`))).toBe("image.png");
  });

  it("strips the bucket prefix", () => {
    expect(resolveKey(new URL(`${BASE}/shottr/image.png`))).toBe("image.png");
  });

  it("decodes percent-escapes", () => {
    expect(resolveKey(new URL(`${BASE}/SCR%20001.png`))).toBe("SCR 001.png");
  });

  it("returns empty string for the root", () => {
    expect(resolveKey(new URL(`${BASE}/`))).toBe("");
  });

  it("returns null for malformed percent-escapes", () => {
    expect(resolveKey(new URL(`${BASE}/%zz`))).toBeNull();
    expect(resolveKey(new URL(`${BASE}/%E0%A4%A`))).toBeNull();
  });
});

describe("verifyUploadToken", () => {
  const TOKEN = "a-long-random-upload-token-1234567890";

  it("accepts the matching token", async () => {
    expect(await verifyUploadToken(TOKEN, TOKEN)).toBe(true);
  });

  it("rejects a wrong token", async () => {
    expect(await verifyUploadToken("nope", TOKEN)).toBe(false);
  });

  it("rejects when no token is configured", async () => {
    expect(await verifyUploadToken(TOKEN, undefined)).toBe(false);
    expect(await verifyUploadToken(TOKEN, "")).toBe(false);
  });

  it("rejects an empty presented token", async () => {
    expect(await verifyUploadToken("", TOKEN)).toBe(false);
  });
});
