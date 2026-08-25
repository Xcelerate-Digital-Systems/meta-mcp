import { SignJWT, jwtVerify } from "jose";
import { AuthManager } from "./auth.js";
import { getStorage } from "./storage.js";
import { getJwtSecret } from "./secrets.js";
import { encryptSecret, decryptSecret, appSecretProof } from "./crypto.js";
import type { MetaApiConfig } from "../types/meta-api.js";

export const SESSION_COOKIE = "session_token";
export const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

const SESSION_PREFIX = "user_session:";
const TOKEN_PREFIX = "user_tokens:";
const TOKEN_TTL_SECONDS = 60 * 24 * 60 * 60;
const GRAPH_VERSION = process.env.META_API_VERSION || "v23.0";
const GRAPH_BASE = process.env.META_BASE_URL || "https://graph.facebook.com";

export interface UserSession {
  userId: string;
  email?: string;
  name: string;
  metaUserId: string;
  /** Bumped when a token is rotated, which invalidates every token issued before. */
  tokenVersion?: number;
  tokenExpiration?: Date;
  createdAt: Date;
  lastUsed: Date;
}

export interface UserTokenData {
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  expiresIn?: number;
  expiresAt?: string;
  scope: string[];
}

interface StoredTokenData extends Omit<UserTokenData, "accessToken" | "refreshToken"> {
  accessToken: string;
  refreshToken?: string;
  updatedAt: string;
}

export class UserAuthManager {
  private static JWT_EXPIRY = `${SESSION_MAX_AGE_SECONDS}s`;

  /** Create a JWT session token for a user. */
  static async createSessionToken(userId: string, tokenVersion = 1): Promise<string> {
    return new SignJWT({ userId, ver: tokenVersion })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime(this.JWT_EXPIRY)
      .sign(getJwtSecret());
  }

  /** Verify a JWT session token. Returns null for anything that does not verify. */
  static async verifySessionToken(
    token: string
  ): Promise<{ userId: string; tokenVersion: number } | null> {
    try {
      const { payload } = await jwtVerify(token, getJwtSecret());

      if (typeof payload.userId !== "string") return null;

      return {
        userId: payload.userId,
        tokenVersion: typeof payload.ver === "number" ? payload.ver : 1,
      };
    } catch {
      // Expired or tampered tokens are an expected condition, not an incident.
      return null;
    }
  }

  static async storeUserSession(session: UserSession): Promise<void> {
    await getStorage().set(`${SESSION_PREFIX}${session.userId}`, session, {
      ex: SESSION_MAX_AGE_SECONDS,
    });
  }

  /**
   * Load a session. `lastUsed` is refreshed at most once an hour so a busy MCP
   * client does not write to storage on every single tool call.
   */
  static async getUserSession(userId: string): Promise<UserSession | null> {
    const session = await getStorage().get<UserSession>(`${SESSION_PREFIX}${userId}`);
    if (!session) return null;

    const lastUsed = new Date(session.lastUsed);
    if (Date.now() - lastUsed.getTime() > 60 * 60 * 1000) {
      session.lastUsed = new Date();
      await this.storeUserSession(session);
    }

    return session;
  }

  /** Store Meta tokens, encrypted at rest. */
  static async storeUserTokens(userId: string, tokens: UserTokenData): Promise<void> {
    const expiresAt =
      tokens.expiresAt ??
      (tokens.expiresIn ? new Date(Date.now() + tokens.expiresIn * 1000).toISOString() : undefined);

    const record: StoredTokenData = {
      ...tokens,
      accessToken: encryptSecret(tokens.accessToken),
      refreshToken: tokens.refreshToken ? encryptSecret(tokens.refreshToken) : undefined,
      expiresAt,
      updatedAt: new Date().toISOString(),
    };

    await getStorage().set(`${TOKEN_PREFIX}${userId}`, record, { ex: TOKEN_TTL_SECONDS });
  }

  /** Read Meta tokens, decrypting records written by `storeUserTokens`. */
  static async getUserTokens(userId: string): Promise<UserTokenData | null> {
    const record = await getStorage().get<StoredTokenData>(`${TOKEN_PREFIX}${userId}`);
    if (!record) return null;

    return {
      ...record,
      accessToken: decryptSecret(record.accessToken),
      refreshToken: record.refreshToken ? decryptSecret(record.refreshToken) : undefined,
    };
  }

