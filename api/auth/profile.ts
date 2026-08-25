import type { VercelRequest, VercelResponse } from "@vercel/node";
import { UserAuthManager } from "../../src/utils/user-auth.js";
import { authenticateRequest } from "../../src/utils/session-request.js";
import { sendJson } from "../../src/utils/http.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return sendJson(res, 405, { success: false, error: "Method not allowed" });
  }

  try {
    const { session } = await authenticateRequest(req);

    if (!session) {
      return sendJson(res, 401, {
        success: false,
        error: "Unauthorized",
        message: "Sign in to view your profile.",
      });
    }

    const tokenStatus = await UserAuthManager.getTokenStatus(session.userId).catch(() => null);

    return sendJson(res, 200, {
      success: true,
      user: {
        id: session.userId,
        name: session.name,
        email: session.email ?? null,
        metaUserId: session.metaUserId,
        createdAt: session.createdAt,
        lastUsed: session.lastUsed,
      },
      mcpEndpoint: `https://${req.headers.host}/api/mcp`,
      tokenStatus: tokenStatus ?? { hasToken: false, isValid: false, scopes: [] },
    });
  } catch (error) {
    console.error("Profile error:", {
      reason: error instanceof Error ? error.message : "unknown",
    });
    return sendJson(res, 500, { success: false, error: "Could not load your profile." });
  }
}
