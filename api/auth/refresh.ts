import type { VercelRequest, VercelResponse } from "@vercel/node";
import { UserAuthManager } from "../../src/utils/user-auth.js";
import { authenticateRequest, isCsrfSafe } from "../../src/utils/session-request.js";
import { sendJson } from "../../src/utils/http.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return sendJson(res, 405, { success: false, error: "Method not allowed" });
  }

  try {
    const { session, via } = await authenticateRequest(req);

    if (!session) {
      return sendJson(res, 401, { success: false, error: "Sign in to refresh your token." });
    }

    if (!isCsrfSafe(req, via)) {
      return sendJson(res, 403, { success: false, error: "Request origin not allowed." });
    }

    const refreshed = await UserAuthManager.refreshUserToken(session.userId);

    if (!refreshed) {
      return sendJson(res, 400, {
        success: false,
        error: "Refresh failed",
        message: "Meta would not extend this token. Reconnect your account to get a new one.",
      });
    }

    const tokenStatus = await UserAuthManager.getTokenStatus(session.userId);

    return sendJson(res, 200, {
      success: true,
      message: "Meta token refreshed.",
      tokenStatus,
    });
  } catch (error) {
    console.error("Token refresh error:", {
      reason: error instanceof Error ? error.message : "unknown",
    });
    return sendJson(res, 500, { success: false, error: "Could not refresh the token." });
  }
}
