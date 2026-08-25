import type { VercelRequest, VercelResponse } from "@vercel/node";
import { ACCESS_GATE_COOKIE, hasGateAccess, isPinConfigured } from "../src/utils/access-pin.js";
import { authenticateRequest } from "../src/utils/session-request.js";
import { getCookie, sendHtml } from "../src/utils/http.js";

const STYLES = `
  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    line-height: 1.6;
    color: #2d3748;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1.5rem;
  }

  main {
    background: white;
    border-radius: 12px;
    box-shadow: 0 20px 40px rgba(0,0,0,0.12);
    padding: 2rem;
    max-width: 520px;
    width: 100%;
    text-align: center;
  }

  .logo {
    width: 56px; height: 56px;
    background: linear-gradient(45deg, #1877f2, #42a5f5);
    border-radius: 12px;
    margin: 0 auto 1rem;
    display: flex; align-items: center; justify-content: center;
    color: white; font-size: 22px; font-weight: bold;
  }

  h1 { color: #1a202c; margin-bottom: 0.5rem; font-size: 1.6rem; }
  .subtitle { color: #718096; margin-bottom: 1.75rem; font-size: 0.95rem; }

  .panel {
    text-align: left;
    background: #f7fafc;
    border: 1px solid #e2e8f0;
    padding: 1.25rem;
    border-radius: 8px;
    margin-bottom: 1.5rem;
  }
  .panel h2 { font-size: 1rem; color: #2d3748; margin-bottom: 0.75rem; }
  .panel ul { list-style: none; }
  .panel li { padding: 0.3rem 0; color: #4a5568; font-size: 0.9rem; display: flex; gap: 0.5rem; }
  .panel li::before { content: "✓"; color: #38a169; font-weight: bold; }

  label { display: block; text-align: left; font-size: 0.85rem; color: #4a5568; margin-bottom: 0.4rem; font-weight: 500; }

  input[type="password"] {
    width: 100%;
    padding: 12px 14px;
    font-size: 1.4rem;
    letter-spacing: 0.4em;
    text-align: center;
    border: 1px solid #cbd5e0;
    border-radius: 8px;
    font-family: 'Monaco', 'Menlo', monospace;
    color: #1a202c;
    background: #fff;
  }
  input[type="password"]:focus { outline: 3px solid #90cdf4; outline-offset: 1px; border-color: #4299e1; }

  button {
    background: #1877f2; color: white; border: none;
    padding: 12px 24px; border-radius: 8px; font-size: 1rem;
    cursor: pointer; transition: background 0.15s; width: 100%; margin-top: 1rem;
    font-family: inherit;
  }
  button:hover:not(:disabled) { background: #166fe5; }
  button:disabled { background: #a0aec0; cursor: not-allowed; }
  button:focus-visible { outline: 3px solid #90cdf4; outline-offset: 2px; }

  .status { min-height: 1.4rem; margin-top: 0.9rem; font-size: 0.88rem; }
  .status.error { color: #c53030; }
  .status.info { color: #4a5568; }

  .note {
    background: #f0fff4; border: 1px solid #9ae6b4; border-radius: 6px;
    padding: 0.9rem; margin-top: 1.5rem; text-align: left;
    font-size: 0.83rem; color: #276749;
  }

  footer {
    margin-top: 1.75rem; padding-top: 1rem; border-top: 1px solid #e2e8f0;
    color: #a0aec0; font-size: 0.78rem;
  }
`;

