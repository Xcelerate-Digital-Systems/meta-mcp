import crypto from "crypto";
import { SignJWT, jwtVerify } from "jose";
import { getJwtSecret } from "./secrets.js";
import { safeEqual } from "./crypto.js";
import { checkRequestLimit, resetRequestLimit } from "./request-limit.js";

const GATE_AUDIENCE = "meta-mcp:access-gate";
const GATE_TTL_SECONDS = 12 * 60 * 60;
const MAX_ATTEMPTS = 5;
const ATTEMPT_WINDOW_SECONDS = 15 * 60;

export const ACCESS_GATE_COOKIE = "access_gate";
export const ACCESS_GATE_MAX_AGE = GATE_TTL_SECONDS;

export interface PinCheckResult {
  ok: boolean;
  reason?: "not_configured" | "invalid" | "locked_out";
  retryAfterSeconds?: number;
}

/**
 * Whether a shared access PIN is configured.
 *
 * Set ACCESS_PIN (the PIN itself) or ACCESS_PIN_HASH (its SHA-256 hex digest,
 * so the PIN need not sit in the environment). With neither set the gate is
 * open, which is the intended behaviour for local development only.
 */
export function isPinConfigured(): boolean {
  return Boolean(process.env.ACCESS_PIN || process.env.ACCESS_PIN_HASH);
}

function pinMatches(candidate: string): boolean {
  const hash = process.env.ACCESS_PIN_HASH;
  if (hash) {
    const digest = crypto.createHash("sha256").update(candidate).digest("hex");
    return safeEqual(digest.toLowerCase(), hash.trim().toLowerCase());
  }

  const pin = process.env.ACCESS_PIN;
  return Boolean(pin) && safeEqual(candidate, pin as string);
}

/**
 * Verify a submitted PIN, rate limited per client so the short secret cannot be
 * brute forced: 5 attempts per 15 minutes, and a correct PIN clears the counter.
 */
export async function verifyPin(candidate: string, identifier: string): Promise<PinCheckResult> {
  if (!isPinConfigured()) {
    return { ok: false, reason: "not_configured" };
  }

  const limit = await checkRequestLimit("pin", identifier, MAX_ATTEMPTS, ATTEMPT_WINDOW_SECONDS);
  if (!limit.allowed) {
    return {
      ok: false,
      reason: "locked_out",
      retryAfterSeconds: limit.retryAfterSeconds,
    };
  }

  if (!candidate || !pinMatches(candidate)) {
    return { ok: false, reason: "invalid" };
  }

  await resetRequestLimit("pin", identifier);
  return { ok: true };
}

/** Short-lived proof that this browser passed the PIN gate. */
export async function createGateToken(): Promise<string> {
  return new SignJWT({ gate: true })
    .setProtectedHeader({ alg: "HS256" })
    .setAudience(GATE_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${GATE_TTL_SECONDS}s`)
    .sign(getJwtSecret());
}

export async function verifyGateToken(token: string | null): Promise<boolean> {
  if (!token) return false;

  try {
    await jwtVerify(token, getJwtSecret(), { audience: GATE_AUDIENCE });
    return true;
  } catch {
    return false;
  }
}

/**
 * True when the caller may proceed past the gate — either because no PIN is
 * configured, or because they hold a valid gate token.
 */
export async function hasGateAccess(token: string | null): Promise<boolean> {
  if (!isPinConfigured()) return true;
  return verifyGateToken(token);
}