  /** Build an AuthManager bound to one user's stored Meta credentials. */
  static async createUserAuthManager(userId: string): Promise<AuthManager | null> {
    const tokens = await this.getUserTokens(userId);
    if (!tokens) return null;

    const config: MetaApiConfig = {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      tokenExpiration: tokens.expiresAt ? new Date(tokens.expiresAt) : undefined,
      appId: process.env.META_APP_ID,
      appSecret: process.env.META_APP_SECRET,
      redirectUri: process.env.META_REDIRECT_URI,
      autoRefresh: true,
      apiVersion: process.env.META_API_VERSION,
      baseUrl: process.env.META_BASE_URL,
    };

    return new AuthManager(config);
  }

  /**
   * An AuthManager whose token is known-fresh: if the stored token is inside its
   * expiry buffer it is exchanged first and the new one persisted, so the
   * refreshed token survives the invocation instead of being thrown away.
   */
  static async getRefreshedAuthManager(userId: string): Promise<AuthManager | null> {
    const tokens = await this.getUserTokens(userId);
    if (!tokens) return null;

    const expiresAt = tokens.expiresAt ? new Date(tokens.expiresAt).getTime() : null;
    const isExpiring = expiresAt === null || expiresAt - Date.now() < 24 * 60 * 60 * 1000;

    if (isExpiring && process.env.META_APP_ID && process.env.META_APP_SECRET) {
      await this.refreshUserToken(userId);
    }

    return this.createUserAuthManager(userId);
  }

  /** Remove the session only. The user's Meta tokens stay usable. */
  static async deleteUserSession(userId: string): Promise<void> {
    await getStorage().del(`${SESSION_PREFIX}${userId}`);
  }

  /** Remove the session and the stored Meta tokens. */
  static async deleteUserData(userId: string): Promise<void> {
    await Promise.all([
      getStorage().del(`${SESSION_PREFIX}${userId}`),
      getStorage().del(`${TOKEN_PREFIX}${userId}`),
    ]);
  }

  static extractBearerToken(authHeader: string | null | undefined): string | null {
    if (!authHeader?.startsWith("Bearer ")) return null;
    return authHeader.substring(7).trim() || null;
  }

  static async authenticateUser(
    authHeader: string | null | undefined
  ): Promise<UserSession | null> {
    const token = this.extractBearerToken(authHeader);
    if (!token) return null;
    return this.authenticateSessionToken(token);
  }

  static async authenticateSessionToken(token: string | null): Promise<UserSession | null> {
    if (!token) return null;

    const decoded = await this.verifySessionToken(token);
    if (!decoded) return null;

    const session = await this.getUserSession(decoded.userId);
    if (!session) return null;

    // A rotated session invalidates every token issued before the rotation.
    if ((session.tokenVersion ?? 1) !== decoded.tokenVersion) return null;

    return session;
  }

  /**
   * Issue a new session token and invalidate all previous ones for this user.
   */
  static async rotateSessionToken(userId: string): Promise<string | null> {
    const session = await this.getUserSession(userId);
    if (!session) return null;

    session.tokenVersion = (session.tokenVersion ?? 1) + 1;
    await this.storeUserSession(session);

    return this.createSessionToken(userId, session.tokenVersion);
  }

  static async generateOAuthState(): Promise<string> {
    const crypto = await import("crypto");
    return crypto.randomBytes(32).toString("hex");
  }

  /**
   * Meta OAuth authorization URL.
   *
   * `email` is requested explicitly — without it Meta omits the field from
   * /me and the profile is stored with no address.
   */
  static generateMetaOAuthUrl(state: string): string {
    if (!process.env.META_APP_ID || !process.env.META_REDIRECT_URI) {
      throw new Error("META_APP_ID and META_REDIRECT_URI must be configured");
    }

    const scopes = ["public_profile", "email", "ads_management", "ads_read", "business_management"];

    const params = new URLSearchParams({
      client_id: process.env.META_APP_ID,
      redirect_uri: process.env.META_REDIRECT_URI,
      scope: scopes.join(","),
      response_type: "code",
      state,
    });

    return `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth?${params.toString()}`;
  }

