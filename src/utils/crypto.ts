import crypto from "crypto";
import { getEncryptionKey } from "./secrets.js";

const ENVELOPE_PREFIX = "enc.v1";

/**
 * Encrypt a string with AES-256-GCM.
 *
 * Output format: `enc.v1:<iv>:<authTag>:<ciphertext>`, all base64url. The prefix
 * lets `decryptSecret` recognise — and transparently pass through — records
 * written before encryption existed.
 */
export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    ENVELOPE_PREFIX,
    iv.toString("base64url"),
    authTag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(":");
}

/**
 * Decrypt a value produced by `encryptSecret`.
 *
 * Values that are not in the envelope format are returned unchanged: stored
 * tokens predate encryption and are re-encrypted the next time they are written.
 */
export function decryptSecret(value: string): string {
  if (!isEncrypted(value)) {
    return value;
  }

  const [, ivPart, tagPart, dataPart] = value.split(":");
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    getEncryptionKey(),
    Buffer.from(ivPart, "base64url")
  );
  decipher.setAuthTag(Buffer.from(tagPart, "base64url"));

  return Buffer.concat([
    decipher.update(Buffer.from(dataPart, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(`${ENVELOPE_PREFIX}:`) && value.split(":").length === 4;
}

/** Constant-time string comparison that does not leak length through timing. */
export function safeEqual(a: string, b: string): boolean {
  const digestA = crypto.createHash("sha256").update(a).digest();
  const digestB = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(digestA, digestB);
}

/** Meta's appsecret_proof: HMAC-SHA256 of the access token, keyed by the app secret. */
export function appSecretProof(accessToken: string, appSecret: string): string {
  return crypto.createHmac("sha256", appSecret).update(accessToken).digest("hex");
}
