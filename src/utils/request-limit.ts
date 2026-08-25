import { getStorage } from "./storage.js";

export interface LimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * Fixed-window rate limit backed by shared storage, so the count survives the
 * serverless invocation that created it.
 *
 * Storage failures fail open — an unreachable Redis should not take login down —
 * but they are logged so the gap is visible.
 */
export async function checkRequestLimit(
  bucket: string,
  identifier: string,
  max: number,
  windowSeconds: number
): Promise<LimitResult> {
  const key = `ratelimit:${bucket}:${identifier}`;

  try {
    const count = await getStorage().incrementWithTtl(key, windowSeconds);

    return {
      allowed: count <= max,
      remaining: Math.max(0, max - count),
      retryAfterSeconds: windowSeconds,
    };
  } catch (error) {
    console.error("Rate limit check failed, allowing request:", {
      bucket,
      reason: error instanceof Error ? error.message : "unknown",
    });
    return { allowed: true, remaining: max, retryAfterSeconds: 0 };
  }
}

export async function resetRequestLimit(bucket: string, identifier: string): Promise<void> {
  try {
    await getStorage().del(`ratelimit:${bucket}:${identifier}`);
  } catch {
    // Non-fatal: the window expires on its own.
  }
}