  /**
   * Exchange the authorization code for an access token, then immediately
   * upgrade it to a long-lived token — the code-exchange token expires in about
   * an hour, which is far shorter than the session that wraps it.
   */
  static async exchangeCodeForTokens(code: string): Promise<UserTokenData> {
    const { META_APP_ID, META_APP_SECRET, META_REDIRECT_URI } = process.env;

    if (!META_APP_ID || !META_APP_SECRET || !META_REDIRECT_URI) {
      throw new Error("META_APP_ID, META_APP_SECRET, and META_REDIRECT_URI must be configured");
    }

    const params = new URLSearchParams({
      client_id: META_APP_ID,
      client_secret: META_APP_SECRET,
      redirect_uri: META_REDIRECT_URI,
      code,
    });

    const response = await fetch(`${GRAPH_BASE}/${GRAPH_VERSION}/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    if (!response.ok) {
      throw new Error(`Token exchange failed: ${await response.text()}`);
    }

    const data = await response.json();
    const shortLived: UserTokenData = {
      accessToken: data.access_token,
      tokenType: data.token_type || "bearer",
      expiresIn: data.expires_in,
      scope: [],
    };

    try {
      return await this.exchangeForLongLivedToken(shortLived);
    } catch (error) {
      console.warn("Long-lived token exchange failed, keeping short-lived token:", {
        reason: error instanceof Error ? error.message : "unknown",
      });
      return shortLived;
    }
  }

  /** Trade a short-lived user token for Meta's ~60 day long-lived token. */
  static async exchangeForLongLivedToken(tokens: UserTokenData): Promise<UserTokenData> {
    const { META_APP_ID, META_APP_SECRET } = process.env;

    if (!META_APP_ID || !META_APP_SECRET) {
      throw new Error("META_APP_ID and META_APP_SECRET must be configured");
    }

    const params = new URLSearchParams({
      grant_type: "fb_exchange_token",
      client_id: META_APP_ID,
      client_secret: META_APP_SECRET,
      fb_exchange_token: tokens.accessToken,
    });

    const response = await fetch(
      `${GRAPH_BASE}/${GRAPH_VERSION}/oauth/access_token?${params.toString()}`
    );

    if (!response.ok) {
      throw new Error(`Long-lived token exchange failed: ${await response.text()}`);
    }

    const data = await response.json();

    return {
      ...tokens,
      accessToken: data.access_token,
      tokenType: data.token_type || "bearer",
      expiresIn: data.expires_in,
      expiresAt: data.expires_in
        ? new Date(Date.now() + data.expires_in * 1000).toISOString()
        : undefined,
    };
  }

  /** Fetch the Meta profile. `email` is absent unless the user granted the scope. */
  static async getMetaUserInfo(accessToken: string): Promise<{
    id: string;
    name: string;
    email?: string;
  }> {
    const params = new URLSearchParams({
      fields: "id,name,email",
      access_token: accessToken,
    });

    if (process.env.META_APP_SECRET) {
      params.set("appsecret_proof", appSecretProof(accessToken, process.env.META_APP_SECRET));
    }

    const response = await fetch(`${GRAPH_BASE}/${GRAPH_VERSION}/me?${params.toString()}`);

    if (!response.ok) {
      throw new Error(`Failed to get user info: ${await response.text()}`);
    }

    const profile = await response.json();

    return {
      id: profile.id,
      name: profile.name || "Meta user",
      email: profile.email || undefined,
    };
  }

  /**
   * Refresh a user's Meta token when it is inside its expiry buffer.
   * Returns false when there is nothing stored or the exchange fails.
   */
  static async refreshUserToken(userId: string): Promise<boolean> {
    const tokens = await this.getUserTokens(userId);
    if (!tokens) return false;

    try {
      const refreshed = await this.exchangeForLongLivedToken(tokens);
      await this.storeUserTokens(userId, refreshed);

      const session = await this.getUserSession(userId);
      if (session) {
        session.tokenExpiration = refreshed.expiresAt ? new Date(refreshed.expiresAt) : undefined;
        await this.storeUserSession(session);
      }

      return true;
    } catch (error) {
      console.error("Token refresh failed:", {
        userId,
        reason: error instanceof Error ? error.message : "unknown",
      });
      return false;
    }
  }

  /** Live token status from Meta's debug_token endpoint. */
  static async getTokenStatus(userId: string): Promise<{
    hasToken: boolean;
    isValid: boolean;
    expiresAt?: string;
    scopes: string[];
  }> {
    const tokens = await this.getUserTokens(userId);
    if (!tokens) {
      return { hasToken: false, isValid: false, scopes: [] };
    }

    const auth = await this.createUserAuthManager(userId);
    if (!auth) {
      return { hasToken: true, isValid: false, scopes: [], expiresAt: tokens.expiresAt };
    }

    const info = await auth.getTokenInfo();

    return {
      hasToken: true,
      isValid: info.isValid,
      expiresAt: info.expiresAt?.toISOString() ?? tokens.expiresAt,
      scopes: info.scopes,
    };
  }
}
