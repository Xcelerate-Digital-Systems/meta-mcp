import { encryptSecret, decryptSecret, isEncrypted, safeEqual } from "../build/src/utils/crypto.js";

describe("token encryption", () => {
  it("round-trips a value", () => {
    const token = "EAAG_meta_access_token_value";
    const encrypted = encryptSecret(token);

    expect(encrypted).not.toContain(token);
    expect(isEncrypted(encrypted)).toBe(true);
    expect(decryptSecret(encrypted)).toBe(token);
  });

  it("produces a different ciphertext each time", () => {
    expect(encryptSecret("same")).not.toBe(encryptSecret("same"));
  });

  it("passes through values stored before encryption existed", () => {
    expect(isEncrypted("plain-legacy-token")).toBe(false);
    expect(decryptSecret("plain-legacy-token")).toBe("plain-legacy-token");
  });

  it("rejects a tampered ciphertext", () => {
    const encrypted = encryptSecret("secret");
    const parts = encrypted.split(":");
    parts[3] = Buffer.from("tampered").toString("base64url");

    expect(() => decryptSecret(parts.join(":"))).toThrow();
  });
});

describe("safeEqual", () => {
  it("matches identical values", () => {
    expect(safeEqual("1234", "1234")).toBe(true);
  });

  it("rejects different values, including different lengths", () => {
    expect(safeEqual("1234", "1235")).toBe(false);
    expect(safeEqual("1234", "12345")).toBe(false);
  });
});
