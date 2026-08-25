import type { VercelRequest, VercelResponse } from "@vercel/node";
import { sendJson } from "../src/utils/http.js";

/**
 * Configuration self-check for local development.
 *
 * Reports only whether variables are present - never their values - and is
 * unreachable on any deployed environment.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const isDeployed = Boolean(process.env.VERCEL_ENV) || process.env.NODE_ENV === "production";

  if (isDeployed) {
    return sendJson(res, 404, { error: "Not found" });
  }

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return sendJson(res, 405, { error: "Method not allowed" });
  }

  return sendJson(res, 200, {
    success: true,
    environment: process.env.NODE_ENV ?? "development",
    configured: {
      META_APP_ID: !!process.env.META_APP_ID,
      META_APP_SECRET: !!process.env.META_APP_SECRET,
      META_REDIRECT_URI: !!process.env.META_REDIRECT_URI,
      JWT_SECRET: !!process.env.JWT_SECRET,
      TOKEN_ENCRYPTION_KEY: !!process.env.TOKEN_ENCRYPTION_KEY,
      ACCESS_PIN: !!(process.env.ACCESS_PIN || process.env.ACCESS_PIN_HASH),
      storage: process.env.REDIS_URL
        ? "redis"
        : process.env.KV_REST_API_URL
          ? "vercel-kv"
          : "none",
    },
    checklist: [
      "META_REDIRECT_URI must exactly match the redirect URI configured in the Meta app",
      "JWT_SECRET must be at least 32 characters - the server refuses to start without it",
      "Set ACCESS_PIN (or ACCESS_PIN_HASH) to require a PIN before anyone can connect",
    ],
  });
}
