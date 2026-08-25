import type { VercelRequest, VercelResponse } from "@vercel/node";
import { UserAuthManager } from "../src/utils/user-auth.js";
import { ACCESS_GATE_COOKIE, hasGateAccess } from "../src/utils/access-pin.js";
import { authenticateRequest } from "../src/utils/session-request.js";
import { escapeHtml, getCookie, sendHtml } from "../src/utils/http.js";

interface TokenStatus {
  hasToken: boolean;
  isValid: boolean;
  expiresAt?: string;
  scopes: string[];
}

function formatExpiry(expiresAt?: string): string {
  if (!expiresAt) return "No expiry reported";

  const expires = new Date(expiresAt);
  if (Number.isNaN(expires.getTime())) return "Unknown";

  const days = Math.round((expires.getTime() - Date.now()) / (24 * 60 * 60 * 1000));

  if (days < 0) return "Expired";
  if (days === 0) return "Expires today";
  if (days === 1) return "Expires tomorrow";
  return `Expires in ${days} days`;
}

function metaStatus(status: TokenStatus | null): { tone: string; label: string } {
  if (!status?.hasToken) return { tone: "bad", label: "No Meta token stored" };
  if (!status.isValid) return { tone: "bad", label: "Meta token invalid — reconnect" };
  return { tone: "good", label: `Meta connected · ${formatExpiry(status.expiresAt)}` };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return sendHtml(res, 405, "<h1>Method not allowed</h1>");
  }

  try {
    if (!(await hasGateAccess(getCookie(req, ACCESS_GATE_COOKIE)))) {
      return res.redirect(302, "/");
    }

    const { session, sessionToken } = await authenticateRequest(req);

    if (!session || !sessionToken) {
      return res.redirect(302, "/");
    }

    const tokenStatus = await UserAuthManager.getTokenStatus(session.userId).catch((error) => {
      console.error("Token status lookup failed:", {
        reason: error instanceof Error ? error.message : "unknown",
      });
      return null;
    });

    const host = req.headers.host ?? "";
    const mcpEndpoint = `https://${host}/api/mcp`;
    const meta = metaStatus(tokenStatus);
    const firstName = (session.name || "there").split(" ")[0];

    const clientConfig = JSON.stringify(
      {
        mcpServers: {
          "meta-ads": {
            command: "npx",
            args: ["-y", "mcp-remote", mcpEndpoint, "--header", "Authorization:${META_AUTH_HEADER}"],
            env: { META_AUTH_HEADER: `Bearer ${sessionToken}` },
          },
        },
      },
      null,
      2
    );

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow">
<title>Dashboard · Meta Ads MCP Server</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    line-height: 1.6; color: #2d3748; background: #f7fafc; min-height: 100vh;
  }

  header {
    background: white; border-bottom: 1px solid #e2e8f0; padding: 1rem 0;
  }
  .header-inner {
    max-width: 1100px; margin: 0 auto; padding: 0 2rem;
    display: flex; justify-content: space-between; align-items: center; gap: 1rem; flex-wrap: wrap;
  }
  .brand { display: flex; align-items: center; gap: 0.6rem; font-weight: 600; color: #1a202c; }
  .brand-mark {
    width: 30px; height: 30px; border-radius: 6px; color: white; font-size: 13px; font-weight: bold;
    background: linear-gradient(45deg, #1877f2, #42a5f5);
    display: flex; align-items: center; justify-content: center;
  }
  .who { text-align: right; font-size: 0.85rem; }
  .who .name { font-weight: 500; color: #1a202c; }
  .who .email { color: #718096; font-size: 0.78rem; }

  main { max-width: 1100px; margin: 0 auto; padding: 2rem; }

  .welcome {
    background: white; border-radius: 12px; padding: 1.75rem;
    box-shadow: 0 1px 3px rgba(0,0,0,0.08); margin-bottom: 1.5rem;
  }
  .welcome h1 { font-size: 1.5rem; color: #1a202c; margin-bottom: 0.35rem; }
  .welcome p { color: #718096; margin-bottom: 1.25rem; }

  .pills { display: flex; gap: 0.6rem; flex-wrap: wrap; }
  .pill {
    border-radius: 999px; padding: 0.35rem 0.85rem; font-size: 0.8rem;
    border: 1px solid transparent; font-weight: 500;
  }
  .pill.good { background: #f0fff4; border-color: #9ae6b4; color: #22543d; }
  .pill.bad  { background: #fff5f5; border-color: #feb2b2; color: #742a2a; }
  .pill.info { background: #ebf8ff; border-color: #90cdf4; color: #2a4365; }

  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 1.5rem; margin-bottom: 1.5rem; }

  .card {
    background: white; border-radius: 12px; padding: 1.5rem; box-shadow: 0 1px 3px rgba(0,0,0,0.08);
  }
  .card h2 { font-size: 1.05rem; color: #1a202c; margin-bottom: 0.75rem; }
  .card p { font-size: 0.9rem; color: #4a5568; margin-bottom: 0.75rem; }

  .code-block { position: relative; margin: 0.75rem 0 1rem; }
  .code-block pre {
    background: #1a202c; color: #9ae6b4; padding: 1rem; padding-right: 4.5rem; border-radius: 6px;
    font-family: 'Monaco', 'Menlo', monospace; font-size: 0.78rem; line-height: 1.5;
    overflow-x: auto; white-space: pre; margin: 0;
  }
  .code-block pre.wrap { white-space: pre-wrap; word-break: break-all; }

  .copy {
    position: absolute; top: 0.5rem; right: 0.5rem;
    background: #4a5568; color: white; border: none; padding: 5px 10px;
    border-radius: 4px; font-size: 0.72rem; cursor: pointer; font-family: inherit;
  }
  .copy:hover { background: #2d3748; }
  .copy:focus-visible { outline: 2px solid #90cdf4; outline-offset: 2px; }

  .scopes { font-size: 0.78rem; color: #718096; font-family: 'Monaco', 'Menlo', monospace; word-break: break-word; }

  .actions { display: flex; flex-wrap: wrap; gap: 0.6rem; margin-top: 0.5rem; }
  .btn {
    border: 1px solid #cbd5e0; background: white; color: #2d3748;
    padding: 8px 14px; border-radius: 6px; font-size: 0.85rem; cursor: pointer; font-family: inherit;
  }
  .btn:hover:not(:disabled) { background: #f7fafc; }
  .btn:disabled { opacity: 0.55; cursor: not-allowed; }
  .btn:focus-visible { outline: 2px solid #90cdf4; outline-offset: 2px; }
  .btn.danger { border-color: #feb2b2; color: #c53030; }
  .btn.danger:hover:not(:disabled) { background: #fff5f5; }

  .status { min-height: 1.3rem; font-size: 0.85rem; margin-top: 0.75rem; }
  .status.ok { color: #276749; }
  .status.error { color: #c53030; }
  .status.info { color: #4a5568; }

  .steps { counter-reset: step; list-style: none; }
  .steps li { counter-increment: step; padding-left: 2.25rem; position: relative; margin-bottom: 1.1rem; }
  .steps li::before {
    content: counter(step); position: absolute; left: 0; top: 0.1rem;
    width: 1.5rem; height: 1.5rem; border-radius: 50%; background: #4299e1; color: white;
    display: flex; align-items: center; justify-content: center; font-size: 0.78rem; font-weight: bold;
  }
  .steps h3 { font-size: 0.95rem; color: #2d3748; margin-bottom: 0.2rem; }
  .steps p { font-size: 0.88rem; color: #4a5568; margin: 0; }

  code { font-family: 'Monaco', 'Menlo', monospace; background: #edf2f7; padding: 1px 5px; border-radius: 3px; font-size: 0.85em; }

  @media (max-width: 640px) {
    .header-inner, main { padding-left: 1rem; padding-right: 1rem; }
    .who { text-align: left; }
  }
</style>
</head>
<body>
  <header>
    <div class="header-inner">
      <div class="brand"><span class="brand-mark" aria-hidden="true">M</span> Meta Ads MCP Server</div>
      <div class="who">
        <div class="name">${escapeHtml(session.name)}</div>
        ${session.email ? `<div class="email">${escapeHtml(session.email)}</div>` : ""}
      </div>
    </div>
  </header>

  <main>
    <section class="welcome">
      <h1>Welcome, ${escapeHtml(firstName)}</h1>
      <p>Your Meta Ads MCP server is ready. Connect an MCP client to manage campaigns, review performance and automate reporting.</p>
      <div class="pills">
        <span class="pill good">Signed in</span>
        <span class="pill ${meta.tone}">${escapeHtml(meta.label)}</span>
        <span class="pill info">Session token valid 7 days</span>
      </div>
      ${
        tokenStatus?.scopes.length
          ? `<p class="scopes" style="margin-top:0.9rem;">Granted scopes: ${escapeHtml(
              tokenStatus.scopes.join(", ")
            )}</p>`
          : ""
      }
    </section>

    <div class="grid">
      <section class="card">
        <h2>Your MCP endpoint</h2>
        <p>Point your MCP client at this URL, authenticating with a bearer token.</p>
        <div class="code-block">
          <pre class="wrap" id="endpoint">${escapeHtml(mcpEndpoint)}</pre>
          <button class="copy" type="button" data-copy="endpoint">Copy</button>
        </div>
        <p>Keep the token below private — anyone holding it can spend from your ad accounts.</p>
      </section>

      <section class="card">
        <h2>Client configuration</h2>
        <p>Add this to Claude Desktop, Claude Code or any <code>mcp-remote</code> compatible client.</p>
        <div class="code-block">
          <pre id="config">${escapeHtml(clientConfig)}</pre>
          <button class="copy" type="button" data-copy="config">Copy</button>
        </div>
      </section>
    </div>

    <section class="card" style="margin-bottom:1.5rem;">
      <h2>Manage access</h2>
      <p>Rotate the token if it has been shared by mistake, refresh the Meta connection when it nears expiry, or disconnect entirely.</p>
      <div class="actions">
        <button class="btn" type="button" id="refresh">Refresh Meta token</button>
        <button class="btn" type="button" id="rotate">Rotate session token</button>
        <button class="btn" type="button" id="logout">Sign out</button>
        <button class="btn danger" type="button" id="revoke">Disconnect Meta</button>
      </div>
      <p class="status" id="action-status" role="status" aria-live="polite"></p>
    </section>

    <section class="card">
      <h2>Setup</h2>
      <ol class="steps">
        <li>
          <h3>Copy the configuration</h3>
          <p>Paste it into your client's MCP settings and restart the client.</p>
        </li>
        <li>
          <h3>Test the connection</h3>
          <p>Run the <code>health_check</code> tool. It reports your account details and confirms authentication.</p>
        </li>
        <li>
          <h3>List your ad accounts</h3>
          <p>Run <code>get_ad_accounts</code> to see every account this connection can reach.</p>
        </li>
        <li>
          <h3>Rotate when needed</h3>
          <p>Session tokens last seven days. Rotate immediately if a token is ever pasted somewhere public.</p>
        </li>
      </ol>
    </section>
  </main>

<script>
  const status = document.getElementById('action-status');

  function setStatus(kind, message) {
    status.className = 'status ' + kind;
    status.textContent = message;
  }

  async function copyText(text, button) {
    const original = button.textContent;

    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        document.execCommand('copy');
        document.body.removeChild(area);
      }
      button.textContent = 'Copied';
    } catch {
      button.textContent = 'Press Ctrl+C';
    }

    setTimeout(() => { button.textContent = original; }, 2000);
  }

  document.querySelectorAll('.copy').forEach((button) => {
    button.addEventListener('click', () => {
      const source = document.getElementById(button.dataset.copy);
      copyText(source.textContent, button);
    });
  });

  async function post(path) {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin'
    });
    return { ok: response.ok, data: await response.json().catch(() => ({})) };
  }

  function wire(id, path, pending, confirmMessage, onSuccess) {
    const button = document.getElementById(id);

    button.addEventListener('click', async () => {
      if (confirmMessage && !window.confirm(confirmMessage)) return;

      button.disabled = true;
      setStatus('info', pending);

      try {
        const { ok, data } = await post(path);

        if (ok && data.success) {
          setStatus('ok', data.message || 'Done.');
          if (onSuccess) onSuccess(data);
        } else {
          setStatus('error', data.message || data.error || 'That did not work.');
        }
      } catch {
        setStatus('error', 'Could not reach the server. Check your connection and try again.');
      }

      button.disabled = false;
    });
  }

  wire('refresh', '/api/auth/refresh', 'Refreshing the Meta token…', null,
    () => setTimeout(() => window.location.reload(), 1200));

  wire('rotate', '/api/auth/rotate', 'Issuing a new token…',
    'Rotating revokes the current token. Any MCP client using it stops working until you paste the new configuration. Continue?',
    () => setTimeout(() => window.location.reload(), 1600));

  wire('logout', '/api/auth/logout', 'Signing out…', null,
    () => setTimeout(() => { window.location.href = '/'; }, 700));

  wire('revoke', '/api/auth/revoke', 'Disconnecting Meta…',
    'This revokes this app\\'s Meta permissions and deletes your stored tokens. Every MCP client you configured stops working. Continue?',
    () => setTimeout(() => { window.location.href = '/'; }, 1200));
</script>
</body>
</html>`;

    return sendHtml(res, 200, html);
  } catch (error) {
    console.error("Dashboard error:", {
      reason: error instanceof Error ? error.message : "unknown",
    });
    return res.redirect(302, "/");
  }
}
