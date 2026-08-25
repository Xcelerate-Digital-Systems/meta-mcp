import type { VercelRequest, VercelResponse } from "@vercel/node";
import { UserAuthManager, SESSION_COOKIE } from "../../src/utils/user-auth.js";
import { authenticateRequest, isCsrfSafe } from "../../src/utils/session-request.js";
import { appSecretProof } from "../../src/utils/crypto.js";
import { appendCookies, clearCookie, isSecureRequest, sendJson } from "../../src/utils/http.js";

const GRAPH_VERSION = process.env.META_API_VERSION || "v23.0";
const GRAPH_BASE = process.env.META_BASE_URL || "https://graph.facebook.com";

/** Disconnect Meta entirely: revoke the permissions, then delete everything stored. */
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

    const tokens = await UserAuthManager.getUserTokens(session.userId);

    if (tokens?.accessToken) {
      try {
        const params = new URLSearchParams({ access_token: tokens.accessToken });

        if (process.env.META_APP_SECRET) {
          params.set(
            "appsecret_proof",
            appSecretProof(tokens.accessToken, process.env.META_APP_SECRET)
          );
        }

        const response = await fetch(
          `${GRAPH_BASE}/${GRAPH_VERSION}/me/permissions?${params.toString()}`,
          { method: "DELETE" }
        );

        if (!response.ok) {
          console.warn("Meta permission revocation returned an error; continuing with local cleanup.");
        }
      } catch (error) {
        console.warn("Meta permission revocation failed; continuing with local cleanup:", {
          reason: error instanceof Error ? error.message : "unknown",
        });
      }
    }

    await UserAuthManager.deleteUserData(session.userId);
    appendCookies(res, [clearCookie(SESSION_COOKIE, isSecureRequest(req))]);

    return sendJson(res, 200, {
      success: true,
      message: "Meta access revoked and stored tokens deleted. Existing MCP clients will stop working.",
    });
  } catch (error) {
    console.error("Token revocation error:", {
      reason: error instanceof Error ? error.message : "unknown",
    });
    return sendJson(res, 500, { success: false, error: "Could not revoke access." });
  }
}
