import type { VercelRequest, VercelResponse } from "@vercel/node";

/** Escape a string for interpolation into HTML text or a quoted attribute. */
export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const jar: Record<string, string> = {};
  if (!header) return jar;

  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    const separator = trimmed.indexOf("=");
    if (separator < 1) continue;

    const name = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (name) {
      jar[name] = decodeURIComponent(value);
    }
  }

  return jar;
}

export function getCookie(req: VercelRequest, name: string): string | null {
  return parseCookies(req.headers.cookie)[name] ?? null;
}

/**
 * True when the request reached us over HTTPS, so cookies can carry `Secure`.
 * Checked per request rather than by matching hostnames against a list.
 */
export function isSecureRequest(req: VercelRequest): boolean {
  const proto = req.headers["x-forwarded-proto"];
  const value = Array.isArray(proto) ? proto[0] : proto;

  if (value) return value.split(",")[0].trim() === "https";
  return process.env.VERCEL_ENV !== undefined;
}

export interface CookieOptions {
  maxAge: number;
  secure: boolean;
  sameSite?: "Lax" | "Strict" | "None";
  path?: string;
  httpOnly?: boolean;
}

export function buildCookie(name: string, value: string, options: CookieOptions): string {
  const parts = [
    `${name}=${value}`,
    `Path=${options.path ?? "/"}`,
    `Max-Age=${options.maxAge}`,
    `SameSite=${options.sameSite ?? "Lax"}`,
  ];

  if (options.httpOnly !== false) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");

  return parts.join("; ");
}

export function clearCookie(name: string, secure: boolean): string {
  return buildCookie(name, "", { maxAge: 0, secure });
}

export function appendCookies(res: VercelResponse, cookies: string[]): void {
  const existing = res.getHeader("Set-Cookie");
  const previous = Array.isArray(existing)
    ? existing
    : typeof existing === "string"
      ? [existing]
      : [];

  res.setHeader("Set-Cookie", [...previous, ...cookies]);
}

/**
 * Baseline response headers. HTML responses additionally get a CSP tight enough
 * that an injected script cannot execute or exfiltrate the page's token.
 */
export function applySecurityHeaders(
  res: VercelResponse,
  options: { html?: boolean; noStore?: boolean } = {}
): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  res.setHeader("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");

  if (options.html) {
    res.setHeader(
      "Content-Security-Policy",
      [
        "default-src 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'",
        "img-src 'self' data:",
        "style-src 'unsafe-inline'",
        "script-src 'unsafe-inline'",
        "connect-src 'self'",
      ].join("; ")
    );
  }

  if (options.noStore !== false) {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.setHeader("Pragma", "no-cache");
  }
}

export function sendHtml(res: VercelResponse, status: number, html: string): void {
  applySecurityHeaders(res, { html: true });
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.status(status).send(html);
}

export function sendJson(res: VercelResponse, status: number, body: unknown): void {
  applySecurityHeaders(res);
  res.status(status).json(body);
}

/** Client IP, taken from the proxy header Vercel sets. Used for rate limiting. */
export function clientIp(req: VercelRequest): string {
  const forwarded = req.headers["x-forwarded-for"];
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return value?.split(",")[0].trim() || req.socket?.remoteAddress || "unknown";
}

/**
 * Same-origin check for cookie-authenticated state changes.
 *
 * Requests carrying an `Authorization` header are exempt: a cross-site page
 * cannot set that header without a CORS preflight we never approve.
 */
export function isSameOrigin(req: VercelRequest): boolean {
  const origin = req.headers.origin;
  const referer = req.headers.referer;
  const host = req.headers.host;

  if (!host) return false;

  const source = origin || referer;
  if (!source) return false;

  try {
    return new URL(source).host === host;
  } catch {
    return false;
  }
}
