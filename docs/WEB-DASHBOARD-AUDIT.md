# Web Plugin & Dashboard Audit

**Scope:** the browser-facing web app (`api/index.ts`, `api/dashboard.ts`, `public/index.html`),
the OAuth/session layer (`api/auth/*`, `src/utils/user-auth.ts`, `src/utils/auth.ts`), and the
remote MCP endpoint that acts as the connector/"plugin" (`api/mcp.ts`, `vercel.json`).

**Date:** 2026-08-25 · **Branch:** `claude/web-plugin-dashboard-audit-q2eh6k` · **Version audited:** 1.7.0

---

## Executive summary

The web surface works as a "log in with Meta → copy a bearer token → paste into Claude Desktop"
onboarding page. It is functional but thin, and it carries several defects that are either
live bugs today or one misconfiguration away from a full account compromise.

Headline items:

| # | Severity | Issue |
|---|---|---|
| 1 | **Critical** | JWT signing secret falls back to a hardcoded literal — forgeable sessions |
| 2 | **Critical** | Live user JWT committed to the repo (`examples/claude_desktop_config_remote.json`) |
| 3 | **High** | Session token passed in the URL query string and mirrored into `localStorage` |
| 4 | **High** | Meta access tokens stored in plaintext in Redis/KV, no encryption at rest |
| 5 | **High** | Full cookies + tokens written to serverless logs; cookie dump returned in an error body |
| 6 | **High** | No CSP / security headers; unescaped user data interpolated into dashboard HTML |
| 7 | **High** | `email` scope never requested → dashboard renders `undefined` for every user |
| 8 | **High** | `/api/auth/refresh` reports success without ever refreshing a token |
| 9 | **High** | Meta short-lived token is never exchanged for a long-lived one → connector dies in ~1–2h |
| 10 | **High** | No MCP OAuth discovery (`.well-known/*`) → cannot be added as a Claude.ai custom connector |
| 11 | **Medium** | `npm run lint` and `npm test` are both broken; zero tests exist; `api/` is never type-checked |
| 12 | **Medium** | Remote MCP and stdio MCP have diverged: different tool names, different coverage |

Everything below is grounded in specific files and lines.

---

## 1. Security

