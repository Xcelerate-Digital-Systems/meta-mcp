import type { VercelRequest } from "@vercel/node";
import { UserAuthManager, SESSION_COOKIE, type UserSession } from "./user-auth.js";
import { getCookie, isSameOrigin } from "./http.js";

export interface AuthenticatedRequest {
  session: UserSession | null;
  /** How the caller proved who they are - decides whether CSRF applies. */
  via: "bearer" | "cookie" | null;
  sessionToken: string | null;
}

/**
 * Resolve the caller from either an Authorization header (MCP clients) or the
 * session cookie (the dashboard). The bearer path is checked first so an API
 * caller is never mistaken for a browser.
 */
export async function authenticateRequest(req: VercelRequest): Promise<AuthenticatedRequest> {
  const bearer = UserAuthManager.extractBearerToken(req.headers.authorization);

  if (bearer) {
    return {
      session: await UserAuthManager.authenticateSessionToken(bearer),
      via: "bearer",
      sessionToken: bearer,
    };
  }

  const cookie = getCookie(req, SESSION_COOKIE);

  if (cookie) {
    return {
      session: await UserAuthManager.authenticateSessionToken(cookie),
      via: "cookie",
      sessionToken: cookie,
    };
  }

  return { session: null, via: null, sessionToken: null };
}

/**
 * Whether a state-changing request is safe to act on.
 *
 * Cookie-authenticated writes must come from our own origin; bearer-authenticated
 * ones cannot be forged cross-site, because setting that header requires a CORS
 * preflight this server never approves.
 */
export function isCsrfSafe(req: VercelRequest, via: AuthenticatedRequest["via"]): boolean {
  if (via !== "cookie") return true;
  return isSameOrigin(req);
}