function page(body: string, script: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="description" content="Private Meta Ads MCP server for connecting Meta Marketing API to MCP clients.">
<title>Meta Ads MCP Server</title>
<style>${STYLES}</style>
</head>
<body>
<main>
  <div class="logo" aria-hidden="true">M</div>
  ${body}
  <footer>
    <p>Compatible with Claude Desktop, Claude Code, Cursor and other MCP clients</p>
  </footer>
</main>
<script>${script}</script>
</body>
</html>`;
}

const PIN_BODY = `
  <h1>Enter access PIN</h1>
  <p class="subtitle">This server is private. Enter the team PIN to continue.</p>

  <form id="pin-form" autocomplete="off">
    <label for="pin">Access PIN</label>
    <input id="pin" name="pin" type="password" inputmode="numeric" autocomplete="one-time-code"
           required aria-describedby="pin-status">
    <button type="submit" id="pin-submit">Unlock</button>
  </form>

  <p class="status" id="pin-status" role="status" aria-live="polite"></p>
`;

const PIN_SCRIPT = `
  const form = document.getElementById('pin-form');
  const input = document.getElementById('pin');
  const submit = document.getElementById('pin-submit');
  const status = document.getElementById('pin-status');

  input.focus();

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    submit.disabled = true;
    status.className = 'status info';
    status.textContent = 'Checking…';

    try {
      const response = await fetch('/api/auth/pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: input.value })
      });
      const data = await response.json();

      if (data.success) {
        status.textContent = 'Unlocked. Loading…';
        window.location.reload();
        return;
      }

      status.className = 'status error';
      status.textContent = data.error || 'That PIN is not correct.';
    } catch {
      status.className = 'status error';
      status.textContent = 'Could not reach the server. Check your connection and try again.';
    }

    submit.disabled = false;
    input.value = '';
    input.focus();
  });
`;

const CONNECT_BODY = `
  <h1>Meta Ads MCP Server</h1>
  <p class="subtitle">Connect your Meta account to manage campaigns, audiences and reporting from your MCP client.</p>

  <div class="panel">
    <h2>What you get after connecting</h2>
    <ul>
      <li>Campaign management and analytics</li>
      <li>Audience creation and targeting</li>
      <li>Creative testing and optimisation</li>
      <li>Performance insights and exports</li>
      <li>A ready-to-paste MCP client configuration</li>
    </ul>
  </div>

  <button type="button" id="connect">Connect your Meta account</button>
  <p class="status" id="connect-status" role="status" aria-live="polite"></p>

  <div class="note">
    <strong>Your account, your tokens.</strong> Each person connects their own Meta account.
    Tokens are encrypted at rest and can be revoked from the dashboard at any time.
  </div>
`;

const CONNECT_SCRIPT = `
  const connect = document.getElementById('connect');
  const status = document.getElementById('connect-status');

  connect.addEventListener('click', async () => {
    connect.disabled = true;
    status.className = 'status info';
    status.textContent = 'Redirecting to Meta…';

    try {
      const response = await fetch('/api/auth/login');
      const data = await response.json();

      if (data.success && data.authUrl) {
        window.location.href = data.authUrl;
        return;
      }

      status.className = 'status error';
      status.textContent = data.message || data.error || 'Could not start the Meta login.';
    } catch {
      status.className = 'status error';
      status.textContent = 'Could not reach the server. Check your connection and try again.';
    }

    connect.disabled = false;
  });
`;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return sendHtml(res, 405, page("<h1>Method not allowed</h1>", ""));
  }

  const gated = isPinConfigured();

  let unlocked: boolean;
  try {
    unlocked = await hasGateAccess(getCookie(req, ACCESS_GATE_COOKIE));
  } catch (error) {
    console.error("Access gate check failed:", {
      reason: error instanceof Error ? error.message : "unknown",
    });
    return sendHtml(
      res,
      500,
      page(
        `<h1>Server not configured</h1>
         <p class="subtitle">This deployment is missing required configuration. Set JWT_SECRET, then redeploy.</p>`,
        ""
      )
    );
  }

  if (gated && !unlocked) {
    return sendHtml(res, 200, page(PIN_BODY, PIN_SCRIPT));
  }

  // Already signed in - skip straight to the dashboard.
  try {
    const { session } = await authenticateRequest(req);
    if (session) {
      return res.redirect(302, "/dashboard");
    }
  } catch (error) {
    console.error("Session check failed on landing page:", {
      reason: error instanceof Error ? error.message : "unknown",
    });
  }

  return sendHtml(res, 200, page(CONNECT_BODY, CONNECT_SCRIPT));
}
