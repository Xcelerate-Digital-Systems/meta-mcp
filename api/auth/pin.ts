import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  ACCESS_GATE_COOKIE,
  ACCESS_GATE_MAX_AGE,
  createGateToken,
  isPinConfigured,
  verifyPin,
} from "../../src/utils/access-pin.js";
import {
  appendCookies,
  buildCookie,
  clientIp,
  isSecureRequest,
  sendJson,
} from "../../src/utils/http.js";

/**
 * Exchange the shared access PIN for a short-lived gate cookie.
 * Everything else on the site checks that cookie before doing any work.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return sendJson(res, 405, { success: false, error: "Method not allowed" });
  }

  if (!isPinConfigured()) {
    return sendJson(res, 400, {
      success: false,
      error: "No access PIN is configured for this server.",
    });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const pin = typeof body.pin === "string" ? body.pin.trim() : "";

    const result = await verifyPin(pin, clientIp(req));

    if (!result.ok) {
      if (result.reason === "locked_out") {
        res.setHeader("Retry-After", String(result.retryAfterSeconds ?? 900));
        return sendJson(res, 429, {
          success: false,
          error: "Too many attempts. Try again in 15 minutes.",
        });
      }

      return sendJson(res, 401, { success: false, error: "That PIN is not correct." });
    }

    appendCookies(res, [
      buildCookie(ACCESS_GATE_COOKIE, await createGateToken(), {
        maxAge: ACCESS_GATE_MAX_AGE,
        secure: isSecureRequest(req),
      }),
    ]);

    return sendJson(res, 200, { success: true });
  } catch (error) {
    console.error("PIN verification error:", {
      reason: error instanceof Error ? error.message : "unknown",
    });
    return sendJson(res, 500, { success: false, error: "Could not verify the PIN." });
  }
}
