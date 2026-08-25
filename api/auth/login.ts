import type { VercelRequest, VercelResponse } from "@vercel/node";
import { UserAuthManager } from "../../src/utils/user-auth.js";
import { ACCESS_GATE_COOKIE, hasGateAccess } from "../../src/utils/access-pin.js";
import {
  appendCookies,
  buildCookie,
  clientIp,
  getCookie,
  isSecureRequest,
  sendJson,
} from "../../src/utils/http.js";
import { checkRequestLimit } from "../../src/utils/request-limit.js";

const OAUTH_STATE_COOKIE = "oauth_state";
const STATE_MAX_AGE = 600;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return sendJson(res, 405, { success: false, error: "Method not allowed" });
  }

  if (!(await hasGateAccess(getCookie(req, ACCESS_GATE_COOKIE)))) {
    return sendJson(res, 403, {
      success: false,
      error: "Access PIN required",
      message: "Enter the access PIN before connecting a Meta account.",
    });
  }

  const limit = await checkRequestLimit("login", clientIp(req), 20, 15 * 60);
  if (!limit.allowed) {
    res.setHeader("Retry-After", String(limit.retryAfterSeconds));
    return sendJson(res, 429, { success: false, error: "Too many login attempts." });
  }

  try {
    const state = await UserAuthManager.generateOAuthState();

    appendCookies(res, [
      buildCookie(OAUTH_STATE_COOKIE, state, {
        maxAge: STATE_MAX_AGE,
        secure: isSecureRequest(req),
      }),
    ]);

    return sendJson(res, 200, {
      success: true,
      authUrl: UserAuthManager.generateMetaOAuthUrl(state),
    });
  } catch (error) {
    console.error("OAuth login error:", {
      reason: error instanceof Error ? error.message : "unknown",
    });
    return sendJson(res, 500, {
      success: false,
      error: "Could not start the Meta login flow. Check the server configuration.",
    });
  }
}
