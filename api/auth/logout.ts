import type { VercelRequest, VercelResponse } from "@vercel/node";
import { UserAuthManager, SESSION_COOKIE } from "../../src/utils/user-auth.js";
import { authenticateRequest, isCsrfSafe } from "../../src/utils/session-request.js";
import { appendCookies, clearCookie, isSecureRequest, sendJson } from "../../src/utils/http.js";

/**
 * End the browser session. The user's Meta tokens are deliberately left in
 * place so their configured MCP clients keep working - use /api/auth/revoke to
 * disconnect Meta entirely.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return sendJson(res, 405, { success: false, error: "Method not allowed" });
  }

  try {
    const { session, via } = await authenticateRequest(req);

    if (!session) {
      return sendJson(res, 401, { success: false, error: "No active session found." });
    }

    if (!isCsrfSafe(req, via)) {
      return sendJson(res, 403, { success: false, error: "Request origin not allowed." });
    }

    await UserAuthManager.deleteUserSession(session.userId);
    appendCookies(res, [clearCookie(SESSION_COOKIE, isSecureRequest(req))]);

    return sendJson(res, 200, {
      success: true,
      message: "Signed out. Your Meta connection is unchanged.",
    });
  } catch (error) {
    console.error("Logout error:", {
      reason: error instanceof Error ? error.message : "unknown",
    });
    return sendJson(res, 500, { success: false, error: "Could not sign you out." });
  }
}
