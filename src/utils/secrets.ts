import crypto from "crypto";

const MIN_SECRET_LENGTH = 32;
const WEAK_SECRETS = new Set([
  "your-secret-key-change-in-production",
  "your_super_secret_jwt_key_change_this_in_production",
  "secret",
  "changeme",
]);

let cachedJwtSecret: Uint8Array | null = null;
let cachedEncryptionKey: Buffer | null = null;

/**
 * The JWT signing secret. Fails closed: a missing, short or well-known secret
 * is a configuration error, never a silently applied default.
 */
export function getJwtSecret(): Uint8Array {
  if (cachedJwtSecret) return cachedJwtSecret;

  const secret = process.env.JWT_SECRET;

  if (!secret) {
    throw new Error(
      "JWT_SECRET is not set. Generate one with `openssl rand -base64 48` and set it before starting the server."
    );
  }

  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `JWT_SECRET must be at least ${MIN_SECRET_LENGTH} characters (got ${secret.length}).`
    );
  }

  if (WEAK_SECRETS.has(secret)) {
    throw new Error(
      "JWT_SECRET is set to a well-known placeholder value. Generate a real secret with `openssl rand -base64 48`."
    );
  }

  cachedJwtSecret = new TextEncoder().encode(secret);
  return cachedJwtSecret;
}

/**
 * 32-byte key used to encrypt Meta tokens at rest.
 *
 * Uses TOKEN_ENCRYPTION_KEY when set (32 bytes, hex or base64). Otherwise it is
 * derived from JWT_SECRET via HKDF, so existing deployments gain encryption
 * without a new required variable — rotating JWT_SECRET then also rotates it.
 */
export function getEncryptionKey(): Buffer {
  if (cachedEncryptionKey) return cachedEncryptionKey;

  const configured = process.env.TOKEN_ENCRYPTION_KEY;

  if (configured) {
    const decoded = /^[0-9a-fA-F]{64}$/.test(configured)
      ? Buffer.from(configured, "hex")
      : Buffer.from(configured, "base64");

    if (decoded.length !== 32) {
      throw new Error(
        "TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes (hex or base64)."
      );
    }

    cachedEncryptionKey = decoded;
    return cachedEncryptionKey;
  }

  cachedEncryptionKey = Buffer.from(
    crypto.hkdfSync("sha256", Buffer.from(getJwtSecret()), Buffer.alloc(0), "meta-mcp:token-encryption:v1", 32)
  );
  return cachedEncryptionKey;
}

/** Test seam — clears memoised values after the environment changes. */
export function resetSecretCache(): void {
  cachedJwtSecret = null;
  cachedEncryptionKey = null;
}
