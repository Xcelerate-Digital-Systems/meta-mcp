import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  UserAuthManager,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  type UserSession,
} from "../../src/utils/user-auth.js";
import { ACCESS_GATE_COOKIE, hasGateAccess } from "../../src/utils/access-pin.js";
import { safeEqual } from "../../src/utils/crypto.js";
import {
  appendCookies,
  buildCookie,
  clearCookie,
  escapeHtml,
  getCookie,
  isSecureRequest,
  sendHtml,
} from "../../src/utils/http.js";

const OAUTH_STATE_COOKIE = "oauth_state";

/** A plain page for the failure paths, so a broken login never renders raw JSON. */
function errorPage(title: string, detail: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
         background:#f7fafc; color:#1a202c; padding:1.5rem; }
  .card { background:#fff; border-radius:12px; box-shadow:0 1px 3px rgba(0,0,0,.1);
          padding:2rem; max-width:460px; width:100%; }
  h1 { font-size:1.3rem; margin:0 0 .75rem; }
  p { color:#4a5568; line-height:1.6; margin:0 0 1.5rem; }
  a { display:inline-block; background:#1877f2; color:#fff; text-decoration:none;
      padding:10px 18px; border-radius:8px; font-size:.95rem; }
</style>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(detail)}</p>
    <a href="/">Start again</a>
  </div>
</body>
</html>`;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return sendHtml(res, 405, errorPage("Method not allowed", "This address only accepts GET."));
  }

  const secure = isSecureRequest(req);

  try {
    const { code, state, error } = req.query;

    if (error) {
      console.warn("OAuth authorization declined by Meta or the user.");
      return sendHtml(
        res,
        400,
        errorPage(
          "Meta did not complete the login",
          "The authorization was cancelled or declined. You can try connecting again."
        )
      );
    }

    if (typeof code !== "string" || typeof state !== "string") {
      return sendHtml(
        res,
        400,
        errorPage(
          "That login link is incomplete",
          "The authorization code or state was missing. Start the login again from the home page."
        )
      );
    }

    // The gate cookie must still be present: without it, anyone holding a
    // Meta redirect could mint a session on a PIN-protected server.
    if (!(await hasGateAccess(getCookie(req, ACCESS_GATE_COOKIE)))) {
      return sendHtml(
        res,
        403,
        errorPage("Access PIN required", "Enter the access PIN, then connect your Meta account.")
      );
    }

    const storedState = getCookie(req, OAUTH_STATE_COOKIE);

    if (!storedState || !safeEqual(storedState, state)) {
      console.warn("OAuth state mismatch on callback.");
      return sendHtml(
        res,
        400,
        errorPage(
          "This login could not be verified",
          "The security check on the login link failed, which usually means it expired or was opened in a different browser. Start again from the home page."
        )
      );
    }

    const tokens = await UserAuthManager.exchangeCodeForTokens(code);
    const userInfo = await UserAuthManager.getMetaUserInfo(tokens.accessToken);

    const userId = `meta_${userInfo.id}`;
    const session: UserSession = {
      userId,
      email: userInfo.email,
      name: userInfo.name,
      metaUserId: userInfo.id,
      tokenVersion: 1,
      tokenExpiration: tokens.expiresAt ? new Date(tokens.expiresAt) : undefined,
      createdAt: new Date(),
      lastUsed: new Date(),
    };

    await UserAuthManager.storeUserSession(session);
    await UserAuthManager.storeUserTokens(userId, tokens);

    const sessionToken = await UserAuthManager.createSessionToken(userId);

    appendCookies(res, [
      clearCookie(OAUTH_STATE_COOKIE, secure),
      buildCookie(SESSION_COOKIE, sessionToken, {
        maxAge: SESSION_MAX_AGE_SECONDS,
        secure,
      }),
    ]);

    // The session travels in the HttpOnly cookie only - never in the URL,
    // where it would land in history, logs and referrer headers.
    return res.redirect(302, "/dashboard");
  } catch (error) {
    console.error("OAuth callback error:", {
      reason: error instanceof Error ? error.message : "unknown",
    });
    return sendHtml(
      res,
      500,
      errorPage(
        "We could not finish connecting your account",
        "Meta accepted the login but the server could not complete it. Try again, and if it keeps happening check the server logs."
      )
    );
  }
}