### 1.1 Hardcoded JWT secret fallback — **Critical**
`src/utils/user-auth.ts:152`
```ts
private static JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
```
If `JWT_SECRET` is ever unset (new environment, preview deployment, a typo'd variable name),
the server silently signs and verifies sessions with a string that is public in this repo.
Anyone can mint `{"userId":"meta_<id>"}` and drive the MCP endpoint as that user — which means
full `ads_management` on their ad accounts.

**Fix:** fail closed at module load. Throw if `JWT_SECRET` is missing or shorter than 32 bytes.
Never ship a default. Consider `kid`-based key rotation while you are in there.

### 1.2 Real session token committed to the repo — **Critical**
`examples/claude_desktop_config_remote.json:5` contains a full HS256 JWT for
`meta_23918091947853431` (issued 2025-06-27, expired 2025-07-04).

It is expired, so it is not directly exploitable — but it is a real credential in git history,
it confirms the signing scheme, and it should be treated as a leak: rotate `JWT_SECRET`, purge
the value, and replace it with `Bearer <your-session-token>`.

### 1.3 Session token in the URL and in `localStorage` — **High**
`api/auth/callback.ts:122`
```ts
res.redirect(302, `/api/dashboard?token=${sessionToken}`);
```
`api/dashboard.ts:432`
```js
localStorage.setItem('sessionToken', '${sessionToken}');
```
The token is already set as an `HttpOnly` cookie one line earlier, so the query param is a pure
downgrade: it lands in browser history, in Vercel's request logs, and in the `Referer` header of
any future external request from that page. The `localStorage` copy exists only because
`/api/auth/profile` and `/api/auth/logout` refuse to read the cookie — it hands any XSS a
7-day credential.

**Fix:** drop the query param entirely; make `profile`/`logout`/`refresh`/`revoke` accept the
`HttpOnly` cookie (with a CSRF token on the state-changing ones) and delete the `localStorage` write.

### 1.4 Tokens and cookies written to logs — **High**
- `api/dashboard.ts:21-33` logs the **entire** `Cookie` header, which contains the session JWT.
- `api/auth/login.ts:13` logs the raw OAuth state.
- `api/auth/callback.ts:44-51` logs all cookies and the cookie map.
- `api/auth/callback.ts:56-66` **returns** `allCookies` and `cookieMap` in the HTTP 400 body on a
  state mismatch — a live info-disclosure path reachable by anyone who can trigger the mismatch.

**Fix:** remove the debug payload from the response; log booleans/lengths, never values.

### 1.5 No security headers anywhere — **High**
`vercel.json` has no `headers` block, and neither HTML handler sets one. Missing:
`Content-Security-Policy`, `X-Frame-Options`/`frame-ancestors` (the dashboard displays a bearer
token and is fully framable → clickjacking), `Referrer-Policy`, `X-Content-Type-Options`,
`Strict-Transport-Security`, `Permissions-Policy`, and `Cache-Control: no-store` on the
token-bearing dashboard HTML.

### 1.6 Unescaped interpolation into HTML — **High (defence in depth)**
`api/dashboard.ts:348-349,358` inject `user.name` and `user.email` straight into markup with no
escaping. Meta constrains profile names, so this is not a one-click exploit today — but the
values are attacker-influenced, the page holds a live credential, and there is no CSP to catch a
mistake. Escape on output (or render client-side from a JSON payload).

### 1.7 Inconsistent `Secure` cookie detection — **Medium**
`api/auth/login.ts:16` treats only `*.vercel.app` / `*.netlify.app` as production;
`api/auth/callback.ts:100-103` adds `offerarc.com`. On the custom domain the `oauth_state` cookie
is therefore set **without** `Secure`, while the session cookie gets it. Use
`process.env.VERCEL_ENV === 'production'` (or simply always set `Secure` when the request is HTTPS)
in one shared helper.

### 1.8 Meta tokens stored in plaintext — **High**
`src/utils/user-auth.ts:230-238` writes `accessToken`/`refreshToken` to Redis/KV as-is. Anyone with
a Redis URL, a snapshot, or a backup gets working `ads_management` tokens for every user.
Encrypt at rest (AES-GCM with a KMS/env key) and store only the ciphertext.

### 1.9 No `appsecret_proof` on Graph calls — **Medium**
`src/meta-client.ts` and `src/utils/user-auth.ts` never send `appsecret_proof`. Meta recommends it
for all server-side calls, and enabling "Require App Secret" in the app dashboard would break this
server instantly.

### 1.10 No rate limiting or abuse controls on the web endpoints — **Medium**
`/api/auth/login`, `/api/auth/callback`, `/api/dashboard` and `/api/mcp` have no throttling.
`src/utils/rate-limiter.ts` exists but is (a) only wired into the Meta client and (b) an in-memory
`Map` (`src/utils/rate-limiter.ts:18`), which is meaningless across serverless invocations. Move to a
Redis-backed limiter keyed by IP and by `userId`.

### 1.11 Environment-gated debug endpoints rely on `NODE_ENV` — **Medium**
`api/debug.ts:5` and `api/test-auth.ts:6` 404 only when `NODE_ENV === 'production'`. On Vercel that
holds for both production *and* preview builds, so today they are closed — but preview deployments
are the risky case and the check does not distinguish them. `api/test-auth.ts` mints a valid session
JWT for `test_user_123` with no authentication at all. Gate on `VERCEL_ENV !== 'development'` plus a
shared secret, or delete the endpoint.

### 1.12 Scope and consent — **Low/Medium**
`src/utils/user-auth.ts:335-340` requests `ads_management, ads_read, business_management`.
`business_management` is broad and triggers heavier App Review; drop it unless a tool actually needs
it. There is also no consent/ToS/privacy copy on the login page and no data-deletion callback, both
of which Meta App Review will ask for.

---

## 2. Correctness bugs (live today)

### 2.1 Dashboard shows `undefined` for every user's email — **High**
The OAuth scope list never includes `email` (or `public_profile`), yet
`src/utils/user-auth.ts:402` fetches `/me?fields=id,name,email` and `api/auth/callback.ts:76`
stores it. Meta omits `email` without the `email` permission, so `UserSession.email` — typed as a
required `string` — is `undefined` at runtime and `api/dashboard.ts:349` renders the literal
string `undefined` under the user's name. `/api/auth/profile` returns `email: undefined` too.

**Fix:** request the `email` scope, and make the field optional with a fallback in the UI.

### 2.2 `/api/auth/refresh` never refreshes anything — **High**
`UserAuthManager.refreshUserToken()` (`user-auth.ts:416`) → `AuthManager.refreshTokenIfNeeded()` →
`autoRefreshToken()` (`auth.ts:238`), which only exchanges when `isTokenExpiring()` is true.
`isTokenExpiring()` (`auth.ts:224`) returns `false` whenever `config.tokenExpiration` is unset — and
`createUserAuthManager()` (`user-auth.ts:252-269`) never sets it. So the "refresh" path returns the
existing token, `refreshUserToken` reports `true`, and the endpoint answers
`{"success": true, "message": "Tokens refreshed successfully"}` having done nothing.

**Fix:** persist `tokenExpiration` alongside the token and pass it into the config; make refresh
call `exchangeForLongLivedToken()` unconditionally when the token is within its buffer window.

### 2.3 Short-lived token is never upgraded — **High**
`exchangeCodeForTokens()` (`user-auth.ts:357`) returns Meta's code-exchange token as-is. For most
Facebook Login configurations that is a short-lived token (~1–2 hours). Meanwhile the session JWT
lasts 7 days (`user-auth.ts:154`) and the stored token record is given a 60-day TTL
(`user-auth.ts:237`). Result: the dashboard keeps showing "✅ Meta Account Connected" and the MCP
config keeps "working" while every Meta call fails with an auth error.

**Fix:** call `exchangeForLongLivedToken()` immediately after code exchange, store the returned
`expires_in`, and surface real expiry in the dashboard.

### 2.4 `vv23.0` in the OAuth URL — **Medium**
`src/utils/auth.ts:124`
```ts
return `https://www.facebook.com/v${this.getApiVersion()}/dialog/oauth?...`;
```
`getApiVersion()` already returns `"v23.0"`, so this builds `.../vv23.0/dialog/oauth`. Only reachable
via the stdio `generateAuthUrl` path (the web flow uses its own builder), but it is broken.

### 2.5 Dashboard copy buttons — **Low**
`api/dashboard.ts:434-436` `copyEndpoint()` grabs `document.querySelector('.copy-btn')` (the first button
on the page), so the "Copied!" feedback can land on the wrong button; `copyConfig()` relies on the
deprecated global `event`. Both fail silently in non-secure contexts because there is no
`navigator.clipboard` fallback. `user.name.split(" ")[0]` (`dashboard.ts:358`) throws if `name` is
ever absent, and the `catch` turns that into a redirect loop to `/api`.

### 2.6 Routing is inconsistent and partly dead — **Low**
`public/index.html` (a static file) wins over the `vercel.json` rewrite `/` → `/api/index`, then
JS-redirects to `/api/index` — a needless flash, and the rewrite is dead config. Meanwhile
`/dashboard` (rewrite) and `/api/dashboard` (redirect target in `callback.ts:122`) both exist, and
error paths redirect to `/api`. Pick one canonical surface and make every link agree.

### 2.7 Logout deletes everything, everywhere — **Medium (UX)**
`api/auth/logout.ts:23` calls `deleteUserData()`, which wipes the Meta tokens as well as the session.
Clicking "Logout" in the dashboard therefore breaks the user's Claude Desktop connector — which is
what `/api/auth/revoke` is for. Logout should invalidate the session only.

---

## 3. The MCP endpoint as a "plugin"

### 3.1 No OAuth discovery → not installable as a Claude.ai connector — **High**
There is no `/.well-known/oauth-protected-resource`, no `/.well-known/oauth-authorization-server`,
no dynamic client registration, and `api/mcp.ts` never returns `401` with a `WWW-Authenticate`
challenge (auth failures come back as `isError: true` tool results — `mcp.ts:29-45`). That is why
the dashboard has to tell users to hand-paste a bearer token into an `mcp-remote` stanza.

Implementing the MCP authorization spec (protected-resource metadata + `401` challenge + PKCE
authorization-code flow) is the single highest-value change on the connector side: it turns this
into a one-click "Add custom connector" in Claude web/desktop and removes the token-paste ritual
entirely.

### 3.2 Static 7-day bearer with no rotation — **High**
The config the dashboard generates embeds a JWT that expires in 7 days (`user-auth.ts:154`).
`mcp-remote` cannot refresh a static header, so every user's connector breaks weekly and they must
log back in and re-paste the config. There is no token list, no rotation, no revocation UI, and no
expiry shown anywhere.

### 3.3 No CORS / `OPTIONS` handling — **Medium**
`api/mcp.ts:2385` exports only `GET` and `POST`. Browser-based MCP clients cannot preflight, and the
Streamable-HTTP `DELETE` (session termination) is unimplemented.

### 3.4 Auth boilerplate duplicated 24× — **Medium**
The same six-line "check header → authenticate → build AuthManager" block is repeated in all 24
authenticated tools in `api/mcp.ts`. Every call re-reads the session from Redis and `getUserSession()`
(`user-auth.ts:213-224`) **writes it back** on every read to touch `lastUsed`, doubling storage
round-trips and silently sliding the 7-day TTL forward. Hoist authentication into the request
wrapper and pass the resolved client into the tool factory.

### 3.5 Remote and stdio servers have diverged — **Medium**
`api/mcp.ts` reimplements ~2,400 lines of tool logic instead of reusing `src/tools/*`:

| | stdio (`src/index.ts`) | remote (`api/mcp.ts`) |
|---|---|---|
| List campaigns | `list_campaigns` | `get_campaigns` |
| Delete campaign | `delete_campaign` | *missing* |
| Capabilities | `get_capabilities` | *missing* (the dashboard tells users to run it) |
| Audiences | disabled (`.disabled` files) | implemented |
| Pagination | returns cursors | drops them (`mcp.ts:245-256`) |

A prompt or client written against one surface breaks on the other, and the dashboard's setup
instructions reference `get_capabilities`, which the remote server does not expose. Extract the tool
definitions into shared modules and register them from both entry points.

---

## 4. The dashboard as a product

The page is a static config dump. Everything it claims is hardcoded — `✅ Authenticated`,
`🔗 Meta Account Connected` and `🚀 MCP Server Active` are literal HTML (`dashboard.ts:362-364`),
not checks. Missing, roughly in value order:

1. **Real connection status** — call `debug_token` and show actual validity, granted scopes and expiry.
2. **Ad account list** — the user's `act_*` accounts with name, currency, status. The data is one
   `getAdAccounts()` call away and it is the first thing anyone wants to see.
3. **Token lifecycle UI** — expiry countdown, "Rotate token", "Revoke Meta access" (the `/revoke`
   endpoint exists with no button), "Reconnect".
4. **Recent activity** — last MCP call, tool call counts, error rate. Nothing is recorded today.
5. **Copy-paste targets beyond Claude Desktop** — Claude.ai connector URL, Cursor, VS Code,
   `.mcp.json`. Currently only one Claude Desktop stanza.
6. **Troubleshooting** — "test connection" button that round-trips `health_check` and shows the result.
7. **Accessibility** — no landmarks, no `aria-live` on the copy feedback, `<div>`-based buttons in
   places, no focus styling, and the `.status-item` green-on-green sits near the contrast floor.
8. **Polish** — no favicon, no `<meta name="description">`, no OG tags, no dark mode, no error page
   (OAuth failures render raw JSON at `callback.ts:56-66` and `:124-130`).

---

## 5. Engineering hygiene

| Item | State |
|---|---|
| `npm run lint` | **Broken.** ESLint 9 is installed but only `.eslintrc.json` exists; flat config (`eslint.config.js`) is required. |
| `npm test` | **Broken.** `jest.config.js:31` points at `__tests__/setup.js`; the directory does not exist. Zero test files in the repo. |
| Test matching | `jest.config.js:5-8` matches only `.js`, so TypeScript tests would never run despite `ts-jest` being installed. |
| Coverage gate | 80% thresholds configured against 0 tests. |
| `api/` type safety | `tsconfig.json:28-31` includes only `src/**/*` — `api/` is never type-checked. It does not compile: `next` is imported for types (`dashboard.ts:1`) but is not a dependency, and `error.message` on `unknown` appears 34× in `mcp.ts`. Use `@vercel/node`'s `VercelRequest`/`VercelResponse` and add `api/` to a `tsconfig.build.json`. |
| CI | None. No `.github/` at all — no build, lint, test, or secret scan on push. |
| Docker | `Dockerfile:41` does `COPY docs/ ./docs/`; that directory does not exist, so the image fails to build. |
| `.env.example` | Missing `KV_REST_API_URL` / `KV_REST_API_TOKEN` (read at `user-auth.ts:123`), and `META_REDIRECT_URI` documents only localhost. |
| Docs | The README never documents the dashboard, the login flow, or the hosted deployment beyond a stale config snippet. |
| Dead code | `src/resources/audiences.ts.disabled`, `src/tools/audiences.ts.disabled`, `list-tools.js`, `test-api.js`, `test-tools.js` sitting in the repo root. |

---

## 6. Suggested order of work

**Now (security)**
1. Remove the `JWT_SECRET` fallback; fail closed. Rotate the secret.
2. Purge the committed JWT from `examples/` and rotate.
3. Delete the query-param token, the `localStorage` write, and the cookie/token logging; strip the
   debug payload from the callback error response.
4. Add security headers (CSP, `frame-ancestors`, `Referrer-Policy`, HSTS, `Cache-Control: no-store`)
   and escape all interpolated user data.
5. Encrypt Meta tokens at rest.

**Next (correctness)**
6. Add the `email` scope; make `email` optional end-to-end.
7. Exchange for a long-lived token at callback; persist `tokenExpiration`; make `/refresh` actually refresh.
8. Split logout from revoke.
9. Fix the `vv23.0` URL.

**Then (product)**
10. Implement MCP OAuth discovery + `401 WWW-Authenticate` so the server installs as a one-click
    Claude.ai connector.
11. Rebuild the dashboard around live data: token status, ad accounts, test-connection, rotate/revoke.
12. Unify remote and stdio tool definitions into shared modules; add `get_capabilities` and pagination
    to the remote surface.

**Ongoing (hygiene)**
13. Fix lint and jest; write the first tests (auth flows, session verification, cookie parsing).
14. Type-check `api/`; swap `next` types for `@vercel/node`.
15. Add a CI workflow (build + lint + test + secret scan) and fix the Dockerfile.
