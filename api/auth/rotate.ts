import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  UserAuthManager,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
} from "../../src/utils/user-auth.js";
import { authenticateRequest, isCsrfSafe } from "../../src/utils/session-request.js";
import { appendCookies, buildCookie, isSecureRequest, sendJson } from "../../src/utils/http.js";

/**
 * Issue a fresh session token. Used when a token has been pasted somewhere it
 * should not have been, or is simply close to expiring.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return sendJson(res, 405, { success: false, error: "Method not allowed" });
  }

  try {
    const { session, via } = await authenticateRequest(req);

    if (!session) {
      return sendJson(res, 401, { success: false, error: "Sign in to rotate your token." });
    }

    if (!isCsrfSafe(req, via)) {
      return sendJson(res, 403, { success: false, error: "Request origin not allowed." });
    }

    const sessionToken = await UserAuthManager.rotateSessionToken(session.userId);

    if (!sessionToken) {
      return sendJson(res, 401, { success: false, error: "Session no longer exists." });
    }

    appendCookies(res, [
      buildCookie(SESSION_COOKIE, sessionToken, {
        maxAge: SESSION_MAX_AGE_SECONDS,
        secure: isSecureRequest(req),
      }),
    ]);

    return sendJson(res, 200, {
      success: true,
      sessionToken,
      expiresInSeconds: SESSION_MAX_AGE_SECONDS,
      message:
        "New token issued and the previous one revoked. Update your MCP client configuration to use it.",
    });
  } catch (error) {
    console.error("Token rotation error:", {
      reason: error instanceof Error ? error.message : "unknown",
    });
    return sendJson(res, 500, { success: false, error: "Could not rotate the token." });
  }
}
