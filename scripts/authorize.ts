/**
 * One-time interactive OAuth setup: `npm run auth`.
 *
 * Opens the Google consent screen in a browser, receives the authorization code
 * on a loopback (127.0.0.1) redirect, and stores the refresh token locally with
 * owner-only permissions. This is a normal CLI, not the MCP server, so it may
 * print to stdout.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';
import { missingScopes, readClientCredentials, saveToken, SCOPES } from '../src/auth.js';
import { loadConfig, loadDotEnv } from '../src/config.js';
import { ToolError } from '../src/errors.js';

const TIMEOUT_MS = 5 * 60_000;

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // The URL is printed as a fallback.
  }
}

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body style="font-family:sans-serif;max-width:40em;margin:4em auto"><h2>${title}</h2><p>${body}</p></body></html>`;
}

const CONSENT_ERRORS: Record<string, string> = {
  access_denied: 'Consent was denied. Run `npm run auth` again and approve both permissions to use the tools.',
  admin_policy_enforced: 'Your Google Workspace administrator blocks this app. Contact your admin; this cannot be bypassed.',
  org_internal: 'This OAuth app is restricted to a different Google Workspace organization.',
};

async function waitForCode(server: Server, state: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for Google authorization (5 minutes).')), TIMEOUT_MS);

    server.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      if (!error && !code) {
        res.writeHead(404).end();
        return;
      }
      if (url.searchParams.get('state') !== state) {
        res.writeHead(400, { 'Content-Type': 'text/html' }).end(page('Authorization failed', 'State mismatch. Close this tab and run npm run auth again.'));
        clearTimeout(timer);
        reject(new Error('OAuth state mismatch; possible CSRF. Aborting.'));
        return;
      }
      if (error) {
        const message = CONSENT_ERRORS[error] ?? `Google returned an error: ${error}`;
        res.writeHead(400, { 'Content-Type': 'text/html' }).end(page('Authorization failed', message));
        clearTimeout(timer);
        reject(new Error(message));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' }).end(page('Authorization complete', 'You can close this tab and return to the terminal.'));
      clearTimeout(timer);
      resolve(code as string);
    });
  });
}

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();
  const creds = await readClientCredentials(config.credentialsPath);

  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const redirectUri = `http://127.0.0.1:${port}`;

  try {
    const client = new OAuth2Client({ clientId: creds.clientId, clientSecret: creds.clientSecret, redirectUri });
    const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
    const state = randomBytes(24).toString('hex');

    const authUrl = client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: [...SCOPES],
      state,
      code_challenge: codeChallenge,
      code_challenge_method: CodeChallengeMethod.S256,
    });

    console.log('Opening your browser to authorize google-workspace-mcp.');
    console.log('Requested permissions: send email as you (gmail.send) and edit your Google Docs (documents).');
    console.log(`\nIf the browser does not open, visit this URL:\n\n${authUrl}\n`);
    openBrowser(authUrl);

    const code = await waitForCode(server, state);
    const { tokens } = await client.getToken({ code, codeVerifier, redirect_uri: redirectUri });

    if (!tokens.refresh_token) {
      throw new Error(
        'Google did not return a refresh token. Remove this app at https://myaccount.google.com/permissions and run `npm run auth` again.',
      );
    }
    const scope = tokens.scope ?? '';
    const missing = missingScopes(scope);
    if (missing.length > 0) {
      throw new Error(`Not all permissions were granted (missing: ${missing.join(', ')}). Run \`npm run auth\` again and check both boxes.`);
    }

    await saveToken(config.tokenPath, {
      type: 'authorized_user',
      client_id: creds.clientId,
      refresh_token: tokens.refresh_token,
      scope,
      created_at: new Date().toISOString(),
    });

    console.log(`Authorization saved to ${config.tokenPath} (permissions 0600).`);
    console.log('You can now build and start the MCP server: npm run build && npm start');
  } finally {
    server.close();
  }
}

main().catch((err: unknown) => {
  const message = err instanceof ToolError ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : String(err);
  console.error(`\nAuthorization failed: ${message}`);
  process.exit(1);
});
